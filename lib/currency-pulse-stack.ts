import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';

const MODEL_ID = 'amazon.nova-micro-v1:0';
const DAILY_SCHEDULE = 'cron(15 2 * * ? *)';

export interface CurrencyPulseStackProps extends cdk.StackProps {
  trackedCurrencies?: string;
}

export class CurrencyPulseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CurrencyPulseStackProps = {}) {
    super(scope, id, props);

    const siteBucket = new s3.Bucket(this, 'CurrencyPulseSiteBucket', {
      websiteIndexDocument: 'index.html',
      // Public website access is through the bucket policy, never through object ACLs.
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        blockPublicPolicy: false,
        ignorePublicAcls: true,
        restrictPublicBuckets: false,
      }),
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const lambdaRole = new iam.Role(this, 'GenerateBriefRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Least-privilege runtime role for the CurrencyPulse generator',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [siteBucket.bucketArn],
      conditions: {
        StringLike: { 's3:prefix': ['data/history.json'] },
      },
    }));
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [
        siteBucket.arnForObjects('data/history.json'),
        siteBucket.arnForObjects('index.html'),
      ],
    }));

    const modelArn = cdk.Arn.format({
      partition: cdk.Aws.PARTITION,
      service: 'bedrock',
      region: cdk.Aws.REGION,
      account: '',
      resource: `foundation-model/${MODEL_ID}`,
    }, this);
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [modelArn],
    }));

    const generateBrief = new nodejs.NodejsFunction(this, 'GenerateBriefFunction', {
      functionName: 'generateBrief',
      entry: path.join(__dirname, '..', 'lambda', 'generateBrief.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        BUCKET_NAME: siteBucket.bucketName,
        TRACKED_CURRENCIES: props.trackedCurrencies ?? 'NPR,INR,EUR,GBP,AUD',
        BEDROCK_MODEL_ID: MODEL_ID,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
      },
    });

    const schedulerRole = new iam.Role(this, 'DailyScheduleRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Allows EventBridge Scheduler to invoke generateBrief once daily',
    });
    schedulerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [generateBrief.functionArn],
    }));

    new scheduler.CfnSchedule(this, 'DailyGenerateBriefSchedule', {
      name: `${this.stackName}-daily-generate-brief`,
      description: 'Generate the CurrencyPulse brief daily at 02:15 UTC (08:00 Nepal time)',
      scheduleExpression: DAILY_SCHEDULE,
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: generateBrief.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    });

    new cdk.CfnOutput(this, 'WebsiteUrl', {
      description: 'Public CurrencyPulse static website URL',
      value: siteBucket.bucketWebsiteUrl,
    });
    new cdk.CfnOutput(this, 'BucketName', {
      description: 'S3 bucket storing CurrencyPulse history and website',
      value: siteBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'ScheduleExpression', {
      description: 'Daily EventBridge Scheduler expression',
      value: DAILY_SCHEDULE,
    });
  }
}
