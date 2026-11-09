// Defines the workflow REST API and private dashboard delivery infrastructure.
import * as path from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends StackProps {
  workflowTable: dynamodb.ITable;
}

export class MonitoringStack extends Stack {
  public readonly apiFunction: NodejsFunction;
  public readonly api: apigateway.RestApi;
  public readonly dashboardBucket: s3.Bucket;
  public readonly dashboardDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    const { workflowTable, ...stackProps } = props;
    super(scope, id, stackProps);

    this.dashboardBucket = new s3.Bucket(this, 'DashboardBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.dashboardDistribution = new cloudfront.Distribution(
      this,
      'DashboardDistribution',
      {
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(
            this.dashboardBucket,
          ),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        httpVersion: cloudfront.HttpVersion.HTTP2,
      },
    );

    const dashboardOrigin = `https://${this.dashboardDistribution.distributionDomainName}`;
    const lambdaRoot = path.join(__dirname, '..', 'lambdas');
    this.apiFunction = new NodejsFunction(this, 'ApiFunction', {
      entry: path.join(lambdaRoot, 'api', 'index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(15),
      logGroup: new logs.LogGroup(this, 'ApiLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.RETAIN,
      }),
      environment: {
        TABLE_NAME: workflowTable.tableName,
        ALLOWED_ORIGIN: dashboardOrigin,
      },
    });

    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:PutItem',
          'dynamodb:TransactWriteItems',
          'dynamodb:GetItem',
        ],
        resources: [workflowTable.tableArn],
      }),
    );
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [
          workflowTable.tableArn,
          `${workflowTable.tableArn}/index/GSI1`,
        ],
      }),
    );

    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.api = new apigateway.RestApi(this, 'WorkflowApi', {
      restApiName: 'release-workflow-api',
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.RETAIN,
      endpointConfiguration: {
        types: [apigateway.EndpointType.REGIONAL],
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [dashboardOrigin],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
        maxAge: Duration.minutes(10),
      },
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(
          apiAccessLogs,
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
      },
    });

    const workflows = this.api.root.addResource('workflows');
    const integration = new apigateway.LambdaIntegration(this.apiFunction);
    workflows.addMethod('POST', integration);
    workflows.addMethod('GET', integration);
    workflows.addResource('{id}').addMethod('GET', integration);

    new s3deploy.BucketDeployment(this, 'DeployDashboard', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', 'web')),
        s3deploy.Source.jsonData('config.json', { apiUrl: this.api.url }),
      ],
      destinationBucket: this.dashboardBucket,
      distribution: this.dashboardDistribution,
      distributionPaths: ['/*'],
      // The CDK deployment provider grants CloudFront invalidation polling against all distributions.
      logGroup: new logs.LogGroup(this, 'DashboardDeploymentLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.RETAIN,
      }),
      prune: true,
    });

    new CfnOutput(this, 'WorkflowApiUrl', {
      value: this.api.url,
    });
    new CfnOutput(this, 'DashboardUrl', {
      value: dashboardOrigin,
    });

    Tags.of(this).add('project', 'release-orchestrator');
  }
}
