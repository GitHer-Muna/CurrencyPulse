# Weekend Creative Agent Challenge: CurrencyPulse — A Daily Exchange Brief That Runs While I’m Away

**Tags:** #agents #challenge

## Vision: a useful update waiting in the morning

Exchange rates change every day, but most of us do not want to open a finance dashboard and study charts before deciding whether to send money home, pay an overseas tuition bill, plan a trip, or buy something imported. I built CurrencyPulse to make that decision easier.

CurrencyPulse is a small always-on agent that prepares one practical currency brief every morning. It watches a set of USD exchange rates, compares them with the most recent previous run, and explains what the movement might mean in normal language. The output is a simple web page that is already waiting when I open it. There is no prompt box and no “generate” button. The point is that the useful part happens while I am away.

The default view tracks NPR, INR, EUR, GBP, and AUD. The tracked list can be changed with one configuration value. The page shows the latest rates, the percentage movement for each currency, the largest move, a short explanation, and a compact history of previous briefs.

## How I built it

I deliberately kept the architecture small. A daily EventBridge Scheduler invocation starts an AWS Lambda function called `generateBrief`. The Lambda calls the free, keyless `open.er-api.com` endpoint for current USD-based rates. It then reads `data/history.json` from Amazon S3. If this is the first run, it starts with an empty history. Otherwise, it finds the most recent entry before today and calculates the percentage change for every currency that exists in both readings.

The current rates and those comparisons are sent to Amazon Bedrock using Amazon Nova Micro. I asked the model for a short headline, a three-to-five-sentence explanation, and the currency code of the most notable move. The prompt asks for direct, specific language rather than a press release or a generic financial disclaimer. The Lambda also treats the model response as untrusted input: it removes optional Markdown fences, parses the JSON inside a try/catch, checks the required fields, and logs the raw response if parsing fails.

After the brief is generated, Lambda appends the result to `data/history.json`, keeps the latest 60 entries, and creates a new inline `index.html`. I chose this static approach because the site does not need a database, API Gateway, frontend framework, or always-running server. The generated page has a responsive layout, a prominent daily insight, an exchange-rate table, a “last completed run” timestamp in Nepal time, the next scheduled update, the data source, the Bedrock model, and recent history. If the page is left open, it refreshes every 15 minutes so it picks up a newly published daily brief without a manual reload.

A few details mattered more than I expected. The scheduler runs at `02:15 UTC`, which is `08:00` in Nepal (NPT). I display that schedule directly in the UI because “automatic” is much clearer when the user can see when the next run will happen. I also added a prefix-scoped `s3:ListBucket` permission. Without it, S3 returned `AccessDenied` instead of a clean missing-object response on the first run when `history.json` did not exist yet. That was a good reminder that least privilege still needs to account for how an AWS API reports an empty state.

## AWS architecture

The deployed application uses:

- **Amazon EventBridge Scheduler** for the daily `cron(15 2 * * ? *)` trigger.
- **AWS Lambda**, running Node.js 20 and TypeScript, for the agent workflow.
- **Amazon Bedrock with Amazon Nova Micro** for the plain-English interpretation.
- **Amazon S3** for the history file and the public static website.
- **AWS IAM** for separate least-privilege roles for Lambda and the scheduler.
- **Amazon CloudWatch Logs** through the Lambda basic execution role for debugging external API and Bedrock failures.

There is no database. S3 is enough for this scale, and the Lambda only has read/write access to the two objects it needs: `data/history.json` and `index.html`. The S3 bucket blocks public ACLs and uses a bucket policy for website reads.

## What I learned

The biggest lesson was that an always-on agent is more about dependable scheduling and publishing than about making a large interface. The application feels automatic because EventBridge creates the rhythm, Lambda performs the work, and S3 makes the result available without another service in the middle.

I also learned to design for the first run explicitly. Missing history, unavailable rates, malformed model output, and a stale page are all normal operational states, not unusual edge cases. Logging each external call and refusing to publish a broken page made the workflow easier to reason about. Finally, making the update time visible turned a backend cron expression into something a real user can understand.

Try the live app: [CurrencyPulse](http://currencypulsestack-currencypulsesitebucketcbb7f6cf-mia3tbwtnwt6.s3-website-us-east-1.amazonaws.com)

Source code: [GitHub repository](https://github.com/GitHer-Muna/CurrencyPulse)
