// Coordinates task state transitions from stream events and direct re-drives.
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  deriveWorkflowStatus,
  decidePendingTasks,
  TaskState,
  TaskStatus,
  WorkflowStatus,
} from '../../lib/workflow-decision';
import { TASK_DEFINITIONS } from '../shared/task-definitions';

const tableName = process.env.TABLE_NAME;
const workerFunctionArn = process.env.WORKER_FUNCTION_ARN;
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

interface WorkflowItem {
  workflowId: string;
  taskId: string;
  status: string;
  dependencies?: unknown;
  workerClaimedAt?: string;
}

const staleWorkerClaimMs = 2 * 60 * 1000;

const taskStatuses: readonly TaskStatus[] = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'FAILED',
  'SKIPPED',
];

const workflowStatuses: readonly WorkflowStatus[] = [
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'FAILED',
];

function isTaskStatus(value: string): value is TaskStatus {
  return taskStatuses.some((status) => status === value);
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return workflowStatuses.some((status) => status === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getWorkflowIds(event: unknown): string[] {
  if (!isRecord(event)) {
    throw new Error('Orchestrator event must be an object');
  }

  if (typeof event.workflowId === 'string' && event.workflowId.length > 0) {
    return [event.workflowId];
  }

  if (!Array.isArray(event.Records)) {
    throw new Error(
      'Orchestrator event must contain workflowId or DynamoDB stream Records',
    );
  }

  const workflowIds = new Set<string>();
  for (const candidate of event.Records) {
    if (!isRecord(candidate)) {
      continue;
    }
    if (candidate.eventName !== 'INSERT' && candidate.eventName !== 'MODIFY') {
      continue;
    }

    const dynamodb = candidate.dynamodb;
    if (!isRecord(dynamodb) || !isRecord(dynamodb.Keys)) {
      continue;
    }
    const workflowIdKey = dynamodb.Keys.workflowId;
    if (!isRecord(workflowIdKey)) {
      continue;
    }
    const workflowId = workflowIdKey.S;
    if (typeof workflowId === 'string' && workflowId.length > 0) {
      workflowIds.add(workflowId);
    }
  }

  return [...workflowIds];
}

function parseWorkflowItem(value: unknown): WorkflowItem {
  if (
    !isRecord(value) ||
    typeof value.workflowId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.status !== 'string' ||
    (value.workerClaimedAt !== undefined &&
      typeof value.workerClaimedAt !== 'string')
  ) {
    throw new Error('Workflow table contains an invalid item');
  }
  return {
    workflowId: value.workflowId,
    taskId: value.taskId,
    status: value.status,
    dependencies: value.dependencies,
    ...(value.workerClaimedAt === undefined
      ? {}
      : { workerClaimedAt: value.workerClaimedAt }),
  };
}

function toTaskState(item: WorkflowItem): TaskState {
  if (!isTaskStatus(item.status)) {
    throw new Error(`Unknown status for task ${item.taskId}: ${item.status}`);
  }
  if (
    !Array.isArray(item.dependencies) ||
    !item.dependencies.every(
      (dependency): dependency is string => typeof dependency === 'string',
    )
  ) {
    throw new Error(`Task ${item.taskId} has invalid dependencies`);
  }

  return {
    taskId: item.taskId,
    status: item.status,
    dependencies: item.dependencies,
  };
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof ConditionalCheckFailedException;
}

async function updatePendingTask(
  workflowId: string,
  taskId: string,
  status: 'RUNNING' | 'SKIPPED',
  reason?: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = {
    ':pending': 'PENDING',
    ':status': status,
    ':now': now,
  };
  let updateExpression = 'SET #status = :status, finishedAt = :now';

  if (status === 'RUNNING') {
    updateExpression = 'SET #status = :status, startedAt = :now';
  } else if (reason !== undefined) {
    values[':reason'] = reason;
    updateExpression += ', reason = :reason';
  }

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { workflowId, taskId },
        UpdateExpression: updateExpression,
        ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
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

async function failRunningTask(
  workflowId: string,
  taskId: string,
  reason: string,
): Promise<boolean> {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { workflowId, taskId },
        UpdateExpression:
          'SET #status = :failed, finishedAt = :finishedAt, reason = :reason',
        ConditionExpression:
          '#status = :running AND attribute_not_exists(workerClaimedAt)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':failed': 'FAILED',
          ':running': 'RUNNING',
          ':finishedAt': new Date().toISOString(),
          ':reason': reason,
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

async function releaseStaleWorkerClaim(
  workflowId: string,
  task: WorkflowItem,
): Promise<boolean> {
  if (!task.workerClaimedAt) {
    return false;
  }
  const claimedAt = Date.parse(task.workerClaimedAt);
  if (Number.isNaN(claimedAt)) {
    throw new Error(`Task ${task.taskId} has an invalid worker claim time`);
  }
  if (Date.now() - claimedAt <= staleWorkerClaimMs) {
    return false;
  }

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { workflowId, taskId: task.taskId },
        UpdateExpression: 'REMOVE workerClaimedAt',
        ConditionExpression:
          '#status = :running AND workerClaimedAt = :workerClaimedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':running': 'RUNNING',
          ':workerClaimedAt': task.workerClaimedAt,
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

async function dispatchWorker(workflowId: string, taskId: string): Promise<void> {
  try {
    const response = await lambda.send(
      new InvokeCommand({
        FunctionName: workerFunctionArn,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ workflowId, taskId })),
      }),
    );
    if (response.StatusCode !== 202) {
      throw new Error(
        `Worker invocation returned status ${response.StatusCode ?? 'unknown'}`,
      );
    }
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Unknown Worker invocation error';
    console.error(`Unable to dispatch task ${taskId}: ${reason}`);
    await failRunningTask(workflowId, taskId, reason);
  }
}

async function updateWorkflowStatus(
  workflowId: string,
  currentStatus: string,
  nextStatus: WorkflowStatus,
): Promise<void> {
  if (!isWorkflowStatus(currentStatus)) {
    throw new Error(`Unknown workflow status: ${currentStatus}`);
  }
  if (currentStatus === nextStatus) {
    return;
  }
  if (currentStatus !== 'RUNNING') {
    throw new Error(
      `Workflow ${workflowId} cannot transition from ${currentStatus} to ${nextStatus}`,
    );
  }

  const values: Record<string, unknown> = {
    ':currentStatus': currentStatus,
    ':nextStatus': nextStatus,
  };
  let updateExpression = 'SET #status = :nextStatus';
  if (nextStatus !== 'RUNNING') {
    values[':completedAt'] = new Date().toISOString();
    updateExpression += ', completedAt = :completedAt';
  }

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { workflowId, taskId: 'META' },
        UpdateExpression: updateExpression,
        ConditionExpression: '#status = :currentStatus',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: values,
      }),
    );
  } catch (error) {
    if (!isConditionalFailure(error)) {
      throw error;
    }
  }
}

