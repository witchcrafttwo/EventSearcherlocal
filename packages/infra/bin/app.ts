#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { EventsAiStack } from "../lib/events-ai-stack.js";

const app = new App();

new EventsAiStack(app, "PrefectureEventsAiStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1"
  }
});
