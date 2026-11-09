// Verifies orchestration behavior with mocked DynamoDB and Lambda clients.
interface MockCommand {
  input: Record<string, unknown>;
}

const mockDynamoSend = jest.fn(
  async (_command: MockCommand): Promise<unknown> => ({}),
);
const mockLambdaSend = jest.fn(
  async (_command: MockCommand): Promise<unknown> => ({}),
);

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
  ConditionalCheckFailedException: class extends Error {},
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
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
  UpdateCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

const taskItems = [
  { workflowId: 'workflow-1', taskId: 'A', status: 'PENDING', dependencies: [] },
  { workflowId: 'workflow-1', taskId: 'B1', status: 'PENDING', dependencies: ['A'] },
  { workflowId: 'workflow-1', taskId: 'B2', status: 'PENDING', dependencies: ['A'] },
  { workflowId: 'workflow-1', taskId: 'B3', status: 'PENDING', dependencies: ['A'] },
  {
    workflowId: 'workflow-1',
    taskId: 'C',
    status: 'PENDING',
    dependencies: ['B1', 'B2', 'B3'],
  },
];

function commandInput(command: MockCommand): Record<string, unknown> {
  return command.input;
}

describe('orchestration Lambda handlers', () => {
  const originalEnvironment = {
    tableName: process.env.TABLE_NAME,
    workerFunctionArn: process.env.WORKER_FUNCTION_ARN,
    taskAArn: process.env.TASK_A_ARN,
  };
  let orchestratorHandler: (event: unknown) => Promise<void>;
  let workerHandler: (event: unknown) => Promise<void>;

  beforeEach(() => {
    jest.resetModules();
    process.env.TABLE_NAME = 'workflow-table';
    process.env.WORKER_FUNCTION_ARN = 'worker-arn';
    process.env.TASK_A_ARN = 'task-a-arn';
    mockDynamoSend.mockReset();
    mockLambdaSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
    mockLambdaSend.mockResolvedValue({ StatusCode: 202 });
    ({ handler: orchestratorHandler } = require('../lambdas/orchestrator'));
    ({ handler: workerHandler } = require('../lambdas/worker'));
  });

  afterAll(() => {
    if (originalEnvironment.tableName === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = originalEnvironment.tableName;
    }
    if (originalEnvironment.workerFunctionArn === undefined) {
      delete process.env.WORKER_FUNCTION_ARN;
    } else {
      process.env.WORKER_FUNCTION_ARN = originalEnvironment.workerFunctionArn;
    }
    if (originalEnvironment.taskAArn === undefined) {
      delete process.env.TASK_A_ARN;
    } else {
      process.env.TASK_A_ARN = originalEnvironment.taskAArn;
    }
  });

  it('conditionally starts A and asynchronously dispatches the Worker', async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        { workflowId: 'workflow-1', taskId: 'META', status: 'RUNNING' },
        ...taskItems,
      ],
    });
    mockLambdaSend.mockResolvedValue({ StatusCode: 202 });

    await orchestratorHandler({ workflowId: 'workflow-1' });

    const update = mockDynamoSend.mock.calls
      .map(([command]) => command as MockCommand)
      .find((command) => command.constructor.name === 'UpdateCommand');
    expect(update).toBeDefined();
    expect(commandInput(update!).ConditionExpression).toBe('#status = :pending');
    expect(commandInput(update!).Key).toEqual({
      workflowId: 'workflow-1',
      taskId: 'A',
    });
    const query = mockDynamoSend.mock.calls
      .map(([command]) => command as MockCommand)
      .find((command) => command.constructor.name === 'QueryCommand');
    expect(commandInput(query!).ConsistentRead).toBe(true);

    const workerInvocation = mockLambdaSend.mock.calls[0][0] as MockCommand;
    expect(commandInput(workerInvocation)).toMatchObject({
      FunctionName: 'worker-arn',
      InvocationType: 'Event',
    });
    expect(
      JSON.parse(
        Buffer.from(
          commandInput(workerInvocation).Payload as Uint8Array,
        ).toString('utf8'),
      ),
    ).toEqual({ workflowId: 'workflow-1', taskId: 'A' });
  });

  it('deduplicates workflow IDs from irrelevant and repeated stream records', async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        { workflowId: 'workflow-1', taskId: 'META', status: 'RUNNING' },
        ...taskItems,
      ],
    });

    await orchestratorHandler({
      Records: [
        {
          eventName: 'REMOVE',
          dynamodb: { Keys: { workflowId: { S: 'removed' } } },
        },
        {
          eventName: 'MODIFY',
          dynamodb: { Keys: { workflowId: { S: 'workflow-1' } } },
        },
        {
          eventName: 'INSERT',
          dynamodb: { Keys: { workflowId: { S: 'workflow-1' } } },
        },
      ],
    });

    expect(
      mockDynamoSend.mock.calls.filter(
        ([command]) => (command as MockCommand).constructor.name === 'QueryCommand',
      ),
    ).toHaveLength(1);
  });

  it('marks dependents skipped when A has failed and derives workflow failure', async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        { workflowId: 'workflow-1', taskId: 'META', status: 'RUNNING' },
        { ...taskItems[0], status: 'FAILED' },
        ...taskItems.slice(1),
      ],
    });

    await orchestratorHandler({ workflowId: 'workflow-1' });

    const updates = mockDynamoSend.mock.calls
      .map(([command]) => command as MockCommand)
      .filter((command) => command.constructor.name === 'UpdateCommand')
      .map(commandInput);
    expect(
      updates.filter(
        (update) =>
          (update.ExpressionAttributeValues as Record<string, unknown>)[
            ':status'
          ] === 'SKIPPED',
      ),
    ).toHaveLength(4);
    expect(
      updates.some(
        (update) =>
          (update.Key as Record<string, unknown>).taskId === 'META' &&
          (update.ExpressionAttributeValues as Record<string, unknown>)[
            ':nextStatus'
          ] === 'FAILED',
      ),
    ).toBe(true);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('releases stale worker claims on direct re-drive', async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        { workflowId: 'workflow-1', taskId: 'META', status: 'RUNNING' },
        {
          ...taskItems[0],
          status: 'RUNNING',
          workerClaimedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
        },
        ...taskItems.slice(1),
      ],
    });
    mockLambdaSend.mockResolvedValue({ StatusCode: 202 });

    await orchestratorHandler({ workflowId: 'workflow-1' });

    const releaseClaim = mockDynamoSend.mock.calls
      .map(([command]) => command as MockCommand)
      .find(
        (command) =>
          command.constructor.name === 'UpdateCommand' &&
          commandInput(command).UpdateExpression === 'REMOVE workerClaimedAt',
      );
    expect(releaseClaim).toBeDefined();
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        Buffer.from(
          (mockLambdaSend.mock.calls[0][0] as MockCommand).input
            .Payload as Uint8Array,
        ).toString('utf8'),
      ),
    ).toEqual({ workflowId: 'workflow-1', taskId: 'A' });
  });

  it('claims a task, invokes its Lambda synchronously, and stores its result', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: {
          input: { version: 'latest', environment: 'SIT', approved: true },
        },
      })
      .mockResolvedValueOnce({});
    mockLambdaSend.mockResolvedValue({
      StatusCode: 200,
      Payload: Buffer.from(
        JSON.stringify({
          taskId: 'A',
          outcome: 'SUCCESS',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
          durationMs: 1000,
          message: 'passed',
        }),
      ),
    });

    await workerHandler({ workflowId: 'workflow-1', taskId: 'A' });

    const taskInvocation = mockLambdaSend.mock.calls[0][0] as MockCommand;
    expect(commandInput(taskInvocation)).toMatchObject({
      FunctionName: 'task-a-arn',
      InvocationType: 'RequestResponse',
    });
    expect(
      commandInput(mockDynamoSend.mock.calls[1][0] as MockCommand)
        .ConsistentRead,
    ).toBe(true);
    const completion = mockDynamoSend.mock.calls[2][0] as MockCommand;
    expect(commandInput(completion).ConditionExpression).toBe(
      '#status = :running AND attribute_exists(workerClaimedAt)',
    );
    expect(commandInput(completion).ExpressionAttributeValues).toMatchObject({
      ':status': 'COMPLETED',
    });
  });

  it('does not re-run a task when a duplicate Worker invocation cannot claim it', async () => {
    const { ConditionalCheckFailedException } = require('@aws-sdk/client-dynamodb');
    mockDynamoSend.mockRejectedValueOnce(
      new ConditionalCheckFailedException('Already claimed'),
    );
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await workerHandler({ workflowId: 'workflow-1', taskId: 'A' });

    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});
