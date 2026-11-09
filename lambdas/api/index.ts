// Implements the REST endpoints for creating, listing, and reading workflows.
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { TaskStatus, WorkflowStatus } from '../../lib/workflow-decision';
import {
  TASK_DEFINITIONS,
  type TaskId,
} from '../shared/task-definitions';
import type { ReleaseInput } from '../shared/task-utils';

const tableName = process.env.TABLE_NAME;
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? '';
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const pageSize = 25;
const workflowStatuses: readonly WorkflowStatus[] = [
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'FAILED',
];
const taskStatuses: readonly TaskStatus[] = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'FAILED',
  'SKIPPED',
];
export interface ApiEvent {
  body: string | null;
  httpMethod: string;
  isBase64Encoded: boolean;
  pathParameters: Record<string, string | undefined> | null;
  queryStringParameters: Record<string, string | undefined> | null;
  resource: string;
}

interface ApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface WorkflowMeta {
  workflowId: string;
  status: WorkflowStatus;
  input: ReleaseInput;
  createdAt: string;
  completedAt?: string;
}

interface WorkflowTask {
  taskId: TaskId;
  label: string;
  status: TaskStatus;
  dependencies: TaskId[];
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
  reason?: string;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReleaseInput(value: unknown): value is ReleaseInput {
  return (
    isRecord(value) &&
    (value.version === 'latest' || value.version === 'beta') &&
    (value.environment === 'SIT' || value.environment === 'PROD') &&
    typeof value.approved === 'boolean'
  );
}

function isTaskId(value: unknown): value is TaskId {
  return (
    typeof value === 'string' &&
    TASK_DEFINITIONS.some((definition) => definition.taskId === value)
  );
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return (
    typeof value === 'string' &&
    workflowStatuses.some((status) => status === value)
  );
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' && taskStatuses.some((status) => status === value)
  );
}

