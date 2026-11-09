// Shares release-input validation, task delays, and execution metadata helpers.
export type TaskOutcome = 'SUCCESS' | 'WARNING' | 'FAILURE';

export type ReleaseVersion = 'latest' | 'beta';
export type ReleaseEnvironment = 'SIT' | 'PROD';

export interface ReleaseInput {
  version: ReleaseVersion;
  environment: ReleaseEnvironment;
  approved: boolean;
}

export interface TaskResult {
  taskId: string;
  outcome: TaskOutcome;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  message: string;
  findings?: Array<{
    severity: string;
    description: string;
  }>;
  checksum?: string;
}

export interface TaskExecution {
  outcome: TaskOutcome;
  message: string;
  findings?: TaskResult['findings'];
  checksum?: string;
}

const MAX_SLEEP_SECONDS = 10;

function getSleepSeconds(): number {
  const configuredSeconds = process.env.TASK_SLEEP_SECONDS;
  if (configuredSeconds === undefined) {
    return Math.floor(Math.random() * MAX_SLEEP_SECONDS) + 1;
  }

  const seconds =
    configuredSeconds.trim() === '' ? Number.NaN : Number(configuredSeconds);

  if (
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > MAX_SLEEP_SECONDS
  ) {
    throw new Error(
      `Invalid task sleep duration: ${seconds}; expected an integer with 0 <= seconds <= ${MAX_SLEEP_SECONDS}`,
    );
  }

  return seconds;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseReleaseInput(event: unknown): ReleaseInput {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new Error('Task event must be an object containing release input');
  }

  const input = event as Record<string, unknown>;

  if (input.version !== 'latest' && input.version !== 'beta') {
    throw new Error('Release input version must be latest or beta');
  }

  if (input.environment !== 'SIT' && input.environment !== 'PROD') {
    throw new Error('Release input environment must be SIT or PROD');
  }

  if (typeof input.approved !== 'boolean') {
    throw new Error('Release input approved must be a boolean');
  }

  return {
    version: input.version,
    environment: input.environment,
    approved: input.approved,
  };
}

export async function runTask(
  taskId: string,
  taskName: string,
  event: unknown,
  execute: (input: ReleaseInput) => TaskExecution,
): Promise<TaskResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  console.log(taskName);
  const input = parseReleaseInput(event);
  const sleepSeconds = getSleepSeconds();
  await sleep(sleepSeconds * 1000);

  const result = execute(input);
  const finishedAt = new Date().toISOString();

  return {
    taskId,
    outcome: result.outcome,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedAtMs,
    message: result.message,
    ...(result.findings === undefined ? {} : { findings: result.findings }),
    ...(result.checksum === undefined ? {} : { checksum: result.checksum }),
  };
}
