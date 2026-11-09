// Invokes each deployed task Lambda to smoke-test the PayloadStack.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const tasks = [
  { taskId: 'A', logicalIdPrefix: 'ValidationFunction' },
  { taskId: 'B1', logicalIdPrefix: 'BuildVerificationFunction' },
  { taskId: 'B2', logicalIdPrefix: 'ArtifactVerificationFunction' },
  { taskId: 'B3', logicalIdPrefix: 'SecurityScanFunction' },
  { taskId: 'C', logicalIdPrefix: 'ReleaseCompletionFunction' },
] as const;

const sampleInput = {
  version: 'beta',
  environment: 'SIT',
  approved: true,
};

interface StackResource {
  LogicalResourceId?: string;
  PhysicalResourceId?: string;
  ResourceType?: string;
}

interface StackResourcesResponse {
  StackResources?: StackResource[];
}

interface InvocationResponse {
  FunctionError?: string;
  StatusCode?: number;
}

interface ScriptOptions {
  stackName: string;
  awsOptions: string[];
  help: boolean;
}

function parseOptions(args: string[]): ScriptOptions {
  const options: ScriptOptions = {
    stackName: process.env.PAYLOAD_STACK_NAME ?? 'PayloadStack',
    awsOptions: [],
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    if (
      argument !== '--stack-name' &&
      argument !== '--profile' &&
      argument !== '--region'
    ) {
      throw new Error(`Unknown option: ${argument}`);
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Expected a value after ${argument}`);
    }
    index += 1;

    if (argument === '--stack-name') {
      options.stackName = value;
    } else {
      options.awsOptions.push(argument, value);
    }
  }

  return options;
}

function runAws(args: string[], awsOptions: string[]): string {
  try {
    return execFileSync('aws', [...args, ...awsOptions], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const cliError = error as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
    };
    const details = cliError.stderr?.toString().trim() || cliError.message;
    throw new Error(`AWS CLI command failed:\n${details}`);
  }
}

function findFunctionName(
  resources: StackResource[],
  logicalIdPrefix: string,
  stackName: string,
): string {
  const matches = resources.filter(
    (resource) =>
      resource.ResourceType === 'AWS::Lambda::Function' &&
      resource.LogicalResourceId?.startsWith(logicalIdPrefix),
  );

  if (matches.length !== 1 || !matches[0].PhysicalResourceId) {
    throw new Error(
      `Expected one deployed Lambda matching ${logicalIdPrefix} in stack ${stackName}; found ${matches.length}`,
    );
  }

  return matches[0].PhysicalResourceId;
}

function printHelp(): void {
  console.log(
    [
      'Invoke all task Lambdas in a deployed PayloadStack.',
      '',
      'Usage: npm run invoke:all -- [--stack-name NAME] [--profile PROFILE] [--region REGION]',
      '',
      'The default stack name is PayloadStack. AWS credentials and region may',
      'also come from the standard AWS CLI configuration or environment.',
      'The sample input is an approved beta release in SIT.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const stackResponse = JSON.parse(
    runAws([
      'cloudformation',
      'describe-stack-resources',
      '--stack-name',
      options.stackName,
      '--output',
      'json',
    ], options.awsOptions),
  ) as StackResourcesResponse;
  const resources = stackResponse.StackResources;
  if (!resources) {
    throw new Error(`Stack ${options.stackName} returned no resources`);
  }

  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), 'release-workflow-invoke-'),
  );
  try {
    const payloadPath = path.join(tempDirectory, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify(sampleInput));

    for (const task of tasks) {
      const functionName = findFunctionName(
        resources,
        task.logicalIdPrefix,
        options.stackName,
      );
      const responsePath = path.join(
        tempDirectory,
        `${task.taskId}-response.json`,
      );
      const invocation = JSON.parse(
        runAws([
          'lambda',
          'invoke',
          '--function-name',
          functionName,
          '--cli-binary-format',
          'raw-in-base64-out',
          '--payload',
          `fileb://${payloadPath}`,
          responsePath,
          '--output',
          'json',
        ], options.awsOptions),
      ) as InvocationResponse;
      const result = JSON.parse(readFileSync(responsePath, 'utf8')) as unknown;

      console.log(`${task.taskId} (${functionName}):`);
      console.log(JSON.stringify(result, null, 2));

      if (invocation.StatusCode !== 200 || invocation.FunctionError) {
        throw new Error(
          `${task.taskId} invocation failed with status ${invocation.StatusCode ?? 'unknown'}${invocation.FunctionError ? ` (${invocation.FunctionError})` : ''}`,
        );
      }
    }
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
