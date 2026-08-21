# CurrencyPulse

CurrencyPulse is a small always-on AWS application that prepares a daily exchange-rate brief. It fetches current USD exchange rates, compares them with the most recent previous run, and uses Amazon Nova Micro to explain the most important move in plain English.

The result is a static page that is ready when you check it in the morning. It is designed for practical questions such as:

- Did a currency move enough to affect a remittance?
- Is today a better or worse time to convert money for travel or tuition?
- Could a change affect the local cost of imported goods?

## Live application

**[Open CurrencyPulse](http://currencypulsestack-currencypulsesitebucketcbb7f6cf-mia3tbwtnwt6.s3-website-us-east-1.amazonaws.com)**

The page displays the latest brief, five tracked rates, daily movement when a previous reading is available, the last completed run, the next scheduled run, and recent headlines.

## How often it updates

CurrencyPulse runs once a day at **02:15 UTC**, which is **08:00 Nepal Time (NPT)**. The Lambda fetches a fresh rate snapshot and publishes a new `index.html` after the brief is generated.

If the page is left open, it refreshes every 15 minutes so it can pick up the latest published brief. The first run has no comparison. From the next run onward, the application compares each new reading with the most recent history entry before the current date.

The schedule is defined as:

```text
cron(15 2 * * ? *)
```

## Architecture

```text
EventBridge Scheduler
        │  daily at 02:15 UTC
        ▼
AWS Lambda: generateBrief
        │
        ├── open.er-api.com      current USD exchange rates
        ├── Amazon S3             data/history.json
        ├── Amazon Bedrock        Amazon Nova Micro brief
        └── Amazon S3             index.html static website
```

The project does not use a database, API Gateway, or a frontend framework. S3 stores the small amount of history the agent needs and hosts the generated page.

### AWS services

- **AWS Lambda** — runs the daily workflow using Node.js 20 and TypeScript.
- **Amazon EventBridge Scheduler** — invokes `generateBrief` once per day.
- **Amazon Bedrock** — uses `amazon.nova-micro-v1:0` to write the headline and explanation.
- **Amazon S3** — stores the latest 60 history entries and hosts the public static website.
- **AWS IAM** — gives the Lambda only the S3 and Bedrock permissions it needs.
- **Amazon CloudWatch Logs** — records rates API, Bedrock, and publishing errors.

The exchange-rate endpoint is `https://open.er-api.com/v6/latest/USD`. It is free and does not require an API key.

## What the agent does

On each scheduled run, `generateBrief`:

1. Fetches the current USD rates for the configured currencies.
2. Reads `data/history.json` from S3, treating a missing file as an empty history.
3. Finds the most recent entry before today and calculates percentage changes.
4. Sends the rates and changes to Amazon Nova Micro.
5. Defensively parses the model's JSON response, including responses wrapped in Markdown fences.
6. Appends the new entry and keeps the latest 60 entries.
7. Regenerates the responsive static page and uploads it to S3.

The page shows the latest insight first, followed by the rate table, an explanation of how to read USD-based rates, the automation status, data source, model, schedule, and the last 14 previous briefs.

If the rates API fails, the Lambda logs the error and does not publish a broken page. The page also records the completed run time in Nepal time so it is clear how fresh the data is.

## Project structure

```text
.
├── bin/currency-pulse.ts          CDK application entry point
├── lib/currency-pulse-stack.ts    S3, Lambda, IAM, and Scheduler resources
├── lambda/generateBrief.ts        Rates workflow and HTML renderer
├── test/generateBrief.test.ts     Unit tests for comparisons and rendering
├── cdk.json                       CDK context and app configuration
├── package.json                   Scripts and dependencies
└── tsconfig.json                  TypeScript configuration
```

## Run it locally

Prerequisites:

- Node.js 20 or newer
- An AWS account with credentials configured
- AWS CDK bootstrapping permissions
- Amazon Nova Micro available in the deployment region

Install dependencies and run the local checks:

```bash
npm install
npm test
npm run build
npx cdk synth
```

`npm test` runs the unit tests. `npm run build` runs strict TypeScript checking. `cdk synth` creates the CloudFormation template and bundles the Lambda asset without deploying anything.

## Deploy to AWS

Set an AWS region first. The deployed application currently runs in `us-east-1`.

```bash
export AWS_DEFAULT_REGION=us-east-1
export CDK_DEFAULT_REGION=us-east-1

aws sts get-caller-identity
npx cdk bootstrap
npx cdk deploy --require-approval never
```

CDK prints the following outputs after deployment:

- `WebsiteUrl` — the S3 website endpoint
- `BucketName` — the bucket containing the site and history
- `ScheduleExpression` — the daily Scheduler expression

To use a different currency list without editing the Lambda, pass a CDK context value:

```bash
npx cdk deploy \
  -c trackedCurrencies=NPR,INR,EUR \
  --require-approval never
```

The list is passed to the Lambda as the comma-separated `TRACKED_CURRENCIES` environment variable. The default is `NPR,INR,EUR,GBP,AUD`.

To run the agent manually after deployment:

```bash
aws lambda invoke \
  --function-name generateBrief \
  --region us-east-1 \
  /tmp/currency-pulse-response.json

cat /tmp/currency-pulse-response.json
```

## Cost and cleanup

At this scale, the daily workload is small: one rates API request, one short Bedrock request, a Lambda invocation, and a few S3 operations per day. It is intended to fit comfortably within the AWS Free Tier, but AWS pricing and account credits vary. Set a budget alert before using the project for an extended period.

The S3 site bucket uses a retain policy so a normal `cdk destroy` does not accidentally delete the history and website data. To remove everything, destroy the stack and then delete the retained bucket after confirming that the data is no longer needed.

```bash
npx cdk destroy
aws s3 rb s3://YOUR_BUCKET_NAME --force
```

## License

This project is provided for learning and demonstration purposes.
