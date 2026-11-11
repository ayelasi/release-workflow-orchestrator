# Workflow design requirements

This document records the intended behavior and relevant implementation
decisions. Use the code as the source of truth for what is currently
implemented, and keep this specification synchronized with changes.

## Goal and architecture

Build a DAG-based release workflow engine. Tasks log, sleep for a random
1-10 seconds, and return metadata; the engineering focus is orchestration, IAM,
and infrastructure.

```text
S3/CloudFront dashboard -> API Gateway -> API Lambda -> DynamoDB
DynamoDB Stream -> Orchestrator Lambda -> Worker Lambda -> Task Lambdas
Task result -> Worker writes DynamoDB -> Stream -> Orchestrator (loop)
```

```text
        +-> B1 Build Verification     (Node)    -+
A  -----+-> B2 Artifact Verification  (Python)  -+---> C Release Completion (Node)
Validation (Node) +-> B3 Security Scan (Docker) -+
```

Task IDs are stable (`A`, `B1`, `B2`, `B3`, `C`). Human-readable labels
belong in data and the UI.

The target layout is:

```text
bin/release-workflow-orchestrator.ts
lib/payload-stack.ts
lib/orchestration-stack.ts
lib/monitoring-stack.ts
lambdas/
  a-validation/
  b1-build-verify/
  b2-artifact-verify/
  b3-security-scan/
  c-release-complete/
  orchestrator/
  worker/
  api/
web/
scripts/invoke-all.ts
test/
.github/skills/
```

Keep stack dependencies one-way: Payload -> Orchestration -> Monitoring. Pass
resources through constructor props; do not introduce circular references.
Retain the existing entry point or stack names unless intentionally changing
them, and update `cdk.json` and related code when doing so.

## Required stack ownership

Define all AWS resources in CDK and organize them into these three stacks:

| Stack | Owns |
|---|---|
| `PayloadStack` | The five task Lambdas: A, B1, B2, B3, and C |
| `OrchestrationStack` | Workflow DynamoDB table, Orchestrator Lambda, and Worker Lambda |
| `MonitoringStack` | API Gateway and API Lambda, plus the S3-hosted dashboard and its delivery resources |

Pass resource references between stacks through typed constructor props. Keep
the dependency direction one-way: `PayloadStack` -> `OrchestrationStack` ->
`MonitoringStack`. Avoid circular stack references. The current CDK entry point
and stack may still have starter names; renaming them is optional and requires
updating `cdk.json` and all affected references.

## Required API and dashboard

Implement an API Gateway REST API using Lambda proxy integration with:

| Method and route | Required behavior |
|---|---|
| `POST /workflows` | Accept workflow input, create the META and task state, and start the workflow |
| `GET /workflows` | List workflows, newest first |
| `GET /workflows/{id}` | Return one workflow and its task statuses/details |

Host a responsive static dashboard from S3. Keep the bucket private and serve
the site through CloudFront Origin Access Control rather than enabling public
bucket access.

The dashboard must provide:

- A control to start a workflow using the required release inputs.
- Workflow and task status indicators, including visible progress.
- A DAG visualization showing task dependencies and execution state.
- Responsive behavior suitable for common desktop and mobile viewport sizes.

The UI should call the REST API and reflect returned state. Polling is
sufficient for the core requirement; real-time updates are a stretch goal.

## Workflow status model

```text
PENDING -> RUNNING -> COMPLETED
                   -> COMPLETED_WITH_WARNINGS
                   -> FAILED
PENDING -> SKIPPED
```

- Dependencies are satisfied only by `COMPLETED` or
  `COMPLETED_WITH_WARNINGS`.
- A task becomes `SKIPPED` when any dependency is `FAILED` or `SKIPPED`; this
  propagates through the DAG.
- A new workflow starts as `RUNNING`. Once all tasks are terminal, workflow
  status is `FAILED` if any task failed; otherwise it is
  `COMPLETED_WITH_WARNINGS` if any task has warnings; otherwise it is
  `COMPLETED`.
- Task Lambdas return `SUCCESS`, `WARNING`, or `FAILURE`. The Worker maps these
  to `COMPLETED`, `COMPLETED_WITH_WARNINGS`, or `FAILED`. A thrown error or
  invoke failure also becomes `FAILED`.

Do not add, rename, or reorder statuses without updating this document and
their tests.

## Release rules

Business rules live only in task Lambdas, never in the generic Orchestrator,
Worker, or table logic.

Release input: `version` (`latest` | `beta`), `environment` (`SIT` | `PROD`),
`approved` (boolean).

Task A (Validation) returns `FAILURE` if any of these hold:

- `version = beta` and `environment = PROD`
- `version = beta` and `approved = false`
- `environment = PROD` and `approved = false`

Otherwise A succeeds. The remaining task behavior is:

