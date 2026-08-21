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
  generatedAt?: string;
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

const formatGeneratedAt = (value: string | undefined, fallbackDate: string): string => {
  if (!value) return `${fallbackDate} · scheduled run at 08:00 NPT`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return `${fallbackDate} · scheduled run at 08:00 NPT`;
  return `${new Intl.DateTimeFormat('en-NP', {
    timeZone: 'Asia/Kathmandu',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed)} NPT`;
};

export const renderIndex = (
  today: HistoryEntry,
  history: HistoryEntry[],
  comparisons: Record<string, Comparison>,
  trackedCurrencies: string[],
): string => {
  const previousDate = history
    .filter((entry) => entry.date < today.date)
    .sort((a, b) => b.date.localeCompare(a.date))[0]?.date;
  const comparisonLabel = previousDate ? `Compared with ${previousDate}` : 'First run · comparison starts tomorrow';
  const generatedAt = today.generatedAt ?? `${today.date}T02:15:00.000Z`;
  const generatedAtLabel = formatGeneratedAt(today.generatedAt, today.date);
  const notableComparison = comparisons[today.mostNotableCurrency];
  const notableMove = notableComparison
    ? `${notableComparison.changePercent >= 0 ? '+' : ''}${notableComparison.changePercent.toFixed(2)}% since last run`
    : 'Waiting for the first comparison';

  const rows = trackedCurrencies
    .map((currency) => {
      const comparison = comparisons[currency];
      const change = comparison
        ? `<span class="change ${comparison.direction}"><span class="trend-icon">${comparison.direction === 'up' ? '▲' : comparison.direction === 'down' ? '▼' : '•'}</span> ${comparison.changePercent >= 0 ? '+' : ''}${comparison.changePercent.toFixed(2)}%</span>`
        : '<span class="muted">First reading</span>';
      const notable = today.mostNotableCurrency === currency ? '<span class="notable-pill">Notable</span>' : '';
      return `<tr><th scope="row"><span class="currency-code">${escapeHtml(currency)}</span>${notable}</th><td class="rate-value">${formatRate(today.rates[currency])}</td><td>${change}</td></tr>`;
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
<meta name="description" content="An automated daily exchange-rate brief for USD, NPR, INR, EUR, GBP, and AUD.">
<title>CurrencyPulse · Daily exchange brief</title>
<style>
:root { color-scheme: light; --ink: #12233f; --ink-soft: #52627d; --muted: #7b8aa3; --line: #e4eaf3; --paper: #f5f8fc; --card: #fff; --blue: #2864d7; --blue-soft: #eaf1ff; --green: #15805d; --red: #c84952; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--paper); color: var(--ink); }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
a { color: inherit; text-decoration: none; }
.page-shell { width: min(1080px, calc(100% - 40px)); margin: 0 auto; padding: 28px 0 44px; }
.site-header { align-items: center; display: flex; justify-content: space-between; margin-bottom: 30px; }
.brand { align-items: center; display: flex; font-size: 1.02rem; font-weight: 800; gap: 10px; letter-spacing: -.02em; }
.brand-mark { align-items: center; background: var(--blue); border-radius: 9px; color: #fff; display: inline-flex; font-size: .72rem; height: 30px; justify-content: center; letter-spacing: -.08em; width: 30px; }
.header-status, .live-label { align-items: center; color: var(--muted); display: flex; font-size: .7rem; font-weight: 800; gap: 7px; letter-spacing: .12em; text-transform: uppercase; }
.live-dot { background: #23af77; border-radius: 50%; box-shadow: 0 0 0 4px #23af771c; height: 7px; width: 7px; }
.hero { background: radial-gradient(circle at 90% 10%, #3d78e633, transparent 35%), linear-gradient(135deg, #12233f 0%, #1b3764 100%); border-radius: 24px; box-shadow: 0 18px 45px #17325b26; color: #fff; overflow: hidden; padding: clamp(28px, 5vw, 52px); position: relative; }
.hero::after { border: 1px solid #ffffff1c; border-radius: 50%; content: ""; height: 250px; position: absolute; right: -95px; top: -110px; width: 250px; }
.hero-kicker { align-items: center; display: flex; gap: 12px; position: relative; z-index: 1; }
.eyebrow { color: #a9c5fb; font-size: .7rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.date-chip { border: 1px solid #ffffff33; border-radius: 999px; color: #d7e4ff; font-size: .75rem; padding: 5px 10px; }
h1 { font-size: clamp(2.1rem, 6vw, 4.8rem); letter-spacing: -.065em; line-height: .98; margin: 22px 0 20px; max-width: 820px; position: relative; z-index: 1; }
.insight { color: #dbe7fb; font-size: clamp(1rem, 2vw, 1.16rem); line-height: 1.7; margin: 0; max-width: 720px; position: relative; z-index: 1; }
.hero-footer { align-items: end; border-top: 1px solid #ffffff24; display: flex; gap: 28px; justify-content: space-between; margin-top: 34px; padding-top: 20px; position: relative; z-index: 1; }
.hero-stat { display: grid; gap: 5px; }
.hero-stat-label { color: #a9c5fb; font-size: .68rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.hero-stat-value { color: #fff; font-size: 1rem; font-weight: 750; }
.panel-grid { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); margin-top: 20px; }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 17px; padding: 21px; }
.kpi { min-height: 130px; }
.kpi-label, .section-label { color: var(--muted); font-size: .68rem; font-weight: 850; letter-spacing: .12em; text-transform: uppercase; }
.kpi-value { color: var(--ink); font-size: 1.25rem; font-weight: 800; letter-spacing: -.03em; margin-top: 14px; }
.kpi-note { color: var(--ink-soft); font-size: .8rem; line-height: 1.4; margin-top: 6px; }
.automation { align-items: center; background: linear-gradient(100deg, #edf4ff, #fff); border-color: #d5e3ff; display: flex; gap: 24px; justify-content: space-between; margin-top: 20px; }
.automation h2 { margin: 8px 0 5px; }
.automation-copy { color: var(--ink-soft); font-size: .9rem; line-height: 1.5; margin: 0; max-width: 620px; }
.next-run { background: #fff; border: 1px solid #d9e5f8; border-radius: 13px; min-width: 205px; padding: 13px 15px; }
.next-run span, .next-run small { color: var(--muted); display: block; font-size: .7rem; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
.next-run strong { color: var(--blue); display: block; font-size: 1.15rem; margin: 6px 0 3px; }
.next-run small { font-size: .72rem; letter-spacing: 0; text-transform: none; }
.content-grid { display: grid; gap: 20px; grid-template-columns: minmax(0, 1.55fr) minmax(260px, .85fr); margin-top: 20px; }
section.panel { padding: clamp(20px, 3vw, 28px); }
.section-heading { align-items: start; display: flex; justify-content: space-between; gap: 16px; margin-bottom: 19px; }
h2 { font-size: 1.12rem; letter-spacing: -.02em; margin: 6px 0 0; }
.section-meta { color: var(--muted); font-size: .76rem; line-height: 1.4; text-align: right; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; min-width: 470px; width: 100%; }
th, td { border-bottom: 1px solid #edf1f6; padding: 14px 6px; text-align: left; }
thead th { color: var(--muted); font-size: .68rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
tbody th { font-size: .93rem; font-weight: 750; }
.currency-code { display: inline-block; min-width: 42px; }
.rate-value { color: var(--ink); font-size: 1.05rem; font-variant-numeric: tabular-nums; font-weight: 750; }
.change { align-items: center; display: inline-flex; font-size: .85rem; font-variant-numeric: tabular-nums; gap: 4px; white-space: nowrap; }
.trend-icon { font-size: .65rem; }
.up { color: var(--green); } .down { color: var(--red); } .flat, .muted { color: var(--muted); }
.notable-pill { background: #fff0cd; border-radius: 999px; color: #956415; font-size: .62rem; font-weight: 800; margin-left: 8px; padding: 4px 7px; text-transform: uppercase; }
.reading-note { background: #f7f9fc; border-radius: 10px; color: var(--ink-soft); font-size: .78rem; line-height: 1.5; margin: 17px 0 0; padding: 11px 13px; }
.reading-note strong { color: var(--ink); }
.history-count { background: var(--blue-soft); border-radius: 999px; color: var(--blue); font-size: .7rem; font-weight: 800; padding: 5px 9px; }
ul { list-style: none; margin: 0; padding: 0; }
li { align-items: baseline; border-bottom: 1px solid #edf1f6; display: flex; gap: 14px; padding: 12px 0; }
li:last-child { border-bottom: 0; }
time { color: var(--muted); flex: 0 0 82px; font-size: .76rem; font-variant-numeric: tabular-nums; }
li span { color: var(--ink-soft); font-size: .86rem; line-height: 1.35; }
.empty-history { color: var(--muted); font-size: .86rem; line-height: 1.5; margin: 6px 0; }
.details { display: grid; gap: 10px; margin-top: 18px; }
.detail-row { align-items: baseline; border-bottom: 1px solid #edf1f6; display: flex; font-size: .78rem; gap: 12px; justify-content: space-between; padding-bottom: 10px; }
.detail-row:last-child { border-bottom: 0; padding-bottom: 0; }
.detail-row span:first-child { color: var(--muted); }
.detail-row span:last-child { color: var(--ink-soft); font-weight: 700; text-align: right; }
footer { color: var(--muted); font-size: .73rem; line-height: 1.6; margin-top: 22px; text-align: center; }
@media (max-width: 760px) { .page-shell { width: min(100% - 28px, 620px); padding-top: 20px; } .panel-grid, .content-grid { grid-template-columns: 1fr; } .hero-footer { align-items: start; flex-wrap: wrap; } .automation { align-items: stretch; flex-direction: column; } .next-run { min-width: 0; } }
@media (max-width: 480px) { .site-header { margin-bottom: 20px; } .header-status { font-size: .6rem; } .hero { border-radius: 19px; padding: 24px 20px; } .hero-footer { display: grid; gap: 15px; grid-template-columns: 1fr 1fr; } .hero-stat-value { font-size: .88rem; } .section-heading { display: block; } .section-meta { margin-top: 8px; text-align: left; } }
</style>
</head>
<body><main class="page-shell">
<header class="site-header"><a class="brand" href="."><span class="brand-mark">CP</span><span>CurrencyPulse</span></a><div class="header-status"><span class="live-dot"></span>Always-on daily agent</div></header>
<article class="hero"><div class="hero-kicker"><span class="eyebrow">Daily exchange brief</span><span class="date-chip">${escapeHtml(today.date)}</span></div><h1>${escapeHtml(today.headline)}</h1><p class="insight">${escapeHtml(today.insight)}</p><div class="hero-footer"><div class="hero-stat"><span class="hero-stat-label">Last completed run</span><span class="hero-stat-value"><time datetime="${escapeHtml(generatedAt)}">${escapeHtml(generatedAtLabel)}</time></span></div><div class="hero-stat"><span class="hero-stat-label">Most notable move</span><span class="hero-stat-value">${escapeHtml(today.mostNotableCurrency)} · ${escapeHtml(notableMove)}</span></div></div></article>
<div class="panel-grid"><div class="panel kpi"><div class="kpi-label">Update rhythm</div><div class="kpi-value">Every 24 hours</div><div class="kpi-note">Automatically refreshed at 08:00 NPT, even while this page is closed.</div></div><div class="panel kpi"><div class="kpi-label">Coverage</div><div class="kpi-value">${trackedCurrencies.length} currencies</div><div class="kpi-note">Rates shown as how many units one US dollar buys.</div></div><div class="panel kpi"><div class="kpi-label">Comparison</div><div class="kpi-value">${Object.keys(comparisons).length ? 'Day over day' : 'First reading'}</div><div class="kpi-note">${escapeHtml(comparisonLabel)}</div></div></div>
<section class="panel automation"><div><div class="section-label">Agent activity</div><h2>Your next brief is already scheduled</h2><p class="automation-copy">CurrencyPulse fetches new rates, asks Amazon Nova Micro for a practical explanation, and publishes this page automatically. No button or manual refresh is required.</p></div><div class="next-run"><span>Next automatic update</span><strong id="next-update-countdown">Calculating…</strong><small id="next-update-date">Every day · 08:00 NPT</small></div></section>
<div class="content-grid"><section class="panel"><div class="section-heading"><div><div class="section-label">Market snapshot</div><h2>Today’s exchange board</h2></div><div class="section-meta">1 USD · ${escapeHtml(comparisonLabel)}</div></div><div class="table-wrap"><table><thead><tr><th scope="col">Currency</th><th scope="col">1 USD buys</th><th scope="col">Daily move</th></tr></thead><tbody>${rows}</tbody></table></div><p class="reading-note"><strong>How to read this:</strong> a positive move means one USD buys more of that currency than the previous run. Green can help dollar remittances; it can also mean imports priced in USD cost more locally.</p></section>
<section class="panel"><div class="section-heading"><div><div class="section-label">Agent memory</div><h2>Recent briefs</h2></div><span class="history-count">${Math.min(history.filter((entry) => entry.date < today.date).length, 14)} / 14</span></div>${historyRows ? `<ul>${historyRows}</ul>` : '<p class="empty-history">This is the first completed brief. Tomorrow’s run will add the first day-over-day comparison here.</p>'}<div class="details"><div class="detail-row"><span>Rates source</span><span>open.er-api.com</span></div><div class="detail-row"><span>Brief engine</span><span>Amazon Nova Micro</span></div><div class="detail-row"><span>Schedule</span><span>02:15 UTC · 08:00 NPT</span></div></div></section></div>
<footer>Updated ${escapeHtml(generatedAtLabel)} · Daily rates are based on USD and are for practical reference. CurrencyPulse runs unattended on AWS Lambda, S3, Bedrock, and EventBridge Scheduler.</footer>
</main><script>
(function () {
  function updateNextRun() {
    var now = new Date();
    var next = new Date(now);
    next.setUTCHours(2, 15, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    var minutes = Math.max(1, Math.floor((next - now) / 60000));
    var hours = Math.floor(minutes / 60);
    var remaining = minutes % 60;
    document.getElementById('next-update-countdown').textContent = 'in ' + hours + 'h ' + remaining + 'm';
    document.getElementById('next-update-date').textContent = next.toLocaleString('en-NP', { timeZone: 'Asia/Kathmandu', dateStyle: 'medium', timeStyle: 'short' }) + ' NPT';
  }
  updateNextRun();
  window.setInterval(updateNextRun, 60000);
}());
</script></body></html>`;
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
    generatedAt: new Date().toISOString(),
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
