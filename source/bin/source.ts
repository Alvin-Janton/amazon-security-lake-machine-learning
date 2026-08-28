#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SageMakerDomainStack } from '../lib/sagemaker_domain';
import { AwsSolutionsChecks } from 'cdk-nag';

const app = new cdk.App();

new SageMakerDomainStack(app, 'SageMakerDomainStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true}));
app.synth()
