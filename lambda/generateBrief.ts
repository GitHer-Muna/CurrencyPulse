import { InvokeModelCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Handler } from 'aws-lambda';

const DEFAULT_CURRENCIES = ['NPR', 'INR', 'EUR', 'GBP', 'AUD'];
const RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const HISTORY_KEY = 'data/history.json';
const INDEX_KEY = 'index.html';
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

export interface HistoryEntry {
  date: string;
  rates: Record<string, number>;
  headline: string;
  insight: string;
  mostNotableCurrency: string;
}

export interface Brief {
  headline: string;
  insight: string;
  mostNotableCurrency: string;
}

export interface Comparison {
  changePercent: number;
  direction: 'up' | 'down' | 'flat';
}

interface RatesResponse {
  result?: string;
  rates?: Record<string, number>;
}

interface NovaResponse {
  output?: {
    message?: {
      content?: Array<{ text?: string }>;
    };
  };
}

const getRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const getTrackedCurrencies = (value = process.env.TRACKED_CURRENCIES): string[] => {
  const currencies = (value ?? DEFAULT_CURRENCIES.join(','))
    .split(',')
    .map((currency) => currency.trim().toUpperCase())
    .filter(Boolean);

  return [...new Set(currencies.length > 0 ? currencies : DEFAULT_CURRENCIES)];
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export const fetchRates = async (trackedCurrencies: string[]): Promise<Record<string, number>> => {
  try {
    console.log(`Fetching exchange rates from ${RATES_URL}`);
    const response = await fetch(RATES_URL);
    if (!response.ok) {
      throw new Error(`Rates API returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as RatesResponse;
    if (payload.result !== 'success' || !payload.rates) {
      throw new Error(`Rates API returned an unsuccessful response: ${JSON.stringify(payload)}`);
    }

    const rates: Record<string, number> = {};
    for (const currency of trackedCurrencies) {
      const rate = payload.rates[currency];
      if (typeof rate !== 'number' || !Number.isFinite(rate)) {
        throw new Error(`Rates API did not return a valid rate for ${currency}`);
      }
      rates[currency] = rate;
    }

    return rates;
  } catch (error) {
    console.error('Currency rates fetch failed:', errorMessage(error));
    throw error;
  }
};

const readHistory = async (bucket: string): Promise<HistoryEntry[]> => {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: HISTORY_KEY }),
    );
    const body = await response.Body?.transformToString();
    if (!body) return [];

    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) {
      throw new Error(`${HISTORY_KEY} must contain a JSON array`);
    }
    return parsed as HistoryEntry[];
  } catch (error) {
    if (
      error instanceof NoSuchKey ||
      (error && typeof error === 'object' &&
        ('$metadata' in error &&
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404))
    ) {
      console.log(`No existing ${HISTORY_KEY}; starting history.`);
      return [];
    }
    console.error(`Unable to read ${HISTORY_KEY} from S3:`, errorMessage(error));
    throw error;
  }
};

export const findPreviousEntry = (
  history: HistoryEntry[],
  today: string,
): HistoryEntry | undefined =>
  history
    .filter((entry) => typeof entry.date === 'string' && entry.date < today)
    .sort((a, b) => b.date.localeCompare(a.date))[0];

export const calculateComparisons = (
  todayRates: Record<string, number>,
  previous?: HistoryEntry,
): Record<string, Comparison> => {
  if (!previous) return {};

  const comparisons: Record<string, Comparison> = {};
  for (const [currency, todayRate] of Object.entries(todayRates)) {
    const previousRate = previous.rates?.[currency];
    if (typeof previousRate !== 'number' || !Number.isFinite(previousRate) || previousRate === 0) {
      continue;
    }

    const changePercent = ((todayRate - previousRate) / previousRate) * 100;
    comparisons[currency] = {
      changePercent,
      direction: changePercent > 0.005 ? 'up' : changePercent < -0.005 ? 'down' : 'flat',
    };
  }
  return comparisons;
};

const buildPrompt = (
  rates: Record<string, number>,
  comparisons: Record<string, Comparison>,
  previousDate?: string,
): string => {
  const comparisonData = Object.fromEntries(
    Object.entries(comparisons).map(([currency, comparison]) => [
      currency,
      Number(comparison.changePercent.toFixed(4)),
    ]),
  );

  return `You are writing today's CurrencyPulse brief for a person who sends money, travels, studies abroad, or buys imported goods. Write like a knowledgeable person explaining the move to a friend, not like a financial disclaimer or press release. Use short, direct sentences. Do not use hedging phrases such as "it is important to note that."

Return ONLY valid JSON, with no markdown fences and no preamble, in exactly this shape:
{"headline":"one short punchy headline naming the most notable move today","insight":"3-5 sentences in plain, direct English explaining what moved and why it practically matters. Mention actual numbers. Explain implications such as cheaper or costlier remittances, a better or worse time to convert for travel or tuition, or import cost impact. No filler and no generic disclaimers.","mostNotableCurrency":"the currency code that moved the most"}

Today's USD-based rates: ${JSON.stringify(rates)}
Percentage changes versus ${previousDate ?? 'the previous day (not available on the first run)'}: ${JSON.stringify(comparisonData)}
If there is no comparison data, describe today's rates without inventing a day-over-day move. Choose mostNotableCurrency from the supplied currency codes.`;
};

const stripMarkdownFences = (value: string): string => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
};

export const parseBriefResponse = (value: string, trackedCurrencies: string[]): Brief => {
  const cleaned = stripMarkdownFences(value);
  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
  } catch (firstError) {
    try {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start < 0 || end <= start) throw firstError;
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (error) {
      console.error('Bedrock returned invalid JSON:', errorMessage(error));
      console.error('Raw Bedrock text:', value);
      throw new Error('Bedrock response was not valid JSON');
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Bedrock JSON response was not an object');
  }

  const candidate = parsed as Partial<Brief>;
  if (
    typeof candidate.headline !== 'string' ||
    typeof candidate.insight !== 'string' ||
    typeof candidate.mostNotableCurrency !== 'string'
  ) {
    throw new Error('Bedrock JSON response did not contain the required brief fields');
  }

  const mostNotableCurrency = candidate.mostNotableCurrency.toUpperCase();
  if (!trackedCurrencies.includes(mostNotableCurrency)) {
    console.warn(`Bedrock selected unsupported currency ${mostNotableCurrency}; using ${trackedCurrencies[0]}`);
  }

  return {
    headline: candidate.headline.trim(),
    insight: candidate.insight.trim(),
    mostNotableCurrency: trackedCurrencies.includes(mostNotableCurrency)
      ? mostNotableCurrency
      : trackedCurrencies[0],
  };
};

export const generateBrief = async (
  rates: Record<string, number>,
  comparisons: Record<string, Comparison>,
  previousDate: string | undefined,
  trackedCurrencies: string[],
  modelId: string,
): Promise<Brief> => {
  const prompt = buildPrompt(rates, comparisons, previousDate);
  try {
    console.log(`Invoking Bedrock model ${modelId}`);
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            schemaVersion: 'messages-v1',
            messages: [{ role: 'user', content: [{ text: prompt }] }],
            inferenceConfig: { maxTokens: 350, temperature: 0.2 },
          }),
        ),
      }),
    );

    if (!response.body) throw new Error('Bedrock response had no body');
    const modelResponse = JSON.parse(new TextDecoder().decode(response.body)) as NovaResponse;
    const text = modelResponse.output?.message?.content
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('Bedrock response contained no text');

    return parseBriefResponse(text, trackedCurrencies);
  } catch (error) {
    console.error('Bedrock brief generation failed:', errorMessage(error));
    throw error;
  }
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character,
  );

