// Verifies API request validation, DynamoDB writes, and read responses.
import type { ApiEvent } from '../lambdas/api';

interface MockCommand {
  input: Record<string, unknown>;
}

const mockDynamoSend = jest.fn(
  async (_command: MockCommand): Promise<unknown> => ({}),
);

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDynamoSend })),
  },
  GetCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
  QueryCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
  TransactWriteCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

function apiEvent(
  overrides: Partial<ApiEvent>,
): ApiEvent {
  return {
    body: null,
    httpMethod: 'GET',
    isBase64Encoded: false,
    pathParameters: null,
    queryStringParameters: null,
    resource: '/workflows',
    ...overrides,
  };
}

function commandInput(command: MockCommand): Record<string, unknown> {
  return command.input;
}

describe('API Lambda handler', () => {
  const originalEnvironment = {
    tableName: process.env.TABLE_NAME,
    allowedOrigin: process.env.ALLOWED_ORIGIN,
  };
  let handler: (event: ApiEvent) => Promise<{
    statusCode: number;
    body: string;
  }>;

  beforeEach(() => {
    jest.resetModules();
    process.env.TABLE_NAME = 'workflow-table';
    process.env.ALLOWED_ORIGIN = 'https://dashboard.example';
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    ({ handler } = require('../lambdas/api'));
  });

  afterAll(() => {
    if (originalEnvironment.tableName === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = originalEnvironment.tableName;
    }
    if (originalEnvironment.allowedOrigin === undefined) {
      delete process.env.ALLOWED_ORIGIN;
    } else {
      process.env.ALLOWED_ORIGIN = originalEnvironment.allowedOrigin;
    }
  });

  it('creates META and all task records atomically for a valid release', async () => {
    const result = await handler(
      apiEvent({
        httpMethod: 'POST',
        body: JSON.stringify({
          version: 'latest',
          environment: 'SIT',
          approved: true,
          traceId: 'ignored',
        }),
      }),
    );

    expect(result.statusCode).toBe(202);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'RUNNING' });
    const transaction = mockDynamoSend.mock.calls[0][0] as MockCommand;
    const puts = commandInput(transaction).TransactItems as Array<{
      Put: { Item: Record<string, unknown> };
    }>;
    expect(puts).toHaveLength(6);
    expect(puts[0].Put.Item).toMatchObject({
      taskId: 'META',
      status: 'RUNNING',
      gsi1pk: 'WORKFLOW',
    });
    expect(puts[0].Put.Item.input).toEqual({
      version: 'latest',
      environment: 'SIT',
      approved: true,
    });
    expect(
      puts.slice(1).map(({ Put }) => Put.Item.status),
    ).toEqual(['PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING']);
  });

  it('rejects invalid input without writing to DynamoDB', async () => {
    const result = await handler(
      apiEvent({
        httpMethod: 'POST',
        body: JSON.stringify({
          version: 'stable',
          environment: 'SIT',
          approved: true,
        }),
      }),
    );

    expect(result.statusCode).toBe(400);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('lists workflows newest first through the GSI and returns a page token', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        {
          workflowId: 'workflow-1',
          taskId: 'META',
          status: 'RUNNING',
          input: { version: 'beta', environment: 'SIT', approved: true },
          createdAt: '2026-11-09T10:00:00.000Z',
        },
      ],
      LastEvaluatedKey: {
        workflowId: 'workflow-1',
        taskId: 'META',
        gsi1pk: 'WORKFLOW',
        gsi1sk: '2026-11-09T10:00:00.000Z',
      },
    });

    const result = await handler(apiEvent({}));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).workflows).toHaveLength(1);
    expect(JSON.parse(result.body).nextToken).toBeDefined();
    const query = mockDynamoSend.mock.calls[0][0] as MockCommand;
    expect(commandInput(query)).toMatchObject({
      IndexName: 'GSI1',
      ScanIndexForward: false,
      Limit: 25,
    });
  });

  it('returns workflow details with tasks in DAG definition order', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Item: {
          workflowId: 'workflow-1',
          taskId: 'META',
          status: 'RUNNING',
          input: { version: 'latest', environment: 'SIT', approved: true },
          createdAt: '2026-11-09T10:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({
        Items: [
          { taskId: 'B1', label: 'Build Verification', status: 'PENDING', dependencies: ['A'] },
          { taskId: 'A', label: 'Validation', status: 'COMPLETED', dependencies: [] },
          { taskId: 'B2', label: 'Artifact Verification', status: 'PENDING', dependencies: ['A'] },
          { taskId: 'B3', label: 'Security Scan', status: 'PENDING', dependencies: ['A'] },
          { taskId: 'C', label: 'Release Completion', status: 'PENDING', dependencies: ['B1', 'B2', 'B3'] },
        ],
      });

    const result = await handler(
      apiEvent({
        resource: '/workflows/{id}',
        pathParameters: { id: 'workflow-1' },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).tasks.map((task: { taskId: string }) => task.taskId))
      .toEqual(['A', 'B1', 'B2', 'B3', 'C']);
  });
});