function parseJsonBody(event: ApiEvent): unknown {
  if (!event.body) {
    throw new HttpError(400, 'Request body is required');
  }
  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

function parseWorkflowMeta(value: unknown): WorkflowMeta {
  if (
    !isRecord(value) ||
    typeof value.workflowId !== 'string' ||
    value.taskId !== 'META' ||
    !isWorkflowStatus(value.status) ||
    !isReleaseInput(value.input) ||
    typeof value.createdAt !== 'string' ||
    (value.completedAt !== undefined && typeof value.completedAt !== 'string')
  ) {
    throw new Error('Workflow table contains an invalid META item');
  }
  return {
    workflowId: value.workflowId,
    status: value.status,
    input: value.input,
    createdAt: value.createdAt,
    ...(value.completedAt === undefined
      ? {}
      : { completedAt: value.completedAt }),
  };
}

function parseWorkflowTask(value: unknown): WorkflowTask {
  if (
    !isRecord(value) ||
    !isTaskId(value.taskId) ||
    typeof value.label !== 'string' ||
    !isTaskStatus(value.status) ||
    !Array.isArray(value.dependencies) ||
    !value.dependencies.every(isTaskId) ||
    (value.startedAt !== undefined && typeof value.startedAt !== 'string') ||
    (value.finishedAt !== undefined && typeof value.finishedAt !== 'string') ||
    (value.reason !== undefined && typeof value.reason !== 'string') ||
    (value.result !== undefined && !isRecord(value.result))
  ) {
    throw new Error('Workflow table contains an invalid task item');
  }
  return {
    taskId: value.taskId,
    label: value.label,
    status: value.status,
    dependencies: value.dependencies,
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

function encodeNextToken(
  key: Record<string, unknown> | undefined,
): string | undefined {
  return key === undefined
    ? undefined
    : Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeNextToken(
  token: string | undefined,
): Record<string, unknown> | undefined {
  if (token === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    );
    if (
      isRecord(value) &&
      value.gsi1pk === 'WORKFLOW' &&
      typeof value.gsi1sk === 'string' &&
      typeof value.workflowId === 'string' &&
      value.taskId === 'META'
    ) {
      return value;
    }
  } catch {
    // Invalid tokens are reported as client errors below.
  }
  throw new HttpError(400, 'Invalid nextToken');
}

function response(statusCode: number, body: unknown): ApiResult {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

async function createWorkflow(event: ApiEvent): Promise<ApiResult> {
  const input = parseJsonBody(event);
  if (!isReleaseInput(input)) {
    throw new HttpError(
      400,
      'Input must contain version (latest or beta), environment (SIT or PROD), and boolean approved',
    );
  }
  if (!tableName) {
    throw new Error('API Lambda requires TABLE_NAME');
  }

  const releaseInput: ReleaseInput = {
    version: input.version,
    environment: input.environment,
    approved: input.approved,
  };
  const workflowId = randomUUID();
  const createdAt = new Date().toISOString();
  const items = [
    {
      workflowId,
      taskId: 'META',
      status: 'RUNNING',
      input: releaseInput,
      createdAt,
      gsi1pk: 'WORKFLOW',
      gsi1sk: createdAt,
    },
    ...TASK_DEFINITIONS.map((definition) => ({
      workflowId,
      taskId: definition.taskId,
      label: definition.label,
      status: 'PENDING',
      dependencies: [...definition.dependencies],
    })),
  ];

  await dynamo.send(
    new TransactWriteCommand({
      TransactItems: items.map((Item) => ({
        Put: {
          TableName: tableName,
          Item,
          ConditionExpression:
            'attribute_not_exists(workflowId) AND attribute_not_exists(taskId)',
        },
      })),
    }),
  );
  return response(202, { workflowId, status: 'RUNNING', createdAt });
}

async function listWorkflows(event: ApiEvent): Promise<ApiResult> {
  if (!tableName) {
    throw new Error('API Lambda requires TABLE_NAME');
  }
  const exclusiveStartKey = decodeNextToken(
    event.queryStringParameters?.nextToken,
  );
  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :partitionKey',
      ExpressionAttributeValues: { ':partitionKey': 'WORKFLOW' },
      ScanIndexForward: false,
      Limit: pageSize,
      ...(exclusiveStartKey === undefined
        ? {}
        : { ExclusiveStartKey: exclusiveStartKey }),
    }),
  );
  const workflows = (result.Items ?? [])
    .map(parseWorkflowMeta)
    .map(({ workflowId, status, input, createdAt, completedAt }) => ({
      workflowId,
      status,
      input,
      createdAt,
      ...(completedAt === undefined ? {} : { completedAt }),
    }));
  const nextToken = encodeNextToken(result.LastEvaluatedKey);
  return response(200, {
    workflows,
    ...(nextToken === undefined ? {} : { nextToken }),
  });
}

async function getWorkflow(workflowId: string): Promise<ApiResult> {
  if (!tableName) {
    throw new Error('API Lambda requires TABLE_NAME');
  }
  const metaResult = await dynamo.send(
    new GetCommand({
      TableName: tableName,
      Key: { workflowId, taskId: 'META' },
      ConsistentRead: true,
    }),
  );
  if (metaResult.Item === undefined) {
    throw new HttpError(404, 'Workflow not found');
  }

  const meta = parseWorkflowMeta(metaResult.Item);
  const taskResult = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'workflowId = :workflowId',
      ExpressionAttributeValues: {
        ':workflowId': workflowId,
      },
      ConsistentRead: true,
    }),
  );
  const taskById = new Map(
    (taskResult.Items ?? [])
      .filter((item) => item.taskId !== 'META')
      .map((item) => {
        const task = parseWorkflowTask(item);
        return [task.taskId, task] as const;
      }),
  );
  const tasks = TASK_DEFINITIONS.map((definition) => {
    const task = taskById.get(definition.taskId);
    if (!task) {
      throw new Error(
        `Workflow ${workflowId} is missing task ${definition.taskId}`,
      );
    }
    return task;
  });
  return response(200, { ...meta, tasks });
}

export const handler = async (event: ApiEvent): Promise<ApiResult> => {
  try {
    if (event.httpMethod === 'POST' && event.resource === '/workflows') {
      return await createWorkflow(event);
    }
    if (event.httpMethod === 'GET' && event.resource === '/workflows') {
      return await listWorkflows(event);
    }
    if (
      event.httpMethod === 'GET' &&
      event.resource === '/workflows/{id}' &&
      typeof event.pathParameters?.id === 'string'
    ) {
      return await getWorkflow(event.pathParameters.id);
    }
    return response(404, { message: 'Route not found' });
  } catch (error) {
    if (error instanceof HttpError) {
      return response(error.statusCode, { message: error.message });
    }
    console.error('API request failed', error);
    return response(500, { message: 'Internal server error' });
  }
};
