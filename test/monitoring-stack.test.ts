// Verifies MonitoringStack resources, routes, and permissions.
import { App } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { MonitoringStack } from '../lib/monitoring-stack';
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
  const monitoringStack = new MonitoringStack(app, 'MonitoringStack', {
    workflowTable: orchestrationStack.workflowTable,
  });
  return Template.fromStack(monitoringStack);
}

describe('MonitoringStack', () => {
  it('creates a regional Lambda proxy API with the three required routes', () => {
    const template = createTemplate();

    template.resourceCountIs('AWS::ApiGateway::Account', 1);
    template.hasResourceProperties('AWS::ApiGateway::Account', {
      CloudWatchRoleArn: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Principal: { Service: 'apigateway.amazonaws.com' },
          }),
        ]),
      }),
      ManagedPolicyArns: Match.arrayWith([
        {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
            ],
          ],
        },
      ]),
    });
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
    template.resourceCountIs('AWS::ApiGateway::Method', 6);
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      Integration: Match.objectLike({
        Type: 'AWS_PROXY',
        IntegrationHttpMethod: 'POST',
      }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
          ALLOWED_ORIGIN: Match.anyValue(),
        }),
      },
    });
    template.allResourcesProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });

    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; DependsOn?: string[] }
    >;
    const accountLogicalId = Object.entries(resources).find(
      ([, resource]) => resource.Type === 'AWS::ApiGateway::Account',
    )?.[0];
    const stage = Object.values(resources).find(
      (resource) => resource.Type === 'AWS::ApiGateway::Stage',
    );
    expect(accountLogicalId).toBeDefined();
    expect(stage?.DependsOn).toContain(accountLogicalId);
    expect(
      Object.entries(resources).find(
        ([logicalId]) => logicalId.includes('WorkflowApiCloudWatchRole'),
      )?.[1],
    ).toMatchObject({
      Type: 'AWS::IAM::Role',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
  it('hosts the dashboard in a private S3 bucket with CloudFront OAC', () => {
    const template = createTemplate();

    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
      }),
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          },
        ],
      },
    });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'cloudfront.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  it('scopes API table access to required actions and table resources', () => {
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
    const statements = Object.values(resources)
      .filter((resource) => resource.Type === 'AWS::IAM::Policy')
      .flatMap(
        (policy) => policy.Properties?.PolicyDocument?.Statement ?? [],
      );
    const dynamoStatements = statements.filter((statement) =>
      (Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action]
      ).some((action) => action.startsWith('dynamodb:')),
    );

    expect(
      dynamoStatements.flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action],
      ).sort(),
    ).toEqual(
      [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:TransactWriteItems',
      ].sort(),
    );
    expect(
      dynamoStatements.flatMap((statement) =>
        Array.isArray(statement.Resource)
          ? statement.Resource
          : [statement.Resource],
      ),
    ).not.toContain('*');
  });
});
