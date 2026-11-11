# Release Workflow Orchestrator

A take-home AWS CDK application that runs a release workflow as a task DAG.
The three stacks and five multi-runtime task Lambdas have been deployed and
the success, warning, and failure scenarios have been exercised in a sandbox.
See [docs/workflow-design.md](docs/workflow-design.md) for workflow rules and
implementation decisions. The design-only Phase 2 alternative using Step
Functions is described in [docs/AlternativeSolution.md](docs/AlternativeSolution.md).

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
aws sts get-caller-identity
npx cdk bootstrap aws://<account-id>/us-east-1
```

Review the synthesized changes before deploying:

```text
npx cdk diff PayloadStack OrchestrationStack MonitoringStack
npx cdk deploy --all
```

In the CloudFormation outputs, use `DashboardUrl` for the UI and
`WorkflowApiUrl` for the API. The API stage root is not a route; use
`/workflows` or `/workflows/{id}`.

## Cleanup and limitations

Before destroying the stacks, manually empty the dashboard S3 bucket:

```text
aws s3 rm s3://<dashboard-bucket-name> --recursive
npx cdk destroy --all
```

The bucket intentionally does not enable CDK's `autoDeleteObjects` option, to
avoid creating its additional custom-resource Lambda. CloudFormation can
delete only empty S3 buckets.

The API has no authentication and is intended only for this demo. The
dashboard uses polling rather than real-time updates.

## AI-assisted development

AI assistance was guided by this repository's `AGENTS.md`, which was modified
specifically for this project, and by `docs/workflow-design.md`, which describes
the scope, requirements, and architecture. These files gave the coding
assistant context to support implementation and review. Following the
infrastructure review, the AWS Well-Architected Review skill was invoked to
assess the synthesized architecture and IAM policies. AI assistance also
helped explain and document the design; implementation and validation results
are reflected in this repository.
