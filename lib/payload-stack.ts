// Defines the five multi-runtime release task functions.
import * as path from 'node:path';
import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import type { TaskId } from '../lambdas/shared/task-definitions';

export type TaskFunctions = Readonly<Record<TaskId, lambda.IFunction>>;

export class PayloadStack extends Stack {
  public readonly taskFunctions: TaskFunctions;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const lambdaTimeout = Duration.seconds(15);
    const lambdaRoot = path.join(__dirname, '..', 'lambdas');
    const taskLogGroup = (id: string) =>
      new logs.LogGroup(this, id, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.RETAIN,
      });

    const validationFunction = new NodejsFunction(this, 'ValidationFunction', {
      entry: path.join(lambdaRoot, 'a-validation', 'index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: lambdaTimeout,
      logGroup: taskLogGroup('ValidationLogGroup'),
    });

    const buildVerificationFunction = new NodejsFunction(
      this,
      'BuildVerificationFunction',
      {
        entry: path.join(lambdaRoot, 'b1-build-verify', 'index.ts'),
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: lambdaTimeout,
        logGroup: taskLogGroup('BuildVerificationLogGroup'),
      },
    );

    const artifactVerificationFunction = new lambda.Function(
      this,
      'ArtifactVerificationFunction',
      {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'handler.handler',
        code: lambda.Code.fromAsset(
          path.join(lambdaRoot, 'b2-artifact-verify'),
          { exclude: ['**/__pycache__/**', '**/*.pyc'] },
        ),
        timeout: lambdaTimeout,
        logGroup: taskLogGroup('ArtifactVerificationLogGroup'),
      },
    );

    const securityScanFunction = new lambda.DockerImageFunction(
      this,
      'SecurityScanFunction',
      {
        code: lambda.DockerImageCode.fromImageAsset(
          path.join(lambdaRoot, 'b3-security-scan'),
        ),
        timeout: lambdaTimeout,
        logGroup: taskLogGroup('SecurityScanLogGroup'),
      },
    );

    const releaseCompletionFunction = new NodejsFunction(
      this,
      'ReleaseCompletionFunction',
      {
        entry: path.join(lambdaRoot, 'c-release-complete', 'index.ts'),
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: lambdaTimeout,
        logGroup: taskLogGroup('ReleaseCompletionLogGroup'),
      },
    );

    this.taskFunctions = {
      A: validationFunction,
      B1: buildVerificationFunction,
      B2: artifactVerificationFunction,
      B3: securityScanFunction,
      C: releaseCompletionFunction,
    };

    Tags.of(this).add('project', 'release-orchestrator');
  }
}
