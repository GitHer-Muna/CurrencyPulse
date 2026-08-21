---

## Phase 1 — Everything: Infra + Agent Logic in One Go

```
I'm building a minimal serverless AWS project called "CurrencyPulse" using AWS CDK (TypeScript). It's
a daily agent that fetches real currency exchange rates, compares them to the previous day, and has an
AI write one short plain-English insight about what changed and why it's practically relevant. Keep
this as simple as possible — no database, no API Gateway.

1. S3 bucket:
   - Static website hosting enabled (index.html as index document)
   - Public read access via bucket policy (block public ACLs, allow public policy for GET)

2. IAM role for a Lambda with least-privilege permissions to:
   - Read/write the S3 bucket
   - Invoke Bedrock model `amazon.nova-micro-v1:0`
   (No external API key needed — the rates API below is free and keyless.)

3. Lambda function called `generateBrief` (Node.js 20.x, TypeScript):
   a. Fetch current exchange rates from the free, keyless API:
      `https://open.er-api.com/v6/latest/USD`
      Extract rates for: NPR, INR, EUR, GBP, AUD (or whichever set I configure via an environment
      variable TRACKED_CURRENCIES, comma-separated, so I can change the list without touching code).
   b. Read `data/history.json` from S3 (empty array if it doesn't exist yet). Find yesterday's entry
      (most recent one before today) and compute the percentage change for each tracked currency vs.
      today's rate. If there's no prior entry (first run ever), skip the comparison and just report
      today's rates with no change context.
   c. Call Bedrock InvokeModel with model id `amazon.nova-micro-v1:0`. Give it today's rates and the
      day-over-day percentage changes, and ask for ONLY valid JSON (no markdown, no preamble):
      { "headline": "one short punchy headline naming the most notable move today",
        "insight": "3-5 sentences in plain, direct English explaining what moved and why it practically
                    matters — e.g. cheaper/costlier remittances, better/worse time to convert for
                    travel or tuition, import cost impact. No filler, no generic disclaimers, be
                    specific about the actual numbers.",
        "mostNotableCurrency": "the currency code that moved the most" }
      Explicitly instruct the model to write like a knowledgeable person explaining this to a friend,
      not like a financial disclaimer or a press release — short sentences, no hedging phrases like
      "it is important to note that." Keep max_tokens around 350.
   d. Defensively parse the response (strip markdown fences before JSON.parse; try/catch with clear
      logging on failure).
   e. Append today's entry to the history array (date, rates object, headline, insight,
      mostNotableCurrency), keep only the most recent 60 entries, write back to
      `data/history.json` on S3.
   f. Regenerate a single static `index.html` (inline HTML/CSS, no framework). Layout:
      - Today's headline and insight at the top, clearly the focal point
      - A clean table of today's rates for each tracked currency, with a small up/down indicator and
        percentage change next to each if a comparison was available
      - A compact history section below (last 14 days, one line each: date + headline)
      - Mobile-friendly, readable typography, no generic "AI-generated content" badges or disclaimers
        cluttering the page
      Upload to the S3 bucket root, content-type `text/html`, public-read.
   g. Add try/catch and CloudWatch logging around both external calls (rates API and Bedrock) so
      failures are debuggable. If the rates API fails, log the error clearly and exit gracefully
      rather than writing a broken page.

Wire the Lambda into the CDK stack with the IAM role, pass TRACKED_CURRENCIES as a CDK-defined
environment variable, and output the S3 website URL as a CDK stack Output.
```

**Checkpoint:** Deploy, manually invoke the Lambda twice on two different days (or fake a second run by
manually editing `data/history.json` in S3 to simulate "yesterday" with slightly different rates)
so you can confirm the percentage-change logic actually works before relying on the real schedule.

---

## Phase 2 — Make It Always-On: One EventBridge Rule

```
Add an EventBridge Scheduler rule to the CurrencyPulse CDK stack that invokes the `generateBrief`
Lambda once per day (pick a fixed UTC time and tell me the corresponding local-morning time for me in
Nepal). Grant the scheduler correct IAM permission to invoke the Lambda. Confirm the resulting
cron/rate expression.
```

**Checkpoint:** Wait for (or manually trigger) one scheduled run and confirm a fresh brief with a real
day-over-day comparison appears without you touching anything. **This is your complete, submittable
project.**

---

## Cost sanity check

- Exchange rate API (open.er-api.com): free, no key
- Bedrock Nova Micro: a few hundred tokens/day, a small fraction of a cent
- Lambda, S3, EventBridge: comfortably inside Free Tier at this scale
- Set an AWS Budget alert at $5 before deploying
- `cdk destroy` once you're done screenshotting for your article if you want to be extra safe

---


## Implementation notes

The CDK app is in `bin/currency-pulse.ts` and `lib/currency-pulse-stack.ts`; the Lambda is `lambda/generateBrief.ts`.

Install and synthesize with:

```bash
npm install
npx cdk synth
```

Deploy with the default tracked currencies (`NPR,INR,EUR,GBP,AUD`) using `npx cdk deploy`. To change them without changing code, pass a context value such as `-c trackedCurrencies=NPR,INR,EUR`.

The EventBridge Scheduler expression is `cron(15 2 * * ? *)` in UTC. It runs at 08:00 in Nepal (NPT, UTC+5:45). After deployment, invoke `generateBrief` twice on separate dates—or edit `data/history.json` in the bucket to add a prior-day entry—to verify the day-over-day indicators before relying on the schedule.