async function processWorkflow(workflowId: string): Promise<void> {
  if (!tableName || !workerFunctionArn) {
    throw new Error('Orchestrator requires TABLE_NAME and WORKER_FUNCTION_ARN');
  }

  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'workflowId = :workflowId',
      ExpressionAttributeValues: { ':workflowId': workflowId },
      ConsistentRead: true,
    }),
  );
  const items = (result.Items ?? []).map(parseWorkflowItem);
  const meta = items.find((item) => item.taskId === 'META');
  if (!meta) {
    throw new Error(`Workflow ${workflowId} has no META item`);
  }

  const taskItems = items.filter((item) => item.taskId !== 'META');
  if (taskItems.length !== TASK_DEFINITIONS.length) {
    throw new Error(
      `Workflow ${workflowId} has ${taskItems.length} task items; expected ${TASK_DEFINITIONS.length}`,
    );
  }
  const byId = new Map(taskItems.map((item) => [item.taskId, item]));
  for (const definition of TASK_DEFINITIONS) {
    if (!byId.has(definition.taskId)) {
      throw new Error(
        `Workflow ${workflowId} is missing task ${definition.taskId}`,
      );
    }
  }

  const taskStates = taskItems.map(toTaskState);
  const decisions = decidePendingTasks(taskStates);
  const currentStatusByTaskId = new Map(
    taskStates.map((task) => [task.taskId, task.status]),
  );

  for (const skipped of decisions.skippedTasks) {
    if (
      await updatePendingTask(
        workflowId,
        skipped.taskId,
        'SKIPPED',
        skipped.reason,
      )
    ) {
      currentStatusByTaskId.set(skipped.taskId, 'SKIPPED');
    }
  }

  for (const taskId of decisions.readyTaskIds) {
    if (
      await updatePendingTask(workflowId, taskId, 'RUNNING')
    ) {
      currentStatusByTaskId.set(taskId, 'RUNNING');
    }
  }

  for (const task of taskItems) {
    if (
      task.status === 'RUNNING' &&
      task.workerClaimedAt &&
      (await releaseStaleWorkerClaim(workflowId, task))
    ) {
      delete task.workerClaimedAt;
    }
  }

  const tasksToDispatch = taskItems.filter(
    (task) =>
      (task.status === 'RUNNING' && !task.workerClaimedAt) ||
      (decisions.readyTaskIds.includes(task.taskId) &&
        currentStatusByTaskId.get(task.taskId) === 'RUNNING'),
  );
  for (const task of tasksToDispatch) {
    await dispatchWorker(workflowId, task.taskId);
  }

  const updatedStatuses = taskStates.map(
    (task) => currentStatusByTaskId.get(task.taskId) ?? task.status,
  );
  const workflowStatus = deriveWorkflowStatus(updatedStatuses);
  await updateWorkflowStatus(workflowId, meta.status, workflowStatus);
}

export const handler = async (event: unknown): Promise<void> => {
  const workflowIds = getWorkflowIds(event);
  for (const workflowId of workflowIds) {
    await processWorkflow(workflowId);
  }
};
