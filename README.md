# Release Workflow Orchestrator

A take-home AWS CDK application that runs a release workflow as a task DAG.
The three stacks and five multi-runtime task Lambdas have been deployed and
the success, warning, and failure scenarios have been exercised in a sandbox.
See [docs/workflow-design.md](docs/workflow-design.md) for workflow rules and
implementation decisions.

## Architecture

- `PayloadStack`: Node.js, Python, and Docker task Lambdas.
- `OrchestrationStack`: DynamoDB workflow state, stream-triggered Orchestrator,
  and task Worker.
- `MonitoringStack`: REST API and a private S3 dashboard served through
  CloudFront.

The dashboard polls the API while a workflow runs. The API routes are
`POST /workflows`, `GET /workflows`, and `GET /workflows/{id}`.

## Prerequisites

- Node.js 20 or later and npm.
- Python 3.12 for the Python task tests.
- Docker with Linux containers for the B3 Lambda image.
- AWS CLI credentials for an authorized sandbox account.

## Install and test

```text
npm ci
npm run build
npm test
npm run test:python
npx cdk synth
```

To invoke the five deployed task Lambdas directly:

```text
npm run invoke:all -- --stack-name PayloadStack --profile sandbox --region us-east-1
```

## Deploy

Confirm the AWS identity and bootstrap the target account/region if needed:

```text
aws sts get-caller-identity --profile sandbox
npx cdk bootstrap aws://<account-id>/us-east-1 --profile sandbox
```

Review the synthesized changes before deploying:

```text
npx cdk diff PayloadStack OrchestrationStack MonitoringStack --profile sandbox
npx cdk deploy --all --profile sandbox
```

In the CloudFormation outputs, use `DashboardUrl` for the UI and
`WorkflowApiUrl` for the API. The API stage root is not a route; use
`/workflows` or `/workflows/{id}`.

## Cleanup and limitations

Before destroying the stacks, manually empty the dashboard S3 bucket:

```text
aws s3 rm s3://<dashboard-bucket-name> --recursive --profile sandbox
npx cdk destroy --all --profile sandbox
```

The bucket intentionally does not enable CDK's `autoDeleteObjects` option, to
avoid creating its additional custom-resource Lambda. CloudFormation can
delete only empty S3 buckets.

The API has no authentication and is intended only for this demo. The
dashboard uses polling rather than real-time updates.
