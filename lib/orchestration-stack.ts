// Defines workflow persistence and stream-driven Lambda orchestration.
import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import type { TaskFunctions } from './payload-stack';

export interface OrchestrationStackProps extends StackProps {
  taskFunctions: TaskFunctions;
}

export class OrchestrationStack extends Stack {
  public readonly workflowTable: dynamodb.Table;
  public readonly orchestratorFunction: NodejsFunction;
  public readonly workerFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    const { taskFunctions, ...stackProps } = props;
    super(scope, id, stackProps);

    this.workflowTable = new dynamodb.Table(this, 'WorkflowTable', {
      partitionKey: {
        name: 'workflowId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.workflowTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });

    const lambdaRoot = path.join(__dirname, '..', 'lambdas');
    this.workerFunction = new NodejsFunction(this, 'WorkerFunction', {
      entry: path.join(lambdaRoot, 'worker', 'index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'WorkerLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.RETAIN,
      }),
      environment: {
        TABLE_NAME: this.workflowTable.tableName,
        TASK_A_ARN: taskFunctions.A.functionArn,
        TASK_B1_ARN: taskFunctions.B1.functionArn,
        TASK_B2_ARN: taskFunctions.B2.functionArn,
        TASK_B3_ARN: taskFunctions.B3.functionArn,
        TASK_C_ARN: taskFunctions.C.functionArn,
      },
    });

    this.orchestratorFunction = new NodejsFunction(
      this,
      'OrchestratorFunction',
      {
        entry: path.join(lambdaRoot, 'orchestrator', 'index.ts'),
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'OrchestratorLogGroup', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.RETAIN,
        }),
        environment: {
          TABLE_NAME: this.workflowTable.tableName,
          WORKER_FUNCTION_ARN: this.workerFunction.functionArn,
        },
      },
    );

    this.workerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [this.workflowTable.tableArn],
      }),
    );
    this.orchestratorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [this.workflowTable.tableArn],
      }),
    );
    // DynamoDB Streams requires ListStreams on '*'; the other stream actions are scoped to this table's stream.
    this.workflowTable.grantStreamRead(this.orchestratorFunction);
    this.workerFunction.grantInvoke(this.orchestratorFunction);
    for (const taskFunction of Object.values(taskFunctions)) {
      taskFunction.grantInvoke(this.workerFunction);
    }

    this.orchestratorFunction.addEventSource(
      new DynamoEventSource(this.workflowTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 3,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
            dynamodb: {
              NewImage: {
                status: {
                  S: lambda.FilterRule.exists(),
                },
              },
            },
          }),
        ],
      }),
    );

    Tags.of(this).add('project', 'release-orchestrator');
  }
}
