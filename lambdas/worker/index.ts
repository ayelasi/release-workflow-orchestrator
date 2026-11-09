// Claims and executes tasks, then persists task and workflow outcomes.
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ReleaseInput, TaskOutcome, TaskResult } from '../shared/task-utils';
import type { TaskId } from '../shared/task-definitions';

const tableName = process.env.TABLE_NAME;
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

interface WorkerEvent {
  workflowId: string;
  taskId: TaskId;
}

function isReleaseInput(value: unknown): value is ReleaseInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return (
    (input.version === 'latest' || input.version === 'beta') &&
    (input.environment === 'SIT' || input.environment === 'PROD') &&
    typeof input.approved === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFinding(
  value: unknown,
): value is NonNullable<TaskResult['findings']>[number] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'severity' in value &&
    typeof value.severity === 'string' &&
    'description' in value &&
    typeof value.description === 'string'
  );
}

const taskIds: readonly TaskId[] = ['A', 'B1', 'B2', 'B3', 'C'];

function isTaskId(value: string): value is TaskId {
  return taskIds.some((taskId) => taskId === value);
}

function parseWorkerEvent(event: unknown): WorkerEvent {
  if (!isRecord(event)) {
    throw new Error('Worker event must contain workflowId and taskId');
  }
  if (
    typeof event.workflowId !== 'string' ||
    event.workflowId.length === 0 ||
    typeof event.taskId !== 'string' ||
    !isTaskId(event.taskId)
  ) {
    throw new Error('Worker event must contain a valid workflowId and taskId');
  }
  return {
    workflowId: event.workflowId,
    taskId: event.taskId,
  };
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof ConditionalCheckFailedException;
}

function getTaskFunctionArn(taskId: TaskId): string {
  const environmentName = `TASK_${taskId}_ARN`;
  const functionArn = process.env[environmentName];
  if (!functionArn) {
    throw new Error(`Worker is missing ${environmentName}`);
  }
  return functionArn;
}

async function claimTask(workflowId: string, taskId: TaskId): Promise<boolean> {
  if (!tableName) {
    throw new Error('Worker requires TABLE_NAME');
  }
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { workflowId, taskId },
        UpdateExpression: 'SET workerClaimedAt = :workerClaimedAt',
        ConditionExpression:
          '#status = :running AND attribute_not_exists(workerClaimedAt)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':running': 'RUNNING',
          ':workerClaimedAt': new Date().toISOString(),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) {
      return false;
    }
    throw error;
  }
}

async function finishTask(
  workflowId: string,
  taskId: TaskId,
  status: 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'FAILED',
  result?: TaskResult,
  reason?: string,
): Promise<void> {
  const expressionValues: Record<string, unknown> = {
    ':running': 'RUNNING',
    ':status': status,
    ':finishedAt': new Date().toISOString(),
  };
  let updateExpression =
    'SET #status = :status, finishedAt = :finishedAt';
  if (result !== undefined) {
    expressionValues[':result'] = result;
    updateExpression += ', #result = :result';
  }
  if (reason !== undefined) {
    expressionValues[':reason'] = reason;
    updateExpression += ', reason = :reason';
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { workflowId, taskId },
      UpdateExpression: updateExpression,
      ConditionExpression:
        '#status = :running AND attribute_exists(workerClaimedAt)',
      ExpressionAttributeNames: {
        '#status': 'status',
        ...(result === undefined ? {} : { '#result': 'result' }),
      },
      ExpressionAttributeValues: expressionValues,
    }),
  );
}

function parseTaskResult(payload: Uint8Array | undefined, taskId: TaskId): TaskResult {
  if (!payload || payload.length === 0) {
    throw new Error(`Task ${taskId} returned an empty payload`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as unknown;
  } catch {
    throw new Error(`Task ${taskId} returned invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Task ${taskId} returned an invalid result`);
  }

  const result = parsed;
  if (
    result.taskId !== taskId ||
    (result.outcome !== 'SUCCESS' &&
      result.outcome !== 'WARNING' &&
      result.outcome !== 'FAILURE') ||
    typeof result.startedAt !== 'string' ||
    typeof result.finishedAt !== 'string' ||
    typeof result.durationMs !== 'number' ||
    typeof result.message !== 'string'
  ) {
    throw new Error(`Task ${taskId} returned invalid execution metadata`);
  }
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
    throw new Error(`Task ${taskId} returned an invalid duration`);
  }

  let findings: TaskResult['findings'];
  if (
    result.findings !== undefined &&
    (!Array.isArray(result.findings) ||
      !result.findings.every(isFinding))
  ) {
    throw new Error(`Task ${taskId} returned invalid findings`);
  }
  if (Array.isArray(result.findings)) {
    findings = result.findings;
  }
  if (result.checksum !== undefined && typeof result.checksum !== 'string') {
    throw new Error(`Task ${taskId} returned an invalid checksum`);
  }

  return {
    taskId,
    outcome: result.outcome,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    message: result.message,
    ...(findings === undefined ? {} : { findings }),
    ...(result.checksum === undefined ? {} : { checksum: result.checksum }),
  };
}

function mapOutcome(outcome: TaskOutcome): 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'FAILED' {
  switch (outcome) {
    case 'SUCCESS':
      return 'COMPLETED';
    case 'WARNING':
      return 'COMPLETED_WITH_WARNINGS';
    case 'FAILURE':
      return 'FAILED';
  }
}

async function executeTask(
  workflowId: string,
  taskId: TaskId,
): Promise<void> {
  if (!tableName) {
    throw new Error('Worker requires TABLE_NAME');
  }

  const metaResult = await dynamo.send(
    new GetCommand({
      TableName: tableName,
      Key: { workflowId, taskId: 'META' },
      ProjectionExpression: '#input',
      ExpressionAttributeNames: { '#input': 'input' },
      ConsistentRead: true,
    }),
  );
  const input = isRecord(metaResult.Item)
    ? metaResult.Item.input
    : undefined;
  if (!isReleaseInput(input)) {
    throw new Error(`Workflow ${workflowId} has no release input`);
  }

  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: getTaskFunctionArn(taskId),
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(input)),
    }),
  );
  if (response.StatusCode !== 200 || response.FunctionError) {
    throw new Error(
      `Task ${taskId} invocation failed${response.FunctionError ? ` (${response.FunctionError})` : ''}`,
    );
  }

  const result = parseTaskResult(response.Payload, taskId);
  await finishTask(
    workflowId,
    taskId,
    mapOutcome(result.outcome),
    result,
    result.outcome === 'FAILURE' ? result.message : undefined,
  );
  console.log(`Task ${taskId} finished with ${result.outcome}`);
}

export const handler = async (event: unknown): Promise<void> => {
  const { workflowId, taskId } = parseWorkerEvent(event);
  if (!(await claimTask(workflowId, taskId))) {
    console.log(`Task ${taskId} is no longer claimable; ignoring duplicate`);
    return;
  }

  try {
    await executeTask(workflowId, taskId);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Unknown task execution error';
    console.error(`Task ${taskId} failed: ${reason}`);
    await finishTask(workflowId, taskId, 'FAILED', undefined, reason);
  }
};
