# Agent instructions

This repository is an AWS CDK application written in strict TypeScript. Inspect
the current code before making changes. The target architecture and behavior in
[`docs/workflow-design.md`](docs/workflow-design.md) are requirements, not
evidence that those resources or features have already been implemented. Read
that design document before changing workflow behavior, data models, or
infrastructure boundaries.

## Project practices

- Prefer simple, explainable changes that fit the existing code. Do not
  restructure the starter app just to match the target layout; update `cdk.json`
  and related references if an entry point or stack is intentionally moved.
- Keep business rules in task Lambdas, not in generic orchestration,
  persistence, or infrastructure code.
- Prefer CDK L2 constructs. Use L1 constructs only when needed and explain why.
- Keep construct IDs stable after deployment. Use CDK references and tokens
  rather than hand-built ARNs or physical names.
- Keep synthesis deterministic and independent of AWS credentials unless a
  feature explicitly requires otherwise. Do not hardcode account IDs, regions,
  credentials, or environment-specific values.
- Apply least privilege; use narrow `grant*` helpers where appropriate. Review
  synthesized IAM policies and public exposure when changing infrastructure.
- Make data retention and removal intentional. Follow the disposable-stack
  policy in the design doc where applicable; never use `DESTROY` for data that
  must be retained. Ensure sandbox resources have a documented cleanup path.
- Tag taggable resources with `project=release-orchestrator`.
- Never commit credentials or secrets, or print them in logs. Review context
  files before committing.
- Add comments only to clarify non-obvious decisions.

## CDK documentation and validation

Before writing constructs for an AWS service, check for its README under
`node_modules/aws-cdk-lib/<module>/README.md`. List the headings first, then
read only the relevant section. A missing README is not an error; do not reread
sections already reviewed for the same task.

Run the smallest relevant checks, then broader project checks as appropriate:

```text
npm run build
npm test
npx cdk synth
npx cdk diff
```

Synthesis must succeed. If container assets are added, Docker may be needed for
synthesis. Review synthesized templates and policies for security, replacement,
and retention changes. `cdk diff` can require AWS credentials; report only
checks actually run.

Ask before running `cdk deploy`, `cdk destroy`, or any other command that
changes AWS resources. Use a sandbox account/profile only.

Update the README when setup, commands, or implemented behavior changes. Explain
significant trade-offs there, and distinguish implemented behavior from target
requirements. If a request conflicts with the design requirements, flag the
conflict before proceeding.

Use the `aws-well-architected-review` skill after the target infrastructure has
been implemented and synthesizes, and again before submission. For a
post-deployment workflow incident, inspect Orchestrator and Worker logs, stream
iterator age, and configured failure destinations.