| Task | Behavior |
|---|---|
| B1 Build Verification | `beta` -> `WARNING` ("vulnerabilities found"); `latest` -> `SUCCESS` |
| B2 Artifact Verification | Always `SUCCESS`; returns a checksum |
| B3 Security Scan | `beta` -> `WARNING` with `critical` findings; `latest` -> clean `SUCCESS` |
| C Release Completion | `SUCCESS`; runs only if B1, B2, and B3 are satisfied |

Expected example: approved `beta` in `SIT` results in
`COMPLETED_WITH_WARNINGS`.

## DynamoDB

Use one on-demand `WorkflowTable` with partition key `workflowId` (string),
sort key `taskId` (string), stream `NEW_AND_OLD_IMAGES`, and
`RemovalPolicy.DESTROY` for this disposable take-home stack.

- META item (`taskId = "META"`): `status`, `input`, `createdAt`,
  `completedAt`, `gsi1pk = "WORKFLOW"`, `gsi1sk = createdAt`.
- Task items: `label`, `status`, `dependencies` (task ID list), `startedAt`,
  optional `workerClaimedAt`, `finishedAt`, `result` (map), `reason`.
- GSI1 (`gsi1pk`, `gsi1sk`) is sparse (META items only) and serves
  `GET /workflows` newest-first. Do not use `Scan`.
- Create the META item and five task items in one `TransactWriteItems`.

## Orchestration

1. The Orchestrator is triggered by the stream and by direct invocation with
   `{ "workflowId": "..." }` for re-drive.
2. For each workflow in a batch, query its partition. For each `PENDING` task,
   mark it `SKIPPED` if a dependency failed or was skipped; otherwise, if all
   dependencies are satisfied, conditionally mark it `RUNNING` and invoke the
   Worker asynchronously.
3. Every status change is conditional on the expected current status. This
   provides idempotency so stream redelivery and parallel branch completions
   cannot dispatch C more than once.
4. The Worker invokes a task Lambda synchronously, then writes its terminal
   status conditioned on the task being `RUNNING`. It first claims execution
   with `workerClaimedAt` so duplicate asynchronous deliveries do not run the
   task twice. A direct re-drive releases claims older than two minutes before
   redispatching; this exceeds the Worker timeout and permits recovery after a
   Worker crash.
5. Filter irrelevant stream events and configure `retryAttempts` and
   `bisectBatchOnError`.
6. Lambda timeouts must exceed the maximum task sleep (10 seconds) with margin.

## IAM and security requirements

- Use least privilege. Avoid wildcard actions and resources unless AWS
  requires them; explain each exception in code.
- Task Lambdas get default log permissions only.
- Worker gets table read/write and `lambda:InvokeFunction` on exactly the five
  task functions.
- Orchestrator gets table read/write (plus stream read) and permission to invoke
  only the Worker.
- API Lambda gets `PutItem`/`TransactWriteItems`, `GetItem`, and `Query` on the
  table and its GSI only.
- Keep S3 private with public access blocked; serve it through CloudFront Origin
  Access Control. Restrict API CORS to the dashboard origin where practical.
- Use narrow `grant*` helpers where appropriate and inspect synthesized
  policies.

## Runtime and task conventions

- TypeScript strict mode for CDK and Node.js Lambdas. Python 3.12 for B2. B3 is
  a container image built from its `Dockerfile`.
- Each task Lambda logs its task name exactly once on start (`Lambda A`,
  `Lambda B1`, etc.) and returns
  `{ taskId, outcome, startedAt, finishedAt, durationMs, message, findings?, checksum? }`.
- B2's successful result includes a checksum.
- Each task randomly sleeps for 1-10 seconds by default. `TASK_SLEEP_SECONDS`
  can override the delay (including `0` for tests).
- Keep functions small and straightforward. Put pure orchestration decision
  logic in a separate module so it can be tested without AWS.
- Tag all taggable resources `project=release-orchestrator`.

## Implemented project decisions and scope

- Dashboard updates use polling; real-time delivery is left as a stretch goal
  because the demo workflows complete quickly.
- The REST API is unauthenticated and is for sandbox demonstration only.
- API Gateway access logging uses an account-and-region-level CloudWatch role.
  The role is retained because the API Gateway account setting can outlive the
  stack.
- Lambda and API access logs are retained with 30-day event retention.
- The disposable dashboard bucket intentionally does not use CDK
  `autoDeleteObjects`, which would add a custom-resource Lambda. Empty the
  bucket manually before destroying the stacks because CloudFormation can
  delete only empty S3 buckets.
- The current workflow can be re-driven by directly invoking the Orchestrator
  with `{ "workflowId": "<id>" }`. The stream mapping retries a failed batch
  three times and bisects failing batches; there is no failure destination or
  CloudWatch alarm. Production use should add alerting and managed
  failure/replay handling.
- Real build, artifact, and scanning integrations, multi-account deployment,
  and API authentication are outside this demo's scope.
- The Phase 2 alternative architecture using Step Functions is documented in
  [AlternativeSolution.md](../AlternativeSolution.md); it is a design only and
  is not part of the deployed implementation.