const formatRate = (rate: number): string =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(rate);

export const renderIndex = (
  today: HistoryEntry,
  history: HistoryEntry[],
  comparisons: Record<string, Comparison>,
  trackedCurrencies: string[],
): string => {
  const rows = trackedCurrencies
    .map((currency) => {
      const comparison = comparisons[currency];
      const change = comparison
        ? `<span class="change ${comparison.direction}">${comparison.direction === 'up' ? '▲' : comparison.direction === 'down' ? '▼' : '•'} ${comparison.changePercent >= 0 ? '+' : ''}${comparison.changePercent.toFixed(2)}%</span>`
        : '<span class="muted">No prior comparison</span>';
      return `<tr><th scope="row">${escapeHtml(currency)}</th><td>${formatRate(today.rates[currency])}</td><td>${change}</td></tr>`;
    })
    .join('');

  const historyRows = history
    .filter((entry) => entry.date < today.date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 14)
    .map((entry) => `<li><time datetime="${escapeHtml(entry.date)}">${escapeHtml(entry.date)}</time><span>${escapeHtml(entry.headline)}</span></li>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CurrencyPulse — ${escapeHtml(today.date)}</title>
<style>
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; background: #f4f7fb; color: #172033; }
* { box-sizing: border-box; }
body { margin: 0; }
main { width: min(760px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
.eyebrow { color: #5470a5; font-size: .78rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1 { font-size: clamp(2rem, 7vw, 3.4rem); line-height: 1.05; margin: 10px 0 18px; letter-spacing: -.04em; }
.lead { background: #172033; border-radius: 18px; color: #fff; padding: clamp(24px, 5vw, 40px); box-shadow: 0 14px 40px #1720331f; }
.lead .eyebrow { color: #9db9ef; }
.insight { color: #dce5f5; font-size: 1.08rem; line-height: 1.65; max-width: 62ch; }
section { background: #fff; border: 1px solid #e1e7f0; border-radius: 14px; margin-top: 20px; padding: 22px; }
h2 { font-size: 1.1rem; margin: 0 0 14px; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #edf0f5; padding: 13px 4px; text-align: left; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
td { color: #263c65; font-variant-numeric: tabular-nums; }
.change { font-size: .88rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.up { color: #16845b; } .down { color: #bd4545; } .flat, .muted { color: #748097; }
ul { list-style: none; margin: 0; padding: 0; }
li { align-items: baseline; border-bottom: 1px solid #edf0f5; display: flex; gap: 16px; padding: 10px 0; }
li:last-child { border-bottom: 0; } time { color: #748097; flex: 0 0 96px; font-size: .85rem; font-variant-numeric: tabular-nums; }
@media (max-width: 520px) { main { padding: 24px 0 36px; } section { padding: 18px; } li { display: block; } li span { display: block; margin-top: 3px; } }
</style>
</head>
<body><main>
<article class="lead"><div class="eyebrow">CurrencyPulse · ${escapeHtml(today.date)}</div><h1>${escapeHtml(today.headline)}</h1><p class="insight">${escapeHtml(today.insight)}</p></article>
<section><h2>Today’s rates · 1 USD</h2><table><thead><tr><th scope="col">Currency</th><th scope="col">Rate</th><th scope="col">Daily move</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><h2>Recent briefs</h2><ul>${historyRows || '<li><span class="muted">This is the first brief.</span></li>'}</ul></section>
</main></body></html>`;
};

const putObject = async (bucket: string, key: string, body: string, contentType: string): Promise<void> => {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: key === INDEX_KEY ? 'no-cache' : 'no-store',
  }));
};

