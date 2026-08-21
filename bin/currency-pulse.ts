#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CurrencyPulseStack } from '../lib/currency-pulse-stack';

const app = new cdk.App();

new CurrencyPulseStack(app, 'CurrencyPulseStack', {
  trackedCurrencies: app.node.tryGetContext('trackedCurrencies') ?? 'NPR,INR,EUR,GBP,AUD',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
