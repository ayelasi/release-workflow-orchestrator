#!/usr/bin/env node
// Defines the CDK app and wires its stacks in dependency order.
import * as cdk from 'aws-cdk-lib/core';
import { MonitoringStack } from '../lib/monitoring-stack';
import { OrchestrationStack } from '../lib/orchestration-stack';
import { PayloadStack } from '../lib/payload-stack';

const app = new cdk.App();
const payloadStack = new PayloadStack(app, 'PayloadStack');
const orchestrationStack = new OrchestrationStack(app, 'OrchestrationStack', {
  taskFunctions: payloadStack.taskFunctions,
});
new MonitoringStack(app, 'MonitoringStack', {
  workflowTable: orchestrationStack.workflowTable,
});