export const handler: Handler = async () => {
  const bucket = getRequiredEnv('BUCKET_NAME');
  const modelId = getRequiredEnv('BEDROCK_MODEL_ID');
  const trackedCurrencies = getTrackedCurrencies();
  const today = new Date().toISOString().slice(0, 10);

  // Fetch rates before touching S3 so a failed external rates call cannot publish a broken page.
  let todayRates: Record<string, number>;
  try {
    todayRates = await fetchRates(trackedCurrencies);
  } catch (error) {
    console.error('generateBrief stopped before publishing because rates were unavailable:', errorMessage(error));
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'Currency rates were unavailable; no page was published.' }),
    };
  }
  const history = await readHistory(bucket);
  const previous = findPreviousEntry(history, today);
  const comparisons = calculateComparisons(todayRates, previous);
  const brief = await generateBrief(
    todayRates,
    comparisons,
    previous?.date,
    trackedCurrencies,
    modelId,
  );

  const todayEntry: HistoryEntry = {
    date: today,
    rates: todayRates,
    headline: brief.headline,
    insight: brief.insight,
    mostNotableCurrency: brief.mostNotableCurrency,
  };
  const updatedHistory = [...history, todayEntry].slice(-60);

  await putObject(bucket, HISTORY_KEY, JSON.stringify(updatedHistory, null, 2), 'application/json');
  await putObject(
    bucket,
    INDEX_KEY,
    renderIndex(todayEntry, updatedHistory, comparisons, trackedCurrencies),
    'text/html; charset=utf-8',
  );
  console.log(`Published ${INDEX_KEY} and ${HISTORY_KEY} for ${today}`);

  return { statusCode: 200, body: JSON.stringify({ date: today, trackedCurrencies }) };
};
