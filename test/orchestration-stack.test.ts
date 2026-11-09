// Verifies workflow table, stream mapping, IAM, and Lambda configuration.
import { App } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { OrchestrationStack } from '../lib/orchestration-stack';
import { PayloadStack } from '../lib/payload-stack';

function createTemplate(): Template {
  const app = new App();
  const payloadStack = new PayloadStack(app, 'PayloadStack');
  const orchestrationStack = new OrchestrationStack(
    app,
    'OrchestrationStack',
    { taskFunctions: payloadStack.taskFunctions },
  );
  return Template.fromStack(orchestrationStack);
}

describe('OrchestrationStack', () => {
  it('creates the disposable on-demand workflow table and GSI stream', () => {
    const template = createTemplate();

    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
      Properties: Match.objectLike({
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'workflowId', KeyType: 'HASH' },
          { AttributeName: 'taskId', KeyType: 'RANGE' },
        ],
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        GlobalSecondaryIndexes: Match.arrayWith([
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'gsi1pk', KeyType: 'HASH' },
              { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ]),
      }),
    });
  });

  it('creates a filtered, retryable stream mapping to the Orchestrator', () => {
    const template = createTemplate();

    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.allResourcesProperties('AWS::Lambda::Function', {
      Timeout: 30,
    });

    template.resourceCountIs('AWS::Logs::LogGroup', 2);
    template.allResourcesProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 3,
      StartingPosition: 'LATEST',
      FilterCriteria: {
        Filters: Match.arrayWith([
          {
            Pattern: Match.stringLikeRegexp(
              'INSERT.*MODIFY.*dynamodb.*NewImage.*status',
            ),
          },
        ]),
      },
    });
  });
  it('limits table permissions and grants the Worker only the five task Lambdas', () => {
    const template = createTemplate();
    const resources = template.toJSON().Resources as Record<
      string,
      {
        Type: string;
        Properties?: {
          PolicyDocument?: {
            Statement?: Array<{
              Action: string | string[];
              Resource: unknown;
            }>;
          };
        };
      }
    >;
    const policies = Object.values(resources).filter(
      (resource) => resource.Type === 'AWS::IAM::Policy',
    );
    const statements = policies.flatMap(
      (policy) => policy.Properties?.PolicyDocument?.Statement ?? [],
    );
    const invokeStatements = statements.filter((statement) =>
      (Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action]
      ).includes('lambda:InvokeFunction'),
    );
    const getImportValues = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        return value.flatMap(getImportValues);
      }
      if (typeof value !== 'object' || value === null) {
        return [];
      }
      if ('Fn::ImportValue' in value && typeof value['Fn::ImportValue'] === 'string') {
        return [value['Fn::ImportValue']];
      }
      return Object.values(value).flatMap(getImportValues);
    };
    const workerTaskInvokes = invokeStatements.filter(
      (statement) => getImportValues(statement.Resource).length > 0,
    );
    expect(workerTaskInvokes).toHaveLength(5);
    expect(
      new Set(
        workerTaskInvokes.flatMap((statement) =>
          getImportValues(statement.Resource),
        ),
      ).size,
    ).toBe(5);
    expect(invokeStatements).toHaveLength(6);

    const tableStatements = statements.filter((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.some((action) => action.startsWith('dynamodb:'));
    });
    expect(
      [
        ...new Set(
          tableStatements.flatMap((statement) =>
            Array.isArray(statement.Action)
              ? statement.Action
              : [statement.Action],
          ),
        ),
      ].sort(),
    ).toEqual(
      [
        'dynamodb:DescribeStream',
        'dynamodb:GetItem',
        'dynamodb:GetRecords',
        'dynamodb:GetShardIterator',
        'dynamodb:ListStreams',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
      ].sort(),
    );
    const tableDataStatements = tableStatements.filter((statement) =>
      (Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action]
      ).some((action) => action !== 'dynamodb:ListStreams'),
    );
    expect(
      tableDataStatements.flatMap((statement) =>
        Array.isArray(statement.Resource)
          ? statement.Resource
          : [statement.Resource],
      ),
    ).not.toContain('*');

    const listStreamsStatement = tableStatements.find(
      (statement) => statement.Action === 'dynamodb:ListStreams',
    );
    expect(listStreamsStatement?.Resource).toBe('*');
  });
});
