# Release Workflow Orchestrator

An AWS CDK TypeScript take-home project exploring a DAG-based release workflow
on AWS.

> **Current state:** this repository currently contains the CDK starter stack.
> The target architecture and behavior are requirements for future
> implementation, not features already present. See
> [docs/workflow-design.md](docs/workflow-design.md) for the design and
> [AGENTS.md](AGENTS.md) for instructions used by coding agents.

## Development

Install dependencies and run the checks:

```text
npm ci
npm run build
npm test
npx cdk synth
```

`npx cdk diff` compares the synthesized app with a deployed stack and may
require AWS credentials. Ask before running `cdk deploy`, `cdk destroy`, or any
other command that changes AWS resources.

## Design decisions

The target design uses DynamoDB Streams and Lambda to coordinate a small task
DAG, keeping orchestration logic testable and separate from release-specific
business rules. Step Functions is a production alternative, but is not part of
the take-home scope unless explicitly agreed.
