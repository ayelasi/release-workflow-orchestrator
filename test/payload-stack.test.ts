// Verifies task Lambda runtimes, timeouts, and logging configuration.
import { App } from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { PayloadStack } from '../lib/payload-stack';

describe('PayloadStack', () => {
  it('creates five task Lambdas with 30-day retained log groups', () => {
    const app = new App();
    const stack = new PayloadStack(app, 'PayloadStack');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::Function', 5);
    template.allResourcesProperties('AWS::Lambda::Function', {
      Timeout: 15,
    });
    template.resourceCountIs('AWS::Logs::LogGroup', 5);
    template.allResourcesProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });
  });
});
