"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SageMakerDomainStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = require("aws-cdk-lib/aws-iam");
const aws_kms_1 = require("aws-cdk-lib/aws-kms");
const aws_sagemaker_1 = require("aws-cdk-lib/aws-sagemaker");
const path_1 = require("path");
const aws_ec2_1 = require("aws-cdk-lib/aws-ec2");
const aws_logs_1 = require("aws-cdk-lib/aws-logs");
const codecommit = require("aws-cdk-lib/aws-codecommit");
const athena = require("aws-cdk-lib/aws-athena");
const aws_s3_1 = require("aws-cdk-lib/aws-s3");
const aws_stepfunctions_tasks_1 = require("aws-cdk-lib/aws-stepfunctions-tasks");
const cdk_nag_1 = require("cdk-nag");
const aws_lakeformation_1 = require("aws-cdk-lib/aws-lakeformation");
class SageMakerDomainStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const contextString = (key, defaultValue) => {
            const value = this.node.tryGetContext(key);
            return value === undefined ? defaultValue : value;
        };
        const contextBoolean = (key, defaultValue) => {
            const value = this.node.tryGetContext(key);
            return value === undefined ? defaultValue : value;
        };
        const sagemaker_restrict_cidr_presigned_url = contextString("sagemakerRestrictCidrPresignedUrl", "0.0.0.0/0");
        const sagemaker_presigned_url_trusted_principal_arn = contextString("sagemakerPresignedUrlTrustedPrincipalArn", "arn:aws:iam::123456789012:role/Admin");
        const cw_vpc_flow_logs_log_group_name = contextString("cloudWatchVpcFlowLogsLogGroupName", "/aws/vpc/flowlogs/SageMakerDomainStack");
        const security_lake_database_name = contextString("securityLakeDatabaseName", "amazon_security_lake_glue_db_us_east_1");
        const security_lake_table_name = contextString("securityLakeTableName", "amazon_security_lake_table_us_east_1_sh_findings_2_0");
        const athena_workgroup_name = contextString("athenaWorkgroupName", "security_lake_insights");
        const bedrock_model_id = contextString("bedrockModelId", "us.anthropic.claude-sonnet-4-6");
        const create_lake_formation_permissions = contextBoolean("createLakeFormationPermissions", false);
        const bedrock_model_resources = bedrock_model_id.startsWith("arn:")
            ? [
                bedrock_model_id,
                "arn:" + this.partition + ":bedrock:*::foundation-model/*",
            ]
            : bedrock_model_id.startsWith("us.") || bedrock_model_id.startsWith("eu.") || bedrock_model_id.startsWith("apac.") || bedrock_model_id.startsWith("global.")
                ? [
                    "arn:" + this.partition + ":bedrock:" + this.region + ":" + this.account + ":inference-profile/" + bedrock_model_id,
                    "arn:" + this.partition + ":bedrock:*::foundation-model/*",
                ]
                : [
                    "arn:" + this.partition + ":bedrock:" + this.region + "::foundation-model/" + bedrock_model_id,
                ];
        // CodeCommit repository
        const sagemaker_notebook_ml_insights_repository = new codecommit.Repository(this, 'sagemaker_notebook_ml_insights_repository', {
            repositoryName: 'sagemaker_ml_insights_repo',
            description: 'Repository for SageMaker notebooks to run analytics for Security Lake.',
            code: codecommit.Code.fromZipFile((0, path_1.join)(__dirname, "../notebooks/notebooks.zip"), "main")
        });
        new aws_cdk_lib_1.CfnOutput(this, 'sagemaker-notebook-ml-insights-repository-URL', {
            description: 'The CodeCommit repository URL to clone within your SageMaker user-profile notebook.',
            value: sagemaker_notebook_ml_insights_repository.repositoryCloneUrlHttp
        });
        // KMS Key for S3 bucket
        const athena_s3_output_kms_key = new aws_kms_1.Key(this, "athena_s3_output_kms_key", {
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            pendingWindow: aws_cdk_lib_1.Duration.days(7),
            description: "KMS key for S3 bucket to store athena workgroup output.",
            enableKeyRotation: true,
            alias: "athena_s3_output_kms_key"
        });
        // KMS Key for SageMaker Domain
        const sagemaker_kms_key = new aws_kms_1.Key(this, "sagemaker_kms_key", {
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            pendingWindow: aws_cdk_lib_1.Duration.days(7),
            description: "KMS key for SageMaker Domain resources.",
            enableKeyRotation: true,
            alias: "sagemaker_domain_kms_key"
        });
        const cw_flow_logs = new aws_logs_1.LogGroup(this, "cw_flow_logs", {
            logGroupName: cw_vpc_flow_logs_log_group_name,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            retention: aws_logs_1.RetentionDays.ONE_YEAR,
            encryptionKey: sagemaker_kms_key
        });
        sagemaker_kms_key.addToResourcePolicy(new iam.PolicyStatement({
            actions: [
                "kms:Encrypt*",
                "kms:Decrypt*",
                "kms:ReEncrypt*",
                "kms:GenerateDataKey*",
                "kms:Describe*"
            ],
            resources: [
                "*"
            ],
            principals: [
                new iam.ServicePrincipal("logs." + this.region + ".amazonaws.com")
            ],
            conditions: {
                ArnEquals: {
                    "kms:EncryptionContext:aws:logs:arn": [
                        "arn:aws:logs:" + this.region + ":" + this.account + ":log-group:" + cw_vpc_flow_logs_log_group_name
                    ]
                }
            }
        }));
        // Create SageMaker VPC
        const sagemaker_vpc = new aws_ec2_1.Vpc(this, "sagemaker_vpc", {
            maxAzs: 2,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: "public_subnet_for_nat_gw",
                    subnetType: aws_ec2_1.SubnetType.PUBLIC,
                    mapPublicIpOnLaunch: false
                },
                {
                    cidrMask: 24,
                    name: "workload_subnet_with_nat",
                    subnetType: aws_ec2_1.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
            flowLogs: {
                "s3": {
                    destination: aws_ec2_1.FlowLogDestination.toCloudWatchLogs(cw_flow_logs),
                    trafficType: aws_ec2_1.FlowLogTrafficType.ALL,
                }
            }
        });
        const sagemaker_workload_sg = new aws_ec2_1.SecurityGroup(this, "sagemaker_workload_sg", {
            vpc: sagemaker_vpc,
            description: "SageMaker Workload SG",
            allowAllOutbound: false,
            securityGroupName: "sagemaker_workload_sg"
        });
        sagemaker_workload_sg.connections.allowTo(sagemaker_workload_sg, aws_ec2_1.Port.tcpRange(8192, 65535), "Communication required with SageMaker service-owned VPC");
        sagemaker_workload_sg.connections.allowTo(sagemaker_workload_sg, aws_ec2_1.Port.udp(500), "Communication required with SageMaker service-owned VPC");
        sagemaker_workload_sg.connections.allowTo(sagemaker_workload_sg, aws_ec2_1.Port.esp(), "Communication required with SageMaker service-owned VPC");
        sagemaker_workload_sg.connections.allowTo(aws_ec2_1.Peer.anyIpv4(), aws_ec2_1.Port.tcp(443), "Allow HTTPS Outbound for egress-only internet access");
        sagemaker_workload_sg.connections.allowTo(aws_ec2_1.Peer.anyIpv4(), aws_ec2_1.Port.tcp(80), "Allow HTTP Outbound for egress-only internet access");
        sagemaker_workload_sg.connections.allowFrom(sagemaker_workload_sg, aws_ec2_1.Port.tcpRange(8192, 65535), "Communication required with SageMaker service-owned VPC");
        sagemaker_workload_sg.connections.allowFrom(sagemaker_workload_sg, aws_ec2_1.Port.udp(500), "Communication required with SageMaker service-owned VPC");
        sagemaker_workload_sg.connections.allowFrom(sagemaker_workload_sg, aws_ec2_1.Port.esp(), "Communication required with SageMaker service-owned VPC");
        sagemaker_workload_sg.connections.allowFrom(sagemaker_workload_sg, aws_ec2_1.Port.tcp(443), "Allow HTTPS Inbound for VPC interface endpoint");
        sagemaker_vpc.addInterfaceEndpoint("kms_endpoint", {
            service: aws_ec2_1.InterfaceVpcEndpointAwsService.KMS,
            privateDnsEnabled: true,
            subnets: {
                subnets: [
                    sagemaker_vpc.selectSubnets({ subnetGroupName: "workload_subnet_with_nat" }).subnets[0]
                ]
            },
            securityGroups: ([sagemaker_workload_sg])
        });
        sagemaker_vpc.addInterfaceEndpoint("sagemaker_api_endpoint", {
            service: aws_ec2_1.InterfaceVpcEndpointAwsService.SAGEMAKER_API,
            privateDnsEnabled: true,
            subnets: {
                subnets: [
                    sagemaker_vpc.selectSubnets({ subnetGroupName: "workload_subnet_with_nat" }).subnets[0]
                ]
            },
            securityGroups: ([sagemaker_workload_sg])
        });
        sagemaker_vpc.addInterfaceEndpoint("sagemaker_runtime_endpoint", {
            service: aws_ec2_1.InterfaceVpcEndpointAwsService.SAGEMAKER_RUNTIME,
            privateDnsEnabled: true,
            subnets: {
                subnets: [
                    sagemaker_vpc.selectSubnets({ subnetGroupName: "workload_subnet_with_nat" }).subnets[0]
                ]
            },
            securityGroups: ([sagemaker_workload_sg])
        });
        sagemaker_vpc.addInterfaceEndpoint("sagemaker_studio_endpoint", {
            service: new aws_ec2_1.InterfaceVpcEndpointService("aws.sagemaker." + this.region + ".studio", 443),
            privateDnsEnabled: true,
            subnets: {
                subnets: [
                    sagemaker_vpc.selectSubnets({ subnetGroupName: "workload_subnet_with_nat" }).subnets[0]
                ]
            },
            securityGroups: ([sagemaker_workload_sg])
        });
        sagemaker_vpc.addInterfaceEndpoint("athena_endpoint", {
            service: aws_ec2_1.InterfaceVpcEndpointAwsService.ATHENA,
            privateDnsEnabled: true,
            subnets: {
                subnets: [
                    sagemaker_vpc.selectSubnets({ subnetGroupName: "workload_subnet_with_nat" }).subnets[0]
                ]
            },
            securityGroups: ([sagemaker_workload_sg])
        });
        sagemaker_vpc.addInterfaceEndpoint("s3_endpoint", {
            service: new aws_ec2_1.InterfaceVpcEndpointService("com.amazonaws." + this.region + ".s3", 443),
            subnets: {
                subnets: [
                    sagemaker_vpc.selectSubnets({ subnetGroupName: "workload_subnet_with_nat" }).subnets[0]
                ]
            },
            securityGroups: ([sagemaker_workload_sg])
        });
        sagemaker_vpc.addInterfaceEndpoint("codecommit_endpoint", {
            service: aws_ec2_1.InterfaceVpcEndpointAwsService.CODECOMMIT,
            subnets: {
                subnets: [
                    sagemaker_vpc.selectSubnets({ subnetGroupName: "workload_subnet_with_nat" }).subnets[0]
                ]
            },
            securityGroups: ([sagemaker_workload_sg])
        });
        sagemaker_vpc.addInterfaceEndpoint("codecommit_git_endpoint", {
            service: aws_ec2_1.InterfaceVpcEndpointAwsService.CODECOMMIT_GIT,
            subnets: {
                subnets: [
                    sagemaker_vpc.selectSubnets({ subnetGroupName: "workload_subnet_with_nat" }).subnets[0]
                ]
            },
            securityGroups: ([sagemaker_workload_sg])
        });
        // S3 Bucket for Athena output
        const s3_access_logs = new aws_s3_1.Bucket(this, 's3_access_logs', {
            bucketName: 'athena-ml-insights-s3-access-logs-' + this.account,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            bucketKeyEnabled: true,
            encryption: aws_s3_1.BucketEncryption.KMS_MANAGED,
            enforceSSL: true,
            versioned: true,
            blockPublicAccess: aws_s3_1.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: aws_s3_1.ObjectOwnership.BUCKET_OWNER_PREFERRED,
            publicReadAccess: false,
            lifecycleRules: [{
                    expiration: aws_cdk_lib_1.Duration.days(365),
                    transitions: [{
                            storageClass: aws_s3_1.StorageClass.INTELLIGENT_TIERING,
                            transitionAfter: aws_cdk_lib_1.Duration.days(31)
                        }]
                }]
        });
        const athena_output_s3_bucket = new aws_s3_1.Bucket(this, 'athena_output_s3_bucket', {
            bucketName: 'athena-ml-insights-bucket-results-' + this.account,
            serverAccessLogsBucket: s3_access_logs,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            bucketKeyEnabled: true,
            encryption: aws_s3_1.BucketEncryption.KMS,
            encryptionKey: athena_s3_output_kms_key,
            enforceSSL: true,
            versioned: true,
            blockPublicAccess: aws_s3_1.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: aws_s3_1.ObjectOwnership.BUCKET_OWNER_PREFERRED,
            publicReadAccess: false,
            lifecycleRules: [{
                    expiration: aws_cdk_lib_1.Duration.days(365),
                    transitions: [{
                            storageClass: aws_s3_1.StorageClass.INTELLIGENT_TIERING,
                            transitionAfter: aws_cdk_lib_1.Duration.days(31)
                        }]
                }]
        });
        // IAM Role for SageMaker user profiles
        const sagemaker_user_profile_role = new iam.Role(this, "sagemaker_user_profile_role", {
            assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
            roleName: "sagemaker-user-profile-for-security-lake",
            managedPolicies: []
        });
        sagemaker_kms_key.addToResourcePolicy(new iam.PolicyStatement({
            actions: [
                "kms:DescribeKey",
                "kms:Decrypt",
                "kms:GenerateDataKey",
                "kms:CreateGrant"
            ],
            resources: [
                "*"
            ],
            principals: [
                new iam.ArnPrincipal(sagemaker_user_profile_role.roleArn)
            ]
        }));
        const sagemaker_user_profile_policy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    sid: "CloudWatchLogGroupAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents"
                    ],
                    resources: [
                        "arn:aws:logs:" + this.region + ":" + this.account + ":log-group:/aws/sagemaker/studio:*"
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "S3Read",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "s3:ListBucket",
                    ],
                    resources: [
                        "*"
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "S3Allow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "s3:AbortMultipartUpload",
                        "s3:DeleteObject",
                        "s3:GetObject",
                        "s3:ListBucket",
                        "s3:PutObject",
                        "s3:PutObjectAcl",
                        "s3:GetBucketAcl",
                        "s3:GetBucketLocation"
                    ],
                    resources: [
                        athena_output_s3_bucket.bucketArn,
                        athena_output_s3_bucket.bucketArn + "/*"
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "AthenaAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "athena:Get*",
                        "athena:List*",
                        "athena:StartQueryExecution",
                        "athena:StartSession",
                        "athena:StopQueryExecution",
                    ],
                    resources: [
                        "arn:aws:athena:" + this.region + ":" + this.account + ":datacatalog/*",
                        "arn:aws:athena:" + this.region + ":" + this.account + ":workgroup/*"
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "GlueAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "glue:CreateDatabase",
                        "glue:GetDatabase",
                        "glue:GetDatabases",
                        "glue:GetTable",
                        "glue:GetTables",
                        "glue:GetPartition",
                        "glue:GetPartitions",
                        "glue:BatchGetPartition"
                    ],
                    resources: [
                        "arn:aws:glue:" + this.region + ":" + this.account + ":database/*",
                        "arn:aws:glue:" + this.region + ":" + this.account + ":table/*",
                        "arn:aws:glue:" + this.region + ":" + this.account + ":catalog",
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "LakeFormationAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "lakeformation:GetDataAccess"
                    ],
                    resources: [
                        "*"
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "CodeCommitAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "codecommit:BatchGet*",
                        "codecommit:Describe*",
                        "codecommit:Get*",
                        "codecommit:List*",
                        "codecommit:GitPull",
                        "codecommit:GitPush",
                        "codecommit:CreateBranch",
                        "codecommit:DeleteBranch",
                        "codecommit:MergeBranchesBy*",
                        "codecommit:UpdateDefaultBranch",
                        "codecommit:BatchDescribeMergeConflicts",
                        "codecommit:CreateUnreferencedMergeCommit",
                        "codecommit:CreateCommit",
                        "codecommit:CreatePullRequest",
                        "codecommit:CreatePullRequestApprovalRule",
                        "codecommit:DeletePullRequestApprovalRule",
                        "codecommit:EvaluatePullRequestApprovalRules",
                        "codecommit:MergePullRequestBy*",
                        "codecommit:PostCommentForPullRequest",
                        "codecommit:UpdatePullRequest*",
                        "codecommit:PutFile"
                    ],
                    resources: [
                        sagemaker_notebook_ml_insights_repository.repositoryArn
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "SageMakerNotResourceAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "sagemaker:*"
                    ],
                    notResources: [
                        "arn:aws:sagemaker:*:*:domain/*",
                        "arn:aws:sagemaker:*:*:user-profile/*",
                        "arn:aws:sagemaker:*:*:app/*",
                        "arn:aws:sagemaker:*:*:flow-definition/*"
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "SageMakerDomainAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "sagemaker:CreatePresignedDomainUrl",
                        "sagemaker:DescribeDomain",
                        "sagemaker:ListDomains",
                        "sagemaker:DescribeUserProfile",
                        "sagemaker:ListUserProfiles",
                        "sagemaker:*App",
                        "sagemaker:ListApps"
                    ],
                    resources: [
                        "arn:aws:sagemaker:*:*:domain/*",
                        "arn:aws:sagemaker:*:*:user-profile/*",
                        "arn:aws:sagemaker:*:*:app/*",
                        "arn:aws:sagemaker:*:*:flow-definition/*"
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "SageMakerWorkstream",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "iam:PassRole"
                    ],
                    resources: [
                        "arn:aws:sagemaker:" + this.region + ":" + this.account + ":flow-definition/*",
                    ],
                    conditions: {
                        StringEqualsIfExists: {
                            "sagemaker:WorkteamType": [
                                "private-crowd",
                                "vendor-crowd"
                            ]
                        }
                    }
                }),
                new iam.PolicyStatement({
                    sid: "IAMPassRoleService",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "iam:PassRole"
                    ],
                    resources: [
                        sagemaker_user_profile_role.roleArn
                    ],
                    conditions: {
                        StringLike: {
                            "iam:PassedToService": [
                                "glue.amazonaws.com",
                                "robomaker.amazonaws.com",
                                "states.amazonaws.com",
                                "sagemaker.amazonaws.com"
                            ]
                        }
                    }
                }),
                new iam.PolicyStatement({
                    sid: "KMSEncrypt",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "kms:CreateGrant",
                        "kms:DescribeKey",
                        "kms:Decrypt",
                        "kms:Encrypt",
                        "kms:GenerateDataKey",
                        "kms:ReEncrypt*"
                    ],
                    resources: [
                        sagemaker_kms_key.keyArn,
                        athena_s3_output_kms_key.keyArn
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "SageMakerPermissions",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "sagemaker:CreateApp"
                    ],
                    resources: [
                        "arn:aws:sagemaker:" + this.region + ":" + this.account + ":app/*",
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "BedrockInvokeAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "bedrock:InvokeModel",
                        "bedrock:InvokeModelWithResponseStream"
                    ],
                    resources: bedrock_model_resources
                }),
            ],
        });
        athena_output_s3_bucket.addToResourcePolicy(new iam.PolicyStatement({
            actions: [
                's3:PutObject',
                's3:PutObjectAcl',
                's3:DeleteObject',
                's3:GetBucketLocation'
            ],
            resources: [
                athena_output_s3_bucket.bucketArn,
                athena_output_s3_bucket.bucketArn + '/*'
            ],
            principals: [
                new iam.ArnPrincipal(sagemaker_user_profile_role.roleArn)
            ],
        }));
        new iam.ManagedPolicy(this, "SageMakerStudioUserProfileManagedPolicy", {
            description: "Managed policy associated to the SageMaker Studios user profile.",
            document: sagemaker_user_profile_policy,
            managedPolicyName: "sagemaker-studio-user-security-lake-policy",
            roles: [sagemaker_user_profile_role]
        });
        if (create_lake_formation_permissions) {
            new aws_lakeformation_1.CfnPrincipalPermissions(this, "SageMakerSecurityLakeDatabasePermissions", {
                principal: {
                    dataLakePrincipalIdentifier: sagemaker_user_profile_role.roleArn,
                },
                resource: {
                    database: {
                        catalogId: this.account,
                        name: security_lake_database_name,
                    },
                },
                permissions: ["DESCRIBE"],
                permissionsWithGrantOption: [],
            });
            new aws_lakeformation_1.CfnPrincipalPermissions(this, "SageMakerSecurityLakeTablePermissions", {
                principal: {
                    dataLakePrincipalIdentifier: sagemaker_user_profile_role.roleArn,
                },
                resource: {
                    table: {
                        catalogId: this.account,
                        databaseName: security_lake_database_name,
                        name: security_lake_table_name,
                    },
                },
                permissions: ["DESCRIBE", "SELECT"],
                permissionsWithGrantOption: [],
            });
        }
        const sagemaker_domain = new aws_sagemaker_1.CfnDomain(this, "sagemaker_domain", {
            authMode: "IAM",
            defaultUserSettings: {
                executionRole: sagemaker_user_profile_role.roleArn,
                jupyterServerAppSettings: {
                    defaultResourceSpec: {
                        instanceType: "system",
                        // lifecycleConfigArn: "lifecycleConfigArn",
                        // sageMakerImageArn: "sageMakerImageArn",
                        // sageMakerImageVersionArn: "sageMakerImageVersionArn",
                    },
                },
                kernelGatewayAppSettings: {
                    // customImages: [{
                    //   appImageConfigName: "appImageConfigName",
                    //   imageName: "imageName",
                    //   // the properties below are optional
                    //   imageVersionNumber: 123,
                    // }],
                    defaultResourceSpec: {
                        instanceType: "ml.t3.medium",
                        // lifecycleConfigArn: "lifecycleConfigArn",
                        sageMakerImageArn: "arn:aws:sagemaker:" + this.region + ":081325390199:image/datascience-1.0",
                    },
                },
                // rSessionAppSettings: {
                //   customImages: [{
                //     appImageConfigName: "appImageConfigName",
                //     imageName: "imageName",
                //     // the properties below are optional
                //     imageVersionNumber: 123,
                //   }],
                //   defaultResourceSpec: {
                //     instanceType: "instanceType",
                //     lifecycleConfigArn: "lifecycleConfigArn",
                //     sageMakerImageArn: "sageMakerImageArn",
                //     sageMakerImageVersionArn: "sageMakerImageVersionArn",
                //   },
                // },
                // rStudioServerProAppSettings: {
                //   accessStatus: "accessStatus",
                //   userGroup: "userGroup",
                // },
                securityGroups: [sagemaker_workload_sg.securityGroupId],
                // sharingSettings: {
                //   notebookOutputOption: "notebookOutputOption",
                //   s3KmsKeyId: "s3KmsKeyId",
                //   s3OutputPath: "s3OutputPath",
                // },
            },
            domainName: "security-lake-ml-insights-" + this.account,
            subnetIds: [sagemaker_vpc.selectSubnets({ subnetGroupName: "workload_subnet_with_nat" }).subnets[0].subnetId],
            vpcId: sagemaker_vpc.vpcId,
            // the properties below are optional
            appNetworkAccessType: "VpcOnly",
            // appSecurityGroupManagement: "appSecurityGroupManagement",
            // domainSettings: {
            //   rStudioServerProDomainSettings: {
            //     domainExecutionRoleArn: "domainExecutionRoleArn",
            //     // the properties below are optional
            //     defaultResourceSpec: {
            //       instanceType: "instanceType",
            //       lifecycleConfigArn: "lifecycleConfigArn",
            //       sageMakerImageArn: "sageMakerImageArn",
            //       sageMakerImageVersionArn: "sageMakerImageVersionArn",
            //     },
            //     rStudioConnectUrl: "rStudioConnectUrl",
            //     rStudioPackageManagerUrl: "rStudioPackageManagerUrl",
            //   },
            //   securityGroupIds: ["securityGroupIds"],
            // },
            kmsKeyId: sagemaker_kms_key.keyId,
            tags: [{
                    key: "project",
                    value: "security-lake-ml-insights",
                }],
        });
        sagemaker_domain.applyRemovalPolicy(aws_cdk_lib_1.RemovalPolicy.DESTROY);
        const sagemaker_user_profile = new aws_sagemaker_1.CfnUserProfile(this, 'sagemaker_user_profile', {
            domainId: sagemaker_domain.attrDomainId,
            userProfileName: sagemaker_user_profile_role.roleName,
            // the properties below are optional
            // singleSignOnUserIdentifier: 'singleSignOnUserIdentifier',
            // singleSignOnUserValue: 'singleSignOnUserValue',
            tags: [{
                    key: 'project',
                    value: 'security-lake-ml-insights',
                }],
            userSettings: {
                executionRole: sagemaker_user_profile_role.roleArn,
                // jupyterServerAppSettings: {
                //   defaultResourceSpec: {
                //     instanceType: 'instanceType',
                //     sageMakerImageArn: 'sageMakerImageArn',
                //     sageMakerImageVersionArn: 'sageMakerImageVersionArn',
                //   },
                // },
                // kernelGatewayAppSettings: {
                //   customImages: [{
                //     appImageConfigName: 'appImageConfigName',
                //     imageName: 'imageName',
                //     // the properties below are optional
                //     imageVersionNumber: 123,
                //   }],
                //   defaultResourceSpec: {
                //     instanceType: 'instanceType',
                //     sageMakerImageArn: 'sageMakerImageArn',
                //     sageMakerImageVersionArn: 'sageMakerImageVersionArn',
                //   },
                // },
                // rStudioServerProAppSettings: {
                //   accessStatus: 'accessStatus',
                //   userGroup: 'userGroup',
                // },
                //securityGroups: ['securityGroups'],
                // sharingSettings: {
                //   notebookOutputOption: 'notebookOutputOption',
                //   s3KmsKeyId: 's3KmsKeyId',
                //   s3OutputPath: 's3OutputPath',
                // },
            },
        });
        sagemaker_user_profile.addDependency(sagemaker_domain);
        sagemaker_user_profile.applyRemovalPolicy(aws_cdk_lib_1.RemovalPolicy.DESTROY);
        const sagemaker_app = new aws_sagemaker_1.CfnApp(this, 'sagemaker_app', {
            appName: 'default',
            appType: 'JupyterServer',
            domainId: sagemaker_domain.attrDomainId,
            userProfileName: sagemaker_user_profile.userProfileName,
            // the properties below are optional
            resourceSpec: {
                instanceType: 'system'
            },
            tags: [{
                    key: 'project',
                    value: 'security-lake-ml-insights',
                }],
        });
        sagemaker_app.addDependency(sagemaker_user_profile);
        sagemaker_app.applyRemovalPolicy(aws_cdk_lib_1.RemovalPolicy.DESTROY);
        // IAM Role for SageMaker user profiles
        const sagemaker_console_presigned_url_role = new iam.Role(this, "sagemaker_console_presigned_url_role", {
            assumedBy: new iam.CompositePrincipal(new iam.ArnPrincipal(sagemaker_presigned_url_trusted_principal_arn)),
            roleName: "sagemaker-console-presigned-url-role",
            // managedPolicies: [
            // ]
        });
        const sagemaker_presigned_url_policy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    sid: "SMStudioCreatePresignedURLAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "sagemaker:CreatePresignedDomainUrl"
                    ],
                    resources: [
                        sagemaker_user_profile.attrUserProfileArn
                    ],
                    conditions: {
                        IpAddress: {
                            "aws:SourceIp": [
                                sagemaker_restrict_cidr_presigned_url
                            ]
                        }
                    }
                }),
                new iam.PolicyStatement({
                    sid: "SMStudioConsoleReadAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "sagemaker:DescribeDomain",
                        "sagemaker:DescribeUserProfile",
                        "sagemaker:ListApps",
                        "sagemaker:ListDomains",
                        "sagemaker:ListUserProfiles",
                    ],
                    resources: [
                        "arn:" + this.partition + ":sagemaker:" + this.region + ":" + this.account + ":domain/*",
                        "arn:" + this.partition + ":sagemaker:" + this.region + ":" + this.account + ":user-profile/" + sagemaker_domain.attrDomainId + "/*",
                        "arn:" + this.partition + ":sagemaker:" + this.region + ":" + this.account + ":app/" + sagemaker_domain.attrDomainId + "/*"
                    ]
                }),
                new iam.PolicyStatement({
                    sid: "SMStudioServiceCatalogReadAllow",
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "license-manager:ListReceivedLicenses",
                        "sagemaker:GetSagemakerServicecatalogPortfolioStatus",
                        "servicecatalog:ListAcceptedPortfolioShares",
                        "servicecatalog:ListPrincipalsForPortfolio"
                    ],
                    resources: [
                        "*"
                    ]
                })
            ],
        });
        new iam.ManagedPolicy(this, "SageMakerStudioConsoleManagedPolicy", {
            description: "Managed policy associated to the AWS console role to access SageMaker Studio Domain presigned URL.",
            document: sagemaker_presigned_url_policy,
            managedPolicyName: "sagemaker-studio-console-access-policy",
            roles: [sagemaker_console_presigned_url_role]
        });
        athena_s3_output_kms_key.addToResourcePolicy(new iam.PolicyStatement({
            actions: [
                'kms:DescribeKey',
                'kms:Encrypt',
                'kms:GenerateDataKey*'
            ],
            resources: [
                '*'
            ],
            principals: [
                new iam.ArnPrincipal(sagemaker_user_profile_role.roleArn)
            ]
        }));
        const ml_insights_workgroup = new athena.CfnWorkGroup(this, 'ml_insights_workgroup', {
            name: athena_workgroup_name,
            // the properties below are optional
            description: 'Workgroup for Security Lake ML Insights.',
            recursiveDeleteOption: true,
            state: 'ENABLED',
            // tags: [{
            //   key: 'key',
            //   value: 'value',
            // }],
            workGroupConfiguration: {
                // bytesScannedCutoffPerQuery: 10000000,
                enforceWorkGroupConfiguration: true,
                // engineVersion: {
                //   effectiveEngineVersion: 'effectiveEngineVersion',
                //   selectedEngineVersion: 'selectedEngineVersion',
                // },
                publishCloudWatchMetricsEnabled: false,
                requesterPaysEnabled: false,
                resultConfiguration: {
                    encryptionConfiguration: {
                        encryptionOption: aws_stepfunctions_tasks_1.EncryptionOption.KMS,
                        kmsKey: athena_s3_output_kms_key.keyArn,
                    },
                    outputLocation: 's3://' + athena_output_s3_bucket.bucketName + '/',
                },
            },
        });
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/SageMakerDomainStack/SageMakerStudioConsoleManagedPolicy/Resource', [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'The specific actions in the SMStudioServiceCatalogReadAllow SID require * resource. The actions are all read-only.',
            },
        ]);
        cdk_nag_1.NagSuppressions.addResourceSuppressionsByPath(this, '/SageMakerDomainStack/SageMakerStudioUserProfileManagedPolicy/Resource', [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'The specific actions in the S3Read and LakeFormationAllow SID require * resource. Bedrock cross-region inference also requires wildcard foundation-model resources for the routed model regions.',
            },
        ]);
    }
}
exports.SageMakerDomainStack = SageMakerDomainStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2FnZW1ha2VyX2RvbWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNhZ2VtYWtlcl9kb21haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsNkNBQW9GO0FBQ3BGLDJDQUEyQztBQUUzQyxpREFBMEM7QUFDMUMsNkRBQThFO0FBQzlFLCtCQUE0QjtBQUM1QixpREFBc0w7QUFDdEwsbURBQStEO0FBQy9ELHlEQUF5RDtBQUN6RCxpREFBaUQ7QUFDakQsK0NBQWdIO0FBQ2hILGlGQUF1RTtBQUN2RSxxQ0FBMEM7QUFDMUMscUVBQXdFO0FBRXhFLE1BQWEsb0JBQXFCLFNBQVEsbUJBQUs7SUFDN0MsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFrQjtRQUMxRCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLGFBQWEsR0FBRyxDQUFDLEdBQVcsRUFBRSxZQUFvQixFQUFVLEVBQUU7WUFDbEUsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDM0MsT0FBTyxLQUFLLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztRQUNwRCxDQUFDLENBQUM7UUFFRixNQUFNLGNBQWMsR0FBRyxDQUFDLEdBQVcsRUFBRSxZQUFxQixFQUFXLEVBQUU7WUFDckUsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDM0MsT0FBTyxLQUFLLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztRQUNwRCxDQUFDLENBQUM7UUFFRixNQUFNLHFDQUFxQyxHQUFHLGFBQWEsQ0FBQyxtQ0FBbUMsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUM5RyxNQUFNLDZDQUE2QyxHQUFHLGFBQWEsQ0FBQywwQ0FBMEMsRUFBRSxzQ0FBc0MsQ0FBQyxDQUFDO1FBQ3hKLE1BQU0sK0JBQStCLEdBQUcsYUFBYSxDQUFDLG1DQUFtQyxFQUFFLHdDQUF3QyxDQUFDLENBQUM7UUFDckksTUFBTSwyQkFBMkIsR0FBRyxhQUFhLENBQUMsMEJBQTBCLEVBQUUsd0NBQXdDLENBQUMsQ0FBQztRQUN4SCxNQUFNLHdCQUF3QixHQUFHLGFBQWEsQ0FBQyx1QkFBdUIsRUFBRSxzREFBc0QsQ0FBQyxDQUFDO1FBQ2hJLE1BQU0scUJBQXFCLEdBQUcsYUFBYSxDQUFDLHFCQUFxQixFQUFFLHdCQUF3QixDQUFDLENBQUM7UUFDN0YsTUFBTSxnQkFBZ0IsR0FBRyxhQUFhLENBQUMsZ0JBQWdCLEVBQUUsZ0NBQWdDLENBQUMsQ0FBQztRQUMzRixNQUFNLGlDQUFpQyxHQUFHLGNBQWMsQ0FBQyxnQ0FBZ0MsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUNsRyxNQUFNLHVCQUF1QixHQUFHLGdCQUFnQixDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUM7WUFDakUsQ0FBQyxDQUFDO2dCQUNBLGdCQUFnQjtnQkFDaEIsTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLEdBQUcsZ0NBQWdDO2FBQzNEO1lBQ0QsQ0FBQyxDQUFDLGdCQUFnQixDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsSUFBSSxnQkFBZ0IsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLElBQUksZ0JBQWdCLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxJQUFJLGdCQUFnQixDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUM7Z0JBQzFKLENBQUMsQ0FBQztvQkFDQSxNQUFNLEdBQUcsSUFBSSxDQUFDLFNBQVMsR0FBRyxXQUFXLEdBQUcsSUFBSSxDQUFDLE1BQU0sR0FBRyxHQUFHLEdBQUcsSUFBSSxDQUFDLE9BQU8sR0FBRyxxQkFBcUIsR0FBRyxnQkFBZ0I7b0JBQ25ILE1BQU0sR0FBRyxJQUFJLENBQUMsU0FBUyxHQUFHLGdDQUFnQztpQkFDM0Q7Z0JBQ0QsQ0FBQyxDQUFDO29CQUNBLE1BQU0sR0FBRyxJQUFJLENBQUMsU0FBUyxHQUFHLFdBQVcsR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLHFCQUFxQixHQUFHLGdCQUFnQjtpQkFDL0YsQ0FBQztRQUVOLHdCQUF3QjtRQUN4QixNQUFNLHlDQUF5QyxHQUFHLElBQUksVUFBVSxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsMkNBQTJDLEVBQUU7WUFDN0gsY0FBYyxFQUFFLDRCQUE0QjtZQUM1QyxXQUFXLEVBQUUsd0VBQXdFO1lBQ3JGLElBQUksRUFBRSxVQUFVLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFBLFdBQUksRUFBQyxTQUFTLEVBQUUsNEJBQTRCLENBQUMsRUFBRSxNQUFNLENBQUM7U0FDekYsQ0FBQyxDQUFDO1FBRUgsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBQywrQ0FBK0MsRUFBRTtZQUNsRSxXQUFXLEVBQUMscUZBQXFGO1lBQ2pHLEtBQUssRUFBRSx5Q0FBeUMsQ0FBQyxzQkFBc0I7U0FDeEUsQ0FBQyxDQUFBO1FBR0Ysd0JBQXdCO1FBQ3hCLE1BQU0sd0JBQXdCLEdBQUcsSUFBSSxhQUFHLENBQUMsSUFBSSxFQUFFLDBCQUEwQixFQUFFO1lBQ3pFLGFBQWEsRUFBRSwyQkFBYSxDQUFDLE9BQU87WUFDcEMsYUFBYSxFQUFFLHNCQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztZQUMvQixXQUFXLEVBQUUseURBQXlEO1lBQ3RFLGlCQUFpQixFQUFFLElBQUk7WUFDdkIsS0FBSyxFQUFFLDBCQUEwQjtTQUNsQyxDQUFDLENBQUM7UUFFSCwrQkFBK0I7UUFDL0IsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLGFBQUcsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDM0QsYUFBYSxFQUFFLDJCQUFhLENBQUMsT0FBTztZQUNwQyxhQUFhLEVBQUUsc0JBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1lBQy9CLFdBQVcsRUFBRSx5Q0FBeUM7WUFDdEQsaUJBQWlCLEVBQUUsSUFBSTtZQUN2QixLQUFLLEVBQUUsMEJBQTBCO1NBQ2xDLENBQUMsQ0FBQztRQUVILE1BQU0sWUFBWSxHQUFHLElBQUksbUJBQVEsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQ3RELFlBQVksRUFBRSwrQkFBK0I7WUFDN0MsYUFBYSxFQUFFLDJCQUFhLENBQUMsT0FBTztZQUNwQyxTQUFTLEVBQUUsd0JBQWEsQ0FBQyxRQUFRO1lBQ2pDLGFBQWEsRUFBRSxpQkFBaUI7U0FDL0IsQ0FBQyxDQUFDO1FBRUwsaUJBQWlCLENBQUMsbUJBQW1CLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQzVELE9BQU8sRUFBRTtnQkFDUCxjQUFjO2dCQUNkLGNBQWM7Z0JBQ2QsZ0JBQWdCO2dCQUNoQixzQkFBc0I7Z0JBQ3RCLGVBQWU7YUFDaEI7WUFDRCxTQUFTLEVBQUU7Z0JBQ1QsR0FBRzthQUNKO1lBQ0QsVUFBVSxFQUFFO2dCQUNWLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLE9BQU8sR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLGdCQUFnQixDQUFDO2FBQ25FO1lBQ0QsVUFBVSxFQUFDO2dCQUNULFNBQVMsRUFBQztvQkFDUixvQ0FBb0MsRUFBRTt3QkFDcEMsZUFBZSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxPQUFPLEdBQUUsYUFBYSxHQUFHLCtCQUErQjtxQkFDcEc7aUJBQ0Y7YUFBQztTQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUosdUJBQXVCO1FBQ3ZCLE1BQU0sYUFBYSxHQUFHLElBQUksYUFBRyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUU7WUFDbkQsTUFBTSxFQUFFLENBQUM7WUFDVCxtQkFBbUIsRUFBRTtnQkFDbkI7b0JBQ0UsUUFBUSxFQUFFLEVBQUU7b0JBQ1osSUFBSSxFQUFFLDBCQUEwQjtvQkFDaEMsVUFBVSxFQUFFLG9CQUFVLENBQUMsTUFBTTtvQkFDN0IsbUJBQW1CLEVBQUUsS0FBSztpQkFDM0I7Z0JBQ0Q7b0JBQ0UsUUFBUSxFQUFFLEVBQUU7b0JBQ1osSUFBSSxFQUFFLDBCQUEwQjtvQkFDaEMsVUFBVSxFQUFFLG9CQUFVLENBQUMsbUJBQW1CO2lCQUMzQzthQUNGO1lBQ0QsUUFBUSxFQUFFO2dCQUNSLElBQUksRUFBRTtvQkFDSixXQUFXLEVBQUUsNEJBQWtCLENBQUMsZ0JBQWdCLENBQUMsWUFBWSxDQUFDO29CQUM5RCxXQUFXLEVBQUUsNEJBQWtCLENBQUMsR0FBRztpQkFDdEM7YUFBQztTQUNILENBQUMsQ0FBQztRQUVILE1BQU0scUJBQXFCLEdBQUcsSUFBSSx1QkFBYSxDQUFDLElBQUksRUFBRSx1QkFBdUIsRUFBRTtZQUM3RSxHQUFHLEVBQUUsYUFBYTtZQUNsQixXQUFXLEVBQUUsdUJBQXVCO1lBQ3BDLGdCQUFnQixFQUFFLEtBQUs7WUFDdkIsaUJBQWlCLEVBQUUsdUJBQXVCO1NBQzNDLENBQUMsQ0FBQztRQUVILHFCQUFxQixDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMscUJBQXFCLEVBQUUsY0FBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUMsS0FBSyxDQUFDLEVBQUUseURBQXlELENBQUMsQ0FBQTtRQUN0SixxQkFBcUIsQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLHFCQUFxQixFQUFFLGNBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUseURBQXlELENBQUMsQ0FBQTtRQUMxSSxxQkFBcUIsQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLHFCQUFxQixFQUFFLGNBQUksQ0FBQyxHQUFHLEVBQUUsRUFBRSx5REFBeUQsQ0FBQyxDQUFBO1FBQ3ZJLHFCQUFxQixDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsY0FBSSxDQUFDLE9BQU8sRUFBRSxFQUFFLGNBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsc0RBQXNELENBQUMsQ0FBQTtRQUNoSSxxQkFBcUIsQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLGNBQUksQ0FBQyxPQUFPLEVBQUUsRUFBRSxjQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLHFEQUFxRCxDQUFDLENBQUE7UUFFOUgscUJBQXFCLENBQUMsV0FBVyxDQUFDLFNBQVMsQ0FBQyxxQkFBcUIsRUFBRSxjQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBQyxLQUFLLENBQUMsRUFBRSx5REFBeUQsQ0FBQyxDQUFBO1FBQ3hKLHFCQUFxQixDQUFDLFdBQVcsQ0FBQyxTQUFTLENBQUMscUJBQXFCLEVBQUUsY0FBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSx5REFBeUQsQ0FBQyxDQUFBO1FBQzVJLHFCQUFxQixDQUFDLFdBQVcsQ0FBQyxTQUFTLENBQUMscUJBQXFCLEVBQUUsY0FBSSxDQUFDLEdBQUcsRUFBRSxFQUFFLHlEQUF5RCxDQUFDLENBQUE7UUFDekkscUJBQXFCLENBQUMsV0FBVyxDQUFDLFNBQVMsQ0FBQyxxQkFBcUIsRUFBRSxjQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLGdEQUFnRCxDQUFDLENBQUE7UUFFbkksYUFBYSxDQUFDLG9CQUFvQixDQUFDLGNBQWMsRUFBQztZQUNoRCxPQUFPLEVBQUUsd0NBQThCLENBQUMsR0FBRztZQUMzQyxpQkFBaUIsRUFBRSxJQUFJO1lBQ3ZCLE9BQU8sRUFBRTtnQkFDTixPQUFPLEVBQUU7b0JBQ1IsYUFBYSxDQUFDLGFBQWEsQ0FBQyxFQUFDLGVBQWUsRUFBRSwwQkFBMEIsRUFBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztpQkFDckY7YUFDSDtZQUNELGNBQWMsRUFBRSxDQUNkLENBQUMscUJBQXFCLENBQUMsQ0FDeEI7U0FDRixDQUFDLENBQUM7UUFFSCxhQUFhLENBQUMsb0JBQW9CLENBQUMsd0JBQXdCLEVBQUM7WUFDMUQsT0FBTyxFQUFFLHdDQUE4QixDQUFDLGFBQWE7WUFDckQsaUJBQWlCLEVBQUUsSUFBSTtZQUN2QixPQUFPLEVBQUU7Z0JBQ04sT0FBTyxFQUFFO29CQUNSLGFBQWEsQ0FBQyxhQUFhLENBQUMsRUFBQyxlQUFlLEVBQUUsMEJBQTBCLEVBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7aUJBQ3JGO2FBQ0g7WUFDRCxjQUFjLEVBQUUsQ0FDZCxDQUFDLHFCQUFxQixDQUFDLENBQ3hCO1NBQ0YsQ0FBQyxDQUFDO1FBR0gsYUFBYSxDQUFDLG9CQUFvQixDQUFDLDRCQUE0QixFQUFDO1lBQzlELE9BQU8sRUFBRSx3Q0FBOEIsQ0FBQyxpQkFBaUI7WUFDekQsaUJBQWlCLEVBQUUsSUFBSTtZQUN2QixPQUFPLEVBQUU7Z0JBQ04sT0FBTyxFQUFFO29CQUNSLGFBQWEsQ0FBQyxhQUFhLENBQUMsRUFBQyxlQUFlLEVBQUUsMEJBQTBCLEVBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7aUJBQ3JGO2FBQ0g7WUFDRCxjQUFjLEVBQUUsQ0FDZCxDQUFDLHFCQUFxQixDQUFDLENBQ3hCO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsYUFBYSxDQUFDLG9CQUFvQixDQUFDLDJCQUEyQixFQUFDO1lBQzdELE9BQU8sRUFBRSxJQUFJLHFDQUEyQixDQUFDLGdCQUFnQixHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsU0FBUyxFQUFFLEdBQUcsQ0FBQztZQUN6RixpQkFBaUIsRUFBRSxJQUFJO1lBQ3ZCLE9BQU8sRUFBRTtnQkFDTixPQUFPLEVBQUU7b0JBQ1IsYUFBYSxDQUFDLGFBQWEsQ0FBQyxFQUFDLGVBQWUsRUFBRSwwQkFBMEIsRUFBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztpQkFDckY7YUFDSDtZQUNELGNBQWMsRUFBRSxDQUNkLENBQUMscUJBQXFCLENBQUMsQ0FDeEI7U0FDRixDQUFDLENBQUM7UUFFSCxhQUFhLENBQUMsb0JBQW9CLENBQUMsaUJBQWlCLEVBQUM7WUFDbkQsT0FBTyxFQUFFLHdDQUE4QixDQUFDLE1BQU07WUFDOUMsaUJBQWlCLEVBQUUsSUFBSTtZQUN2QixPQUFPLEVBQUU7Z0JBQ04sT0FBTyxFQUFFO29CQUNSLGFBQWEsQ0FBQyxhQUFhLENBQUMsRUFBQyxlQUFlLEVBQUUsMEJBQTBCLEVBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7aUJBQ3JGO2FBQ0g7WUFDRCxjQUFjLEVBQUUsQ0FDZCxDQUFDLHFCQUFxQixDQUFDLENBQ3hCO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsYUFBYSxDQUFDLG9CQUFvQixDQUFDLGFBQWEsRUFBQztZQUMvQyxPQUFPLEVBQUUsSUFBSSxxQ0FBMkIsQ0FBQyxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLEtBQUssRUFBRSxHQUFHLENBQUM7WUFDckYsT0FBTyxFQUFFO2dCQUNOLE9BQU8sRUFBRTtvQkFDUixhQUFhLENBQUMsYUFBYSxDQUFDLEVBQUMsZUFBZSxFQUFFLDBCQUEwQixFQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO2lCQUNyRjthQUNIO1lBQ0QsY0FBYyxFQUFFLENBQ2QsQ0FBQyxxQkFBcUIsQ0FBQyxDQUN4QjtTQUNGLENBQUMsQ0FBQztRQUVILGFBQWEsQ0FBQyxvQkFBb0IsQ0FBQyxxQkFBcUIsRUFBQztZQUN2RCxPQUFPLEVBQUUsd0NBQThCLENBQUMsVUFBVTtZQUNsRCxPQUFPLEVBQUU7Z0JBQ04sT0FBTyxFQUFFO29CQUNSLGFBQWEsQ0FBQyxhQUFhLENBQUMsRUFBQyxlQUFlLEVBQUUsMEJBQTBCLEVBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7aUJBQ3JGO2FBQ0g7WUFDRCxjQUFjLEVBQUUsQ0FDZCxDQUFDLHFCQUFxQixDQUFDLENBQ3hCO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsYUFBYSxDQUFDLG9CQUFvQixDQUFDLHlCQUF5QixFQUFDO1lBQzNELE9BQU8sRUFBRSx3Q0FBOEIsQ0FBQyxjQUFjO1lBQ3RELE9BQU8sRUFBRTtnQkFDTixPQUFPLEVBQUU7b0JBQ1IsYUFBYSxDQUFDLGFBQWEsQ0FBQyxFQUFDLGVBQWUsRUFBRSwwQkFBMEIsRUFBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztpQkFDckY7YUFDSDtZQUNELGNBQWMsRUFBRSxDQUNkLENBQUMscUJBQXFCLENBQUMsQ0FDeEI7U0FDRixDQUFDLENBQUM7UUFFSCw4QkFBOEI7UUFDOUIsTUFBTSxjQUFjLEdBQUcsSUFBSSxlQUFNLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3hELFVBQVUsRUFBRSxvQ0FBb0MsR0FBRyxJQUFJLENBQUMsT0FBTztZQUMvRCxhQUFhLEVBQUUsMkJBQWEsQ0FBQyxPQUFPO1lBQ3BDLGdCQUFnQixFQUFFLElBQUk7WUFDdEIsVUFBVSxFQUFFLHlCQUFnQixDQUFDLFdBQVc7WUFDeEMsVUFBVSxFQUFFLElBQUk7WUFDaEIsU0FBUyxFQUFFLElBQUk7WUFDZixpQkFBaUIsRUFBRSwwQkFBaUIsQ0FBQyxTQUFTO1lBQzlDLGVBQWUsRUFBRSx3QkFBZSxDQUFDLHNCQUFzQjtZQUN2RCxnQkFBZ0IsRUFBRSxLQUFLO1lBQ3ZCLGNBQWMsRUFBRSxDQUFDO29CQUNmLFVBQVUsRUFBRSxzQkFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUM7b0JBQzlCLFdBQVcsRUFBRSxDQUFDOzRCQUNWLFlBQVksRUFBRSxxQkFBWSxDQUFDLG1CQUFtQjs0QkFDOUMsZUFBZSxFQUFFLHNCQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQzt5QkFDckMsQ0FBQztpQkFDTCxDQUFDO1NBQ0QsQ0FBQyxDQUFDO1FBRUgsTUFBTSx1QkFBdUIsR0FBRyxJQUFJLGVBQU0sQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUU7WUFDMUUsVUFBVSxFQUFFLG9DQUFvQyxHQUFHLElBQUksQ0FBQyxPQUFPO1lBQy9ELHNCQUFzQixFQUFFLGNBQWM7WUFDdEMsYUFBYSxFQUFFLDJCQUFhLENBQUMsT0FBTztZQUNwQyxnQkFBZ0IsRUFBRSxJQUFJO1lBQ3RCLFVBQVUsRUFBRSx5QkFBZ0IsQ0FBQyxHQUFHO1lBQ2hDLGFBQWEsRUFBRSx3QkFBd0I7WUFDdkMsVUFBVSxFQUFFLElBQUk7WUFDaEIsU0FBUyxFQUFFLElBQUk7WUFDZixpQkFBaUIsRUFBRSwwQkFBaUIsQ0FBQyxTQUFTO1lBQzlDLGVBQWUsRUFBRSx3QkFBZSxDQUFDLHNCQUFzQjtZQUN2RCxnQkFBZ0IsRUFBRSxLQUFLO1lBQ3ZCLGNBQWMsRUFBRSxDQUFDO29CQUNmLFVBQVUsRUFBRSxzQkFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUM7b0JBQzlCLFdBQVcsRUFBRSxDQUFDOzRCQUNWLFlBQVksRUFBRSxxQkFBWSxDQUFDLG1CQUFtQjs0QkFDOUMsZUFBZSxFQUFFLHNCQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQzt5QkFDckMsQ0FBQztpQkFDTCxDQUFDO1NBQ0QsQ0FBQyxDQUFDO1FBRUgsdUNBQXVDO1FBQ3ZDLE1BQU0sMkJBQTJCLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSw2QkFBNkIsRUFBRTtZQUNwRixTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMseUJBQXlCLENBQUM7WUFDOUQsUUFBUSxFQUFFLDBDQUEwQztZQUNwRCxlQUFlLEVBQUUsRUFDaEI7U0FDRixDQUFDLENBQUM7UUFFSCxpQkFBaUIsQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDNUQsT0FBTyxFQUFFO2dCQUNQLGlCQUFpQjtnQkFDakIsYUFBYTtnQkFDYixxQkFBcUI7Z0JBQ3JCLGlCQUFpQjthQUNsQjtZQUNELFNBQVMsRUFBRTtnQkFDVCxHQUFHO2FBQ0o7WUFDRCxVQUFVLEVBQUU7Z0JBQ1YsSUFBSSxHQUFHLENBQUMsWUFBWSxDQUFDLDJCQUEyQixDQUFDLE9BQU8sQ0FBQzthQUMxRDtTQUNGLENBQUMsQ0FBQyxDQUFDO1FBRUosTUFBTSw2QkFBNkIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxjQUFjLENBQUM7WUFDM0QsVUFBVSxFQUFFO2dCQUNWLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztvQkFDdEIsR0FBRyxFQUFFLHlCQUF5QjtvQkFDOUIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztvQkFDeEIsT0FBTyxFQUFFO3dCQUNQLHFCQUFxQjt3QkFDckIsc0JBQXNCO3dCQUN0QixtQkFBbUI7cUJBQ3BCO29CQUNELFNBQVMsRUFBRTt3QkFDVCxlQUFlLEdBQUcsSUFBSSxDQUFDLE1BQU0sR0FBRSxHQUFHLEdBQUcsSUFBSSxDQUFDLE9BQU8sR0FBRyxvQ0FBb0M7cUJBQ3pGO2lCQUNGLENBQUM7Z0JBQ0YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO29CQUN0QixHQUFHLEVBQUUsUUFBUTtvQkFDYixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO29CQUN4QixPQUFPLEVBQUU7d0JBQ1AsZUFBZTtxQkFDaEI7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULEdBQUc7cUJBQ0o7aUJBQ0YsQ0FBQztnQkFDRixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLEdBQUcsRUFBRSxTQUFTO29CQUNkLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRTt3QkFDUCx5QkFBeUI7d0JBQ3pCLGlCQUFpQjt3QkFDakIsY0FBYzt3QkFDZCxlQUFlO3dCQUNmLGNBQWM7d0JBQ2QsaUJBQWlCO3dCQUNqQixpQkFBaUI7d0JBQ2pCLHNCQUFzQjtxQkFDdkI7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULHVCQUF1QixDQUFDLFNBQVM7d0JBQ2pDLHVCQUF1QixDQUFDLFNBQVMsR0FBRyxJQUFJO3FCQUN6QztpQkFDRixDQUFDO2dCQUNGLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztvQkFDdEIsR0FBRyxFQUFFLGFBQWE7b0JBQ2xCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRTt3QkFDUCxhQUFhO3dCQUNiLGNBQWM7d0JBQ2QsNEJBQTRCO3dCQUM1QixxQkFBcUI7d0JBQ3JCLDJCQUEyQjtxQkFDNUI7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULGlCQUFpQixHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxPQUFPLEdBQUUsZ0JBQWdCO3dCQUN0RSxpQkFBaUIsR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLEdBQUcsR0FBRyxJQUFJLENBQUMsT0FBTyxHQUFFLGNBQWM7cUJBQ3JFO2lCQUNGLENBQUM7Z0JBQ0YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO29CQUN0QixHQUFHLEVBQUUsV0FBVztvQkFDaEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztvQkFDeEIsT0FBTyxFQUFFO3dCQUNQLHFCQUFxQjt3QkFDckIsa0JBQWtCO3dCQUNsQixtQkFBbUI7d0JBQ25CLGVBQWU7d0JBQ2YsZ0JBQWdCO3dCQUNoQixtQkFBbUI7d0JBQ25CLG9CQUFvQjt3QkFDcEIsd0JBQXdCO3FCQUN6QjtvQkFDRCxTQUFTLEVBQUU7d0JBQ1QsZUFBZSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxPQUFPLEdBQUUsYUFBYTt3QkFDakUsZUFBZSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxPQUFPLEdBQUUsVUFBVTt3QkFDOUQsZUFBZSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxPQUFPLEdBQUUsVUFBVTtxQkFDL0Q7aUJBQ0YsQ0FBQztnQkFDRixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLEdBQUcsRUFBRSxvQkFBb0I7b0JBQ3pCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRTt3QkFDUCw2QkFBNkI7cUJBQzlCO29CQUNELFNBQVMsRUFBRTt3QkFDVCxHQUFHO3FCQUNKO2lCQUNGLENBQUM7Z0JBQ0YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO29CQUN0QixHQUFHLEVBQUUsaUJBQWlCO29CQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO29CQUN4QixPQUFPLEVBQUU7d0JBQ1Asc0JBQXNCO3dCQUN0QixzQkFBc0I7d0JBQ3RCLGlCQUFpQjt3QkFDakIsa0JBQWtCO3dCQUNsQixvQkFBb0I7d0JBQ3BCLG9CQUFvQjt3QkFDcEIseUJBQXlCO3dCQUN6Qix5QkFBeUI7d0JBQ3pCLDZCQUE2Qjt3QkFDN0IsZ0NBQWdDO3dCQUNoQyx3Q0FBd0M7d0JBQ3hDLDBDQUEwQzt3QkFDMUMseUJBQXlCO3dCQUN6Qiw4QkFBOEI7d0JBQzlCLDBDQUEwQzt3QkFDMUMsMENBQTBDO3dCQUMxQyw2Q0FBNkM7d0JBQzdDLGdDQUFnQzt3QkFDaEMsc0NBQXNDO3dCQUN0QywrQkFBK0I7d0JBQy9CLG9CQUFvQjtxQkFDckI7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULHlDQUF5QyxDQUFDLGFBQWE7cUJBQ3hEO2lCQUNGLENBQUM7Z0JBQ0YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO29CQUN0QixHQUFHLEVBQUUsMkJBQTJCO29CQUNoQyxNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO29CQUN4QixPQUFPLEVBQUU7d0JBQ1AsYUFBYTtxQkFDZDtvQkFDRCxZQUFZLEVBQUU7d0JBQ1osZ0NBQWdDO3dCQUNoQyxzQ0FBc0M7d0JBQ3RDLDZCQUE2Qjt3QkFDN0IseUNBQXlDO3FCQUMxQztpQkFDRixDQUFDO2dCQUNGLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztvQkFDdEIsR0FBRyxFQUFFLHNCQUFzQjtvQkFDM0IsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztvQkFDeEIsT0FBTyxFQUFFO3dCQUNQLG9DQUFvQzt3QkFDcEMsMEJBQTBCO3dCQUMxQix1QkFBdUI7d0JBQ3ZCLCtCQUErQjt3QkFDL0IsNEJBQTRCO3dCQUM1QixnQkFBZ0I7d0JBQ2hCLG9CQUFvQjtxQkFDckI7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULGdDQUFnQzt3QkFDaEMsc0NBQXNDO3dCQUN0Qyw2QkFBNkI7d0JBQzdCLHlDQUF5QztxQkFDMUM7aUJBQ0YsQ0FBQztnQkFDRixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLEdBQUcsRUFBRSxxQkFBcUI7b0JBQzFCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRTt3QkFDUCxjQUFjO3FCQUNmO29CQUNELFNBQVMsRUFBRTt3QkFDVCxvQkFBb0IsR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLEdBQUcsR0FBRyxJQUFJLENBQUMsT0FBTyxHQUFFLG9CQUFvQjtxQkFDOUU7b0JBQ0QsVUFBVSxFQUFFO3dCQUNWLG9CQUFvQixFQUFDOzRCQUNuQix3QkFBd0IsRUFBRTtnQ0FDeEIsZUFBZTtnQ0FDZixjQUFjOzZCQUNmO3lCQUNGO3FCQUFDO2lCQUNMLENBQUM7Z0JBQ0YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO29CQUN0QixHQUFHLEVBQUUsb0JBQW9CO29CQUN6QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO29CQUN4QixPQUFPLEVBQUU7d0JBQ1AsY0FBYztxQkFDZjtvQkFDRCxTQUFTLEVBQUU7d0JBQ1QsMkJBQTJCLENBQUMsT0FBTztxQkFDcEM7b0JBQ0QsVUFBVSxFQUFFO3dCQUNWLFVBQVUsRUFBQzs0QkFDVCxxQkFBcUIsRUFBRTtnQ0FDckIsb0JBQW9CO2dDQUNwQix5QkFBeUI7Z0NBQ3pCLHNCQUFzQjtnQ0FDdEIseUJBQXlCOzZCQUMxQjt5QkFDRjtxQkFBQztpQkFDTCxDQUFDO2dCQUNGLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztvQkFDdEIsR0FBRyxFQUFFLFlBQVk7b0JBQ2pCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRTt3QkFDUCxpQkFBaUI7d0JBQ2pCLGlCQUFpQjt3QkFDakIsYUFBYTt3QkFDYixhQUFhO3dCQUNiLHFCQUFxQjt3QkFDckIsZ0JBQWdCO3FCQUNqQjtvQkFDRCxTQUFTLEVBQUU7d0JBQ1QsaUJBQWlCLENBQUMsTUFBTTt3QkFDeEIsd0JBQXdCLENBQUMsTUFBTTtxQkFDaEM7aUJBQ0YsQ0FBQztnQkFDRixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLEdBQUcsRUFBRSxzQkFBc0I7b0JBQzNCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRTt3QkFDUCxxQkFBcUI7cUJBQ3RCO29CQUNELFNBQVMsRUFBRTt3QkFDVCxvQkFBb0IsR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLEdBQUcsR0FBRyxJQUFJLENBQUMsT0FBTyxHQUFFLFFBQVE7cUJBQ2xFO2lCQUNGLENBQUM7Z0JBQ0YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO29CQUN0QixHQUFHLEVBQUUsb0JBQW9CO29CQUN6QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO29CQUN4QixPQUFPLEVBQUU7d0JBQ1AscUJBQXFCO3dCQUNyQix1Q0FBdUM7cUJBQ3hDO29CQUNELFNBQVMsRUFBRSx1QkFBdUI7aUJBQ25DLENBQUM7YUFDSDtTQUNGLENBQUMsQ0FBQztRQUVILHVCQUF1QixDQUFDLG1CQUFtQixDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUNsRSxPQUFPLEVBQUU7Z0JBQ1AsY0FBYztnQkFDZCxpQkFBaUI7Z0JBQ2pCLGlCQUFpQjtnQkFDakIsc0JBQXNCO2FBQ3ZCO1lBQ0QsU0FBUyxFQUFFO2dCQUNULHVCQUF1QixDQUFDLFNBQVM7Z0JBQ2pDLHVCQUF1QixDQUFDLFNBQVMsR0FBRyxJQUFJO2FBQ3pDO1lBQ0QsVUFBVSxFQUFFO2dCQUNWLElBQUksR0FBRyxDQUFDLFlBQVksQ0FBQywyQkFBMkIsQ0FBQyxPQUFPLENBQUM7YUFBQztTQUM3RCxDQUFDLENBQUMsQ0FBQztRQUVKLElBQUksR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUseUNBQXlDLEVBQUU7WUFDckUsV0FBVyxFQUFFLGtFQUFrRTtZQUMvRSxRQUFRLEVBQUMsNkJBQTZCO1lBQ3RDLGlCQUFpQixFQUFFLDRDQUE0QztZQUMvRCxLQUFLLEVBQUUsQ0FBQywyQkFBMkIsQ0FBQztTQUNyQyxDQUFDLENBQUM7UUFFSCxJQUFJLGlDQUFpQyxFQUFFLENBQUM7WUFDdEMsSUFBSSwyQ0FBdUIsQ0FBQyxJQUFJLEVBQUUsMENBQTBDLEVBQUU7Z0JBQzVFLFNBQVMsRUFBRTtvQkFDVCwyQkFBMkIsRUFBRSwyQkFBMkIsQ0FBQyxPQUFPO2lCQUNqRTtnQkFDRCxRQUFRLEVBQUU7b0JBQ1IsUUFBUSxFQUFFO3dCQUNSLFNBQVMsRUFBRSxJQUFJLENBQUMsT0FBTzt3QkFDdkIsSUFBSSxFQUFFLDJCQUEyQjtxQkFDbEM7aUJBQ0Y7Z0JBQ0QsV0FBVyxFQUFFLENBQUMsVUFBVSxDQUFDO2dCQUN6QiwwQkFBMEIsRUFBRSxFQUFFO2FBQy9CLENBQUMsQ0FBQztZQUVILElBQUksMkNBQXVCLENBQUMsSUFBSSxFQUFFLHVDQUF1QyxFQUFFO2dCQUN6RSxTQUFTLEVBQUU7b0JBQ1QsMkJBQTJCLEVBQUUsMkJBQTJCLENBQUMsT0FBTztpQkFDakU7Z0JBQ0QsUUFBUSxFQUFFO29CQUNSLEtBQUssRUFBRTt3QkFDTCxTQUFTLEVBQUUsSUFBSSxDQUFDLE9BQU87d0JBQ3ZCLFlBQVksRUFBRSwyQkFBMkI7d0JBQ3pDLElBQUksRUFBRSx3QkFBd0I7cUJBQy9CO2lCQUNGO2dCQUNELFdBQVcsRUFBRSxDQUFDLFVBQVUsRUFBRSxRQUFRLENBQUM7Z0JBQ25DLDBCQUEwQixFQUFFLEVBQUU7YUFDL0IsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztRQUVELE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSx5QkFBUyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUMvRCxRQUFRLEVBQUUsS0FBSztZQUNmLG1CQUFtQixFQUFFO2dCQUNuQixhQUFhLEVBQUUsMkJBQTJCLENBQUMsT0FBTztnQkFDbEQsd0JBQXdCLEVBQUU7b0JBQ3hCLG1CQUFtQixFQUFFO3dCQUNuQixZQUFZLEVBQUUsUUFBUTt3QkFDdEIsNENBQTRDO3dCQUM1QywwQ0FBMEM7d0JBQzFDLHdEQUF3RDtxQkFDekQ7aUJBQ0Y7Z0JBQ0Qsd0JBQXdCLEVBQUU7b0JBQ3hCLG1CQUFtQjtvQkFDbkIsOENBQThDO29CQUM5Qyw0QkFBNEI7b0JBRTVCLHlDQUF5QztvQkFDekMsNkJBQTZCO29CQUM3QixNQUFNO29CQUNOLG1CQUFtQixFQUFFO3dCQUNuQixZQUFZLEVBQUUsY0FBYzt3QkFDNUIsNENBQTRDO3dCQUM1QyxpQkFBaUIsRUFBRSxvQkFBb0IsR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLHFDQUFxQztxQkFDOUY7aUJBQ0Y7Z0JBQ0QseUJBQXlCO2dCQUN6QixxQkFBcUI7Z0JBQ3JCLGdEQUFnRDtnQkFDaEQsOEJBQThCO2dCQUU5QiwyQ0FBMkM7Z0JBQzNDLCtCQUErQjtnQkFDL0IsUUFBUTtnQkFDUiwyQkFBMkI7Z0JBQzNCLG9DQUFvQztnQkFDcEMsZ0RBQWdEO2dCQUNoRCw4Q0FBOEM7Z0JBQzlDLDREQUE0RDtnQkFDNUQsT0FBTztnQkFDUCxLQUFLO2dCQUNMLGlDQUFpQztnQkFDakMsa0NBQWtDO2dCQUNsQyw0QkFBNEI7Z0JBQzVCLEtBQUs7Z0JBQ0wsY0FBYyxFQUFFLENBQUMscUJBQXFCLENBQUMsZUFBZSxDQUFDO2dCQUN2RCxxQkFBcUI7Z0JBQ3JCLGtEQUFrRDtnQkFDbEQsOEJBQThCO2dCQUM5QixrQ0FBa0M7Z0JBQ2xDLEtBQUs7YUFDTjtZQUNELFVBQVUsRUFBRSw0QkFBNEIsR0FBRyxJQUFJLENBQUMsT0FBTztZQUN2RCxTQUFTLEVBQUUsQ0FBQyxhQUFhLENBQUMsYUFBYSxDQUFDLEVBQUMsZUFBZSxFQUFFLDBCQUEwQixFQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO1lBQzNHLEtBQUssRUFBRSxhQUFhLENBQUMsS0FBSztZQUMxQixvQ0FBb0M7WUFDcEMsb0JBQW9CLEVBQUUsU0FBUztZQUMvQiw0REFBNEQ7WUFDNUQsb0JBQW9CO1lBQ3BCLHNDQUFzQztZQUN0Qyx3REFBd0Q7WUFFeEQsMkNBQTJDO1lBQzNDLDZCQUE2QjtZQUM3QixzQ0FBc0M7WUFDdEMsa0RBQWtEO1lBQ2xELGdEQUFnRDtZQUNoRCw4REFBOEQ7WUFDOUQsU0FBUztZQUNULDhDQUE4QztZQUM5Qyw0REFBNEQ7WUFDNUQsT0FBTztZQUNQLDRDQUE0QztZQUM1QyxLQUFLO1lBQ0wsUUFBUSxFQUFFLGlCQUFpQixDQUFDLEtBQUs7WUFDakMsSUFBSSxFQUFFLENBQUM7b0JBQ0wsR0FBRyxFQUFFLFNBQVM7b0JBQ2QsS0FBSyxFQUFFLDJCQUEyQjtpQkFDbkMsQ0FBQztTQUNILENBQUMsQ0FBQztRQUVILGdCQUFnQixDQUFDLGtCQUFrQixDQUFDLDJCQUFhLENBQUMsT0FBTyxDQUFDLENBQUE7UUFFMUQsTUFBTSxzQkFBc0IsR0FBRyxJQUFJLDhCQUFjLENBQUMsSUFBSSxFQUFFLHdCQUF3QixFQUFFO1lBQ2hGLFFBQVEsRUFBRSxnQkFBZ0IsQ0FBQyxZQUFZO1lBQ3ZDLGVBQWUsRUFBRSwyQkFBMkIsQ0FBQyxRQUFRO1lBRXJELG9DQUFvQztZQUNwQyw0REFBNEQ7WUFDNUQsa0RBQWtEO1lBQ2xELElBQUksRUFBRSxDQUFDO29CQUNMLEdBQUcsRUFBRSxTQUFTO29CQUNkLEtBQUssRUFBRSwyQkFBMkI7aUJBQ25DLENBQUM7WUFDRixZQUFZLEVBQUU7Z0JBQ1osYUFBYSxFQUFFLDJCQUEyQixDQUFDLE9BQU87Z0JBQ2xELDhCQUE4QjtnQkFDOUIsMkJBQTJCO2dCQUMzQixvQ0FBb0M7Z0JBQ3BDLDhDQUE4QztnQkFDOUMsNERBQTREO2dCQUM1RCxPQUFPO2dCQUNQLEtBQUs7Z0JBQ0wsOEJBQThCO2dCQUM5QixxQkFBcUI7Z0JBQ3JCLGdEQUFnRDtnQkFDaEQsOEJBQThCO2dCQUU5QiwyQ0FBMkM7Z0JBQzNDLCtCQUErQjtnQkFDL0IsUUFBUTtnQkFDUiwyQkFBMkI7Z0JBQzNCLG9DQUFvQztnQkFDcEMsOENBQThDO2dCQUM5Qyw0REFBNEQ7Z0JBQzVELE9BQU87Z0JBQ1AsS0FBSztnQkFDTCxpQ0FBaUM7Z0JBQ2pDLGtDQUFrQztnQkFDbEMsNEJBQTRCO2dCQUM1QixLQUFLO2dCQUNMLHFDQUFxQztnQkFDckMscUJBQXFCO2dCQUNyQixrREFBa0Q7Z0JBQ2xELDhCQUE4QjtnQkFDOUIsa0NBQWtDO2dCQUNsQyxLQUFLO2FBQ047U0FDRixDQUFDLENBQUM7UUFFSCxzQkFBc0IsQ0FBQyxhQUFhLENBQUMsZ0JBQWdCLENBQUMsQ0FBQTtRQUN0RCxzQkFBc0IsQ0FBQyxrQkFBa0IsQ0FBQywyQkFBYSxDQUFDLE9BQU8sQ0FBQyxDQUFBO1FBRWhFLE1BQU0sYUFBYSxHQUFHLElBQUksc0JBQU0sQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFO1lBQ3RELE9BQU8sRUFBRSxTQUFTO1lBQ2xCLE9BQU8sRUFBRSxlQUFlO1lBQ3hCLFFBQVEsRUFBRSxnQkFBZ0IsQ0FBQyxZQUFZO1lBQ3ZDLGVBQWUsRUFBRSxzQkFBc0IsQ0FBQyxlQUFlO1lBRXZELG9DQUFvQztZQUNwQyxZQUFZLEVBQUU7Z0JBQ1osWUFBWSxFQUFFLFFBQVE7YUFDdkI7WUFDRCxJQUFJLEVBQUUsQ0FBQztvQkFDTCxHQUFHLEVBQUUsU0FBUztvQkFDZCxLQUFLLEVBQUUsMkJBQTJCO2lCQUNuQyxDQUFDO1NBQ0gsQ0FBQyxDQUFDO1FBRUgsYUFBYSxDQUFDLGFBQWEsQ0FBQyxzQkFBc0IsQ0FBQyxDQUFBO1FBQ25ELGFBQWEsQ0FBQyxrQkFBa0IsQ0FBQywyQkFBYSxDQUFDLE9BQU8sQ0FBQyxDQUFBO1FBRXZELHVDQUF1QztRQUN2QyxNQUFNLG9DQUFvQyxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsc0NBQXNDLEVBQUU7WUFDdEcsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGtCQUFrQixDQUNuQyxJQUFJLEdBQUcsQ0FBQyxZQUFZLENBQUMsNkNBQTZDLENBQUMsQ0FDcEU7WUFDRCxRQUFRLEVBQUUsc0NBQXNDO1lBQ2hELHFCQUFxQjtZQUNyQixJQUFJO1NBQ0wsQ0FBQyxDQUFDO1FBRUgsTUFBTSw4QkFBOEIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxjQUFjLENBQUM7WUFDNUQsVUFBVSxFQUFFO2dCQUNWLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztvQkFDdEIsR0FBRyxFQUFFLGlDQUFpQztvQkFDdEMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztvQkFDeEIsT0FBTyxFQUFFO3dCQUNQLG9DQUFvQztxQkFDckM7b0JBQ0QsU0FBUyxFQUFFO3dCQUNULHNCQUFzQixDQUFDLGtCQUFrQjtxQkFDMUM7b0JBQ0QsVUFBVSxFQUFFO3dCQUNWLFNBQVMsRUFBQzs0QkFDUixjQUFjLEVBQUU7Z0NBQ2QscUNBQXFDOzZCQUN0Qzt5QkFDRjtxQkFBQztpQkFDTCxDQUFDO2dCQUNGLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztvQkFDdEIsR0FBRyxFQUFFLDBCQUEwQjtvQkFDL0IsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztvQkFDeEIsT0FBTyxFQUFFO3dCQUNQLDBCQUEwQjt3QkFDMUIsK0JBQStCO3dCQUMvQixvQkFBb0I7d0JBQ3BCLHVCQUF1Qjt3QkFDdkIsNEJBQTRCO3FCQUM3QjtvQkFDRCxTQUFTLEVBQUU7d0JBQ1QsTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLEdBQUcsYUFBYSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxPQUFPLEdBQUcsV0FBVzt3QkFDeEYsTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLEdBQUcsYUFBYSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxPQUFPLEdBQUcsZ0JBQWdCLEdBQUcsZ0JBQWdCLENBQUMsWUFBWSxHQUFHLElBQUk7d0JBQ3BJLE1BQU0sR0FBRyxJQUFJLENBQUMsU0FBUyxHQUFHLGFBQWEsR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLEdBQUcsR0FBRyxJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQyxZQUFZLEdBQUcsSUFBSTtxQkFDNUg7aUJBQ0YsQ0FBQztnQkFDRixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLEdBQUcsRUFBRSxpQ0FBaUM7b0JBQ3RDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRTt3QkFDUCxzQ0FBc0M7d0JBQ3RDLHFEQUFxRDt3QkFDckQsNENBQTRDO3dCQUM1QywyQ0FBMkM7cUJBQzVDO29CQUNELFNBQVMsRUFBRTt3QkFDVCxHQUFHO3FCQUNKO2lCQUNGLENBQUM7YUFDSDtTQUNGLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUscUNBQXFDLEVBQUU7WUFDakUsV0FBVyxFQUFFLG9HQUFvRztZQUNqSCxRQUFRLEVBQUMsOEJBQThCO1lBQ3ZDLGlCQUFpQixFQUFFLHdDQUF3QztZQUMzRCxLQUFLLEVBQUUsQ0FBQyxvQ0FBb0MsQ0FBQztTQUM5QyxDQUFDLENBQUM7UUFFSCx3QkFBd0IsQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDbkUsT0FBTyxFQUFFO2dCQUNQLGlCQUFpQjtnQkFDakIsYUFBYTtnQkFDYixzQkFBc0I7YUFDdkI7WUFDRCxTQUFTLEVBQUU7Z0JBQ1QsR0FBRzthQUNKO1lBQ0QsVUFBVSxFQUFFO2dCQUNWLElBQUksR0FBRyxDQUFDLFlBQVksQ0FBQywyQkFBMkIsQ0FBQyxPQUFPLENBQUM7YUFBQztTQUM3RCxDQUFDLENBQUMsQ0FBQztRQUVKLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxNQUFNLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSx1QkFBdUIsRUFBRTtZQUNuRixJQUFJLEVBQUUscUJBQXFCO1lBQzNCLG9DQUFvQztZQUNwQyxXQUFXLEVBQUUsMENBQTBDO1lBQ3ZELHFCQUFxQixFQUFFLElBQUk7WUFDM0IsS0FBSyxFQUFFLFNBQVM7WUFDaEIsV0FBVztZQUNYLGdCQUFnQjtZQUNoQixvQkFBb0I7WUFDcEIsTUFBTTtZQUNOLHNCQUFzQixFQUFFO2dCQUN0Qix3Q0FBd0M7Z0JBQ3hDLDZCQUE2QixFQUFFLElBQUk7Z0JBQ25DLG1CQUFtQjtnQkFDbkIsc0RBQXNEO2dCQUN0RCxvREFBb0Q7Z0JBQ3BELEtBQUs7Z0JBQ0wsK0JBQStCLEVBQUUsS0FBSztnQkFDdEMsb0JBQW9CLEVBQUUsS0FBSztnQkFDM0IsbUJBQW1CLEVBQUU7b0JBQ25CLHVCQUF1QixFQUFFO3dCQUN2QixnQkFBZ0IsRUFBRSwwQ0FBZ0IsQ0FBQyxHQUFHO3dCQUN0QyxNQUFNLEVBQUUsd0JBQXdCLENBQUMsTUFBTTtxQkFDeEM7b0JBQ0QsY0FBYyxFQUFFLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQyxVQUFVLEdBQUcsR0FBRztpQkFDbkU7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUdILHlCQUFlLENBQUMsNkJBQTZCLENBQUMsSUFBSSxFQUFDLG9FQUFvRSxFQUNySDtZQUNFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxvSEFBb0g7YUFDN0g7U0FDRixDQUNGLENBQUM7UUFFRix5QkFBZSxDQUFDLDZCQUE2QixDQUFDLElBQUksRUFBQyx3RUFBd0UsRUFDekg7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsa01BQWtNO2FBQzNNO1NBQ0YsQ0FDRixDQUFDO0lBRUosQ0FBQztDQUNGO0FBMzFCRCxvREEyMUJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RhY2ssIFN0YWNrUHJvcHMsIER1cmF0aW9uLCBSZW1vdmFsUG9saWN5LCBDZm5PdXRwdXQgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCB7IEtleSB9IGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgeyBDZm5BcHAsIENmbkRvbWFpbiwgQ2ZuVXNlclByb2ZpbGUgfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXNhZ2VtYWtlclwiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgRmxvd0xvZ0Rlc3RpbmF0aW9uLCBGbG93TG9nVHJhZmZpY1R5cGUsIFZwYywgU3VibmV0VHlwZSwgU2VjdXJpdHlHcm91cCwgUGVlciwgUG9ydCwgSW50ZXJmYWNlVnBjRW5kcG9pbnRBd3NTZXJ2aWNlLCBJbnRlcmZhY2VWcGNFbmRwb2ludFNlcnZpY2UgfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjMlwiO1xuaW1wb3J0IHsgTG9nR3JvdXAsIFJldGVudGlvbkRheXMgfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIGNvZGVjb21taXQgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZGVjb21taXQnO1xuaW1wb3J0ICogYXMgYXRoZW5hIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hdGhlbmEnO1xuaW1wb3J0IHsgQmxvY2tQdWJsaWNBY2Nlc3MsIEJ1Y2tldCwgQnVja2V0RW5jcnlwdGlvbiwgT2JqZWN0T3duZXJzaGlwLCBTdG9yYWdlQ2xhc3MgfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgeyBFbmNyeXB0aW9uT3B0aW9uIH0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1zdGVwZnVuY3Rpb25zLXRhc2tzXCI7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcbmltcG9ydCB7IENmblByaW5jaXBhbFBlcm1pc3Npb25zIH0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYWtlZm9ybWF0aW9uXCI7XG5cbmV4cG9ydCBjbGFzcyBTYWdlTWFrZXJEb21haW5TdGFjayBleHRlbmRzIFN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCBjb250ZXh0U3RyaW5nID0gKGtleTogc3RyaW5nLCBkZWZhdWx0VmFsdWU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KGtleSk7XG4gICAgICByZXR1cm4gdmFsdWUgPT09IHVuZGVmaW5lZCA/IGRlZmF1bHRWYWx1ZSA6IHZhbHVlO1xuICAgIH07XG5cbiAgICBjb25zdCBjb250ZXh0Qm9vbGVhbiA9IChrZXk6IHN0cmluZywgZGVmYXVsdFZhbHVlOiBib29sZWFuKTogYm9vbGVhbiA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KGtleSk7XG4gICAgICByZXR1cm4gdmFsdWUgPT09IHVuZGVmaW5lZCA/IGRlZmF1bHRWYWx1ZSA6IHZhbHVlO1xuICAgIH07XG5cbiAgICBjb25zdCBzYWdlbWFrZXJfcmVzdHJpY3RfY2lkcl9wcmVzaWduZWRfdXJsID0gY29udGV4dFN0cmluZyhcInNhZ2VtYWtlclJlc3RyaWN0Q2lkclByZXNpZ25lZFVybFwiLCBcIjAuMC4wLjAvMFwiKTtcbiAgICBjb25zdCBzYWdlbWFrZXJfcHJlc2lnbmVkX3VybF90cnVzdGVkX3ByaW5jaXBhbF9hcm4gPSBjb250ZXh0U3RyaW5nKFwic2FnZW1ha2VyUHJlc2lnbmVkVXJsVHJ1c3RlZFByaW5jaXBhbEFyblwiLCBcImFybjphd3M6aWFtOjoxMjM0NTY3ODkwMTI6cm9sZS9BZG1pblwiKTtcbiAgICBjb25zdCBjd192cGNfZmxvd19sb2dzX2xvZ19ncm91cF9uYW1lID0gY29udGV4dFN0cmluZyhcImNsb3VkV2F0Y2hWcGNGbG93TG9nc0xvZ0dyb3VwTmFtZVwiLCBcIi9hd3MvdnBjL2Zsb3dsb2dzL1NhZ2VNYWtlckRvbWFpblN0YWNrXCIpO1xuICAgIGNvbnN0IHNlY3VyaXR5X2xha2VfZGF0YWJhc2VfbmFtZSA9IGNvbnRleHRTdHJpbmcoXCJzZWN1cml0eUxha2VEYXRhYmFzZU5hbWVcIiwgXCJhbWF6b25fc2VjdXJpdHlfbGFrZV9nbHVlX2RiX3VzX2Vhc3RfMVwiKTtcbiAgICBjb25zdCBzZWN1cml0eV9sYWtlX3RhYmxlX25hbWUgPSBjb250ZXh0U3RyaW5nKFwic2VjdXJpdHlMYWtlVGFibGVOYW1lXCIsIFwiYW1hem9uX3NlY3VyaXR5X2xha2VfdGFibGVfdXNfZWFzdF8xX3NoX2ZpbmRpbmdzXzJfMFwiKTtcbiAgICBjb25zdCBhdGhlbmFfd29ya2dyb3VwX25hbWUgPSBjb250ZXh0U3RyaW5nKFwiYXRoZW5hV29ya2dyb3VwTmFtZVwiLCBcInNlY3VyaXR5X2xha2VfaW5zaWdodHNcIik7XG4gICAgY29uc3QgYmVkcm9ja19tb2RlbF9pZCA9IGNvbnRleHRTdHJpbmcoXCJiZWRyb2NrTW9kZWxJZFwiLCBcInVzLmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNlwiKTtcbiAgICBjb25zdCBjcmVhdGVfbGFrZV9mb3JtYXRpb25fcGVybWlzc2lvbnMgPSBjb250ZXh0Qm9vbGVhbihcImNyZWF0ZUxha2VGb3JtYXRpb25QZXJtaXNzaW9uc1wiLCBmYWxzZSk7XG4gICAgY29uc3QgYmVkcm9ja19tb2RlbF9yZXNvdXJjZXMgPSBiZWRyb2NrX21vZGVsX2lkLnN0YXJ0c1dpdGgoXCJhcm46XCIpXG4gICAgICA/IFtcbiAgICAgICAgYmVkcm9ja19tb2RlbF9pZCxcbiAgICAgICAgXCJhcm46XCIgKyB0aGlzLnBhcnRpdGlvbiArIFwiOmJlZHJvY2s6Kjo6Zm91bmRhdGlvbi1tb2RlbC8qXCIsXG4gICAgICBdXG4gICAgICA6IGJlZHJvY2tfbW9kZWxfaWQuc3RhcnRzV2l0aChcInVzLlwiKSB8fCBiZWRyb2NrX21vZGVsX2lkLnN0YXJ0c1dpdGgoXCJldS5cIikgfHwgYmVkcm9ja19tb2RlbF9pZC5zdGFydHNXaXRoKFwiYXBhYy5cIikgfHwgYmVkcm9ja19tb2RlbF9pZC5zdGFydHNXaXRoKFwiZ2xvYmFsLlwiKVxuICAgICAgICA/IFtcbiAgICAgICAgICBcImFybjpcIiArIHRoaXMucGFydGl0aW9uICsgXCI6YmVkcm9jazpcIiArIHRoaXMucmVnaW9uICsgXCI6XCIgKyB0aGlzLmFjY291bnQgKyBcIjppbmZlcmVuY2UtcHJvZmlsZS9cIiArIGJlZHJvY2tfbW9kZWxfaWQsXG4gICAgICAgICAgXCJhcm46XCIgKyB0aGlzLnBhcnRpdGlvbiArIFwiOmJlZHJvY2s6Kjo6Zm91bmRhdGlvbi1tb2RlbC8qXCIsXG4gICAgICAgIF1cbiAgICAgICAgOiBbXG4gICAgICAgICAgXCJhcm46XCIgKyB0aGlzLnBhcnRpdGlvbiArIFwiOmJlZHJvY2s6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOjpmb3VuZGF0aW9uLW1vZGVsL1wiICsgYmVkcm9ja19tb2RlbF9pZCxcbiAgICAgICAgXTtcblxyXG4gICAgLy8gQ29kZUNvbW1pdCByZXBvc2l0b3J5XHJcbiAgICBjb25zdCBzYWdlbWFrZXJfbm90ZWJvb2tfbWxfaW5zaWdodHNfcmVwb3NpdG9yeSA9IG5ldyBjb2RlY29tbWl0LlJlcG9zaXRvcnkodGhpcywgJ3NhZ2VtYWtlcl9ub3RlYm9va19tbF9pbnNpZ2h0c19yZXBvc2l0b3J5Jywge1xyXG4gICAgICByZXBvc2l0b3J5TmFtZTogJ3NhZ2VtYWtlcl9tbF9pbnNpZ2h0c19yZXBvJyxcclxuICAgICAgZGVzY3JpcHRpb246ICdSZXBvc2l0b3J5IGZvciBTYWdlTWFrZXIgbm90ZWJvb2tzIHRvIHJ1biBhbmFseXRpY3MgZm9yIFNlY3VyaXR5IExha2UuJyxcclxuICAgICAgY29kZTogY29kZWNvbW1pdC5Db2RlLmZyb21aaXBGaWxlKGpvaW4oX19kaXJuYW1lLCBcIi4uL25vdGVib29rcy9ub3RlYm9va3MuemlwXCIpLCBcIm1haW5cIilcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywnc2FnZW1ha2VyLW5vdGVib29rLW1sLWluc2lnaHRzLXJlcG9zaXRvcnktVVJMJywge1xyXG4gICAgICBkZXNjcmlwdGlvbjonVGhlIENvZGVDb21taXQgcmVwb3NpdG9yeSBVUkwgdG8gY2xvbmUgd2l0aGluIHlvdXIgU2FnZU1ha2VyIHVzZXItcHJvZmlsZSBub3RlYm9vay4nLFxyXG4gICAgICB2YWx1ZTogc2FnZW1ha2VyX25vdGVib29rX21sX2luc2lnaHRzX3JlcG9zaXRvcnkucmVwb3NpdG9yeUNsb25lVXJsSHR0cFxyXG4gICAgfSlcclxuXHJcblxyXG4gICAgLy8gS01TIEtleSBmb3IgUzMgYnVja2V0XHJcbiAgICBjb25zdCBhdGhlbmFfczNfb3V0cHV0X2ttc19rZXkgPSBuZXcgS2V5KHRoaXMsIFwiYXRoZW5hX3MzX291dHB1dF9rbXNfa2V5XCIsIHtcclxuICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxyXG4gICAgICBwZW5kaW5nV2luZG93OiBEdXJhdGlvbi5kYXlzKDcpLFxyXG4gICAgICBkZXNjcmlwdGlvbjogXCJLTVMga2V5IGZvciBTMyBidWNrZXQgdG8gc3RvcmUgYXRoZW5hIHdvcmtncm91cCBvdXRwdXQuXCIsXHJcbiAgICAgIGVuYWJsZUtleVJvdGF0aW9uOiB0cnVlLFxyXG4gICAgICBhbGlhczogXCJhdGhlbmFfczNfb3V0cHV0X2ttc19rZXlcIlxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gS01TIEtleSBmb3IgU2FnZU1ha2VyIERvbWFpblxyXG4gICAgY29uc3Qgc2FnZW1ha2VyX2ttc19rZXkgPSBuZXcgS2V5KHRoaXMsIFwic2FnZW1ha2VyX2ttc19rZXlcIiwge1xyXG4gICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXHJcbiAgICAgIHBlbmRpbmdXaW5kb3c6IER1cmF0aW9uLmRheXMoNyksXHJcbiAgICAgIGRlc2NyaXB0aW9uOiBcIktNUyBrZXkgZm9yIFNhZ2VNYWtlciBEb21haW4gcmVzb3VyY2VzLlwiLFxyXG4gICAgICBlbmFibGVLZXlSb3RhdGlvbjogdHJ1ZSxcclxuICAgICAgYWxpYXM6IFwic2FnZW1ha2VyX2RvbWFpbl9rbXNfa2V5XCJcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IGN3X2Zsb3dfbG9ncyA9IG5ldyBMb2dHcm91cCh0aGlzLCBcImN3X2Zsb3dfbG9nc1wiLCB7XG4gICAgICBsb2dHcm91cE5hbWU6IGN3X3ZwY19mbG93X2xvZ3NfbG9nX2dyb3VwX25hbWUsXG4gICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICByZXRlbnRpb246IFJldGVudGlvbkRheXMuT05FX1lFQVIsXG4gICAgICBlbmNyeXB0aW9uS2V5OiBzYWdlbWFrZXJfa21zX2tleVxuICAgICAgfSk7XHJcbiAgICBcclxuICAgIHNhZ2VtYWtlcl9rbXNfa2V5LmFkZFRvUmVzb3VyY2VQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgXCJrbXM6RW5jcnlwdCpcIixcclxuICAgICAgICBcImttczpEZWNyeXB0KlwiLFxyXG4gICAgICAgIFwia21zOlJlRW5jcnlwdCpcIixcclxuICAgICAgICBcImttczpHZW5lcmF0ZURhdGFLZXkqXCIsXHJcbiAgICAgICAgXCJrbXM6RGVzY3JpYmUqXCJcclxuICAgICAgXSxcclxuICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgXCIqXCJcclxuICAgICAgXSxcclxuICAgICAgcHJpbmNpcGFsczogW1xyXG4gICAgICAgIG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImxvZ3MuXCIgKyB0aGlzLnJlZ2lvbiArIFwiLmFtYXpvbmF3cy5jb21cIilcclxuICAgICAgXSxcbiAgICAgIGNvbmRpdGlvbnM6e1xuICAgICAgICBBcm5FcXVhbHM6e1xuICAgICAgICAgIFwia21zOkVuY3J5cHRpb25Db250ZXh0OmF3czpsb2dzOmFyblwiOiBbXG4gICAgICAgICAgICBcImFybjphd3M6bG9nczpcIiArIHRoaXMucmVnaW9uICsgXCI6XCIgKyB0aGlzLmFjY291bnQrIFwiOmxvZy1ncm91cDpcIiArIGN3X3ZwY19mbG93X2xvZ3NfbG9nX2dyb3VwX25hbWVcbiAgICAgICAgICBdXG4gICAgICAgIH19IFxuICAgIH0pKTtcblxyXG4gICAgLy8gQ3JlYXRlIFNhZ2VNYWtlciBWUENcclxuICAgIGNvbnN0IHNhZ2VtYWtlcl92cGMgPSBuZXcgVnBjKHRoaXMsIFwic2FnZW1ha2VyX3ZwY1wiLCB7XHJcbiAgICAgIG1heEF6czogMixcclxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xyXG4gICAgICAgIHtcclxuICAgICAgICAgIGNpZHJNYXNrOiAyNCxcclxuICAgICAgICAgIG5hbWU6IFwicHVibGljX3N1Ym5ldF9mb3JfbmF0X2d3XCIsXHJcbiAgICAgICAgICBzdWJuZXRUeXBlOiBTdWJuZXRUeXBlLlBVQkxJQyxcclxuICAgICAgICAgIG1hcFB1YmxpY0lwT25MYXVuY2g6IGZhbHNlXHJcbiAgICAgICAgfSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICBjaWRyTWFzazogMjQsXHJcbiAgICAgICAgICBuYW1lOiBcIndvcmtsb2FkX3N1Ym5ldF93aXRoX25hdFwiLFxyXG4gICAgICAgICAgc3VibmV0VHlwZTogU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIF0sXHJcbiAgICAgIGZsb3dMb2dzOiB7XHJcbiAgICAgICAgXCJzM1wiOiB7XHJcbiAgICAgICAgICBkZXN0aW5hdGlvbjogRmxvd0xvZ0Rlc3RpbmF0aW9uLnRvQ2xvdWRXYXRjaExvZ3MoY3dfZmxvd19sb2dzKSxcclxuICAgICAgICAgIHRyYWZmaWNUeXBlOiBGbG93TG9nVHJhZmZpY1R5cGUuQUxMLFxyXG4gICAgICB9fVxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3Qgc2FnZW1ha2VyX3dvcmtsb2FkX3NnID0gbmV3IFNlY3VyaXR5R3JvdXAodGhpcywgXCJzYWdlbWFrZXJfd29ya2xvYWRfc2dcIiwge1xyXG4gICAgICB2cGM6IHNhZ2VtYWtlcl92cGMsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlNhZ2VNYWtlciBXb3JrbG9hZCBTR1wiLFxyXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiBmYWxzZSxcclxuICAgICAgc2VjdXJpdHlHcm91cE5hbWU6IFwic2FnZW1ha2VyX3dvcmtsb2FkX3NnXCJcclxuICAgIH0pO1xyXG5cclxuICAgIHNhZ2VtYWtlcl93b3JrbG9hZF9zZy5jb25uZWN0aW9ucy5hbGxvd1RvKHNhZ2VtYWtlcl93b3JrbG9hZF9zZywgUG9ydC50Y3BSYW5nZSg4MTkyLDY1NTM1KSwgXCJDb21tdW5pY2F0aW9uIHJlcXVpcmVkIHdpdGggU2FnZU1ha2VyIHNlcnZpY2Utb3duZWQgVlBDXCIpXHJcbiAgICBzYWdlbWFrZXJfd29ya2xvYWRfc2cuY29ubmVjdGlvbnMuYWxsb3dUbyhzYWdlbWFrZXJfd29ya2xvYWRfc2csIFBvcnQudWRwKDUwMCksIFwiQ29tbXVuaWNhdGlvbiByZXF1aXJlZCB3aXRoIFNhZ2VNYWtlciBzZXJ2aWNlLW93bmVkIFZQQ1wiKVxyXG4gICAgc2FnZW1ha2VyX3dvcmtsb2FkX3NnLmNvbm5lY3Rpb25zLmFsbG93VG8oc2FnZW1ha2VyX3dvcmtsb2FkX3NnLCBQb3J0LmVzcCgpLCBcIkNvbW11bmljYXRpb24gcmVxdWlyZWQgd2l0aCBTYWdlTWFrZXIgc2VydmljZS1vd25lZCBWUENcIilcclxuICAgIHNhZ2VtYWtlcl93b3JrbG9hZF9zZy5jb25uZWN0aW9ucy5hbGxvd1RvKFBlZXIuYW55SXB2NCgpLCBQb3J0LnRjcCg0NDMpLCBcIkFsbG93IEhUVFBTIE91dGJvdW5kIGZvciBlZ3Jlc3Mtb25seSBpbnRlcm5ldCBhY2Nlc3NcIilcclxuICAgIHNhZ2VtYWtlcl93b3JrbG9hZF9zZy5jb25uZWN0aW9ucy5hbGxvd1RvKFBlZXIuYW55SXB2NCgpLCBQb3J0LnRjcCg4MCksIFwiQWxsb3cgSFRUUCBPdXRib3VuZCBmb3IgZWdyZXNzLW9ubHkgaW50ZXJuZXQgYWNjZXNzXCIpXHJcblxyXG4gICAgc2FnZW1ha2VyX3dvcmtsb2FkX3NnLmNvbm5lY3Rpb25zLmFsbG93RnJvbShzYWdlbWFrZXJfd29ya2xvYWRfc2csIFBvcnQudGNwUmFuZ2UoODE5Miw2NTUzNSksIFwiQ29tbXVuaWNhdGlvbiByZXF1aXJlZCB3aXRoIFNhZ2VNYWtlciBzZXJ2aWNlLW93bmVkIFZQQ1wiKVxyXG4gICAgc2FnZW1ha2VyX3dvcmtsb2FkX3NnLmNvbm5lY3Rpb25zLmFsbG93RnJvbShzYWdlbWFrZXJfd29ya2xvYWRfc2csIFBvcnQudWRwKDUwMCksIFwiQ29tbXVuaWNhdGlvbiByZXF1aXJlZCB3aXRoIFNhZ2VNYWtlciBzZXJ2aWNlLW93bmVkIFZQQ1wiKVxyXG4gICAgc2FnZW1ha2VyX3dvcmtsb2FkX3NnLmNvbm5lY3Rpb25zLmFsbG93RnJvbShzYWdlbWFrZXJfd29ya2xvYWRfc2csIFBvcnQuZXNwKCksIFwiQ29tbXVuaWNhdGlvbiByZXF1aXJlZCB3aXRoIFNhZ2VNYWtlciBzZXJ2aWNlLW93bmVkIFZQQ1wiKVxyXG4gICAgc2FnZW1ha2VyX3dvcmtsb2FkX3NnLmNvbm5lY3Rpb25zLmFsbG93RnJvbShzYWdlbWFrZXJfd29ya2xvYWRfc2csIFBvcnQudGNwKDQ0MyksIFwiQWxsb3cgSFRUUFMgSW5ib3VuZCBmb3IgVlBDIGludGVyZmFjZSBlbmRwb2ludFwiKVxyXG5cclxuICAgIHNhZ2VtYWtlcl92cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoXCJrbXNfZW5kcG9pbnRcIix7XHJcbiAgICAgIHNlcnZpY2U6IEludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5LTVMsXHJcbiAgICAgIHByaXZhdGVEbnNFbmFibGVkOiB0cnVlLFxyXG4gICAgICBzdWJuZXRzOiB7XHJcbiAgICAgICAgIHN1Ym5ldHM6IFtcclxuICAgICAgICAgIHNhZ2VtYWtlcl92cGMuc2VsZWN0U3VibmV0cyh7c3VibmV0R3JvdXBOYW1lOiBcIndvcmtsb2FkX3N1Ym5ldF93aXRoX25hdFwifSkuc3VibmV0c1swXVxyXG4gICAgICAgICBdXHJcbiAgICAgIH0sXHJcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiAoXHJcbiAgICAgICAgW3NhZ2VtYWtlcl93b3JrbG9hZF9zZ11cclxuICAgICAgKVxyXG4gICAgfSk7XHJcblxyXG4gICAgc2FnZW1ha2VyX3ZwYy5hZGRJbnRlcmZhY2VFbmRwb2ludChcInNhZ2VtYWtlcl9hcGlfZW5kcG9pbnRcIix7XHJcbiAgICAgIHNlcnZpY2U6IEludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5TQUdFTUFLRVJfQVBJLFxyXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcclxuICAgICAgc3VibmV0czoge1xyXG4gICAgICAgICBzdWJuZXRzOiBbXHJcbiAgICAgICAgICBzYWdlbWFrZXJfdnBjLnNlbGVjdFN1Ym5ldHMoe3N1Ym5ldEdyb3VwTmFtZTogXCJ3b3JrbG9hZF9zdWJuZXRfd2l0aF9uYXRcIn0pLnN1Ym5ldHNbMF1cclxuICAgICAgICAgXVxyXG4gICAgICB9LFxyXG4gICAgICBzZWN1cml0eUdyb3VwczogKFxyXG4gICAgICAgIFtzYWdlbWFrZXJfd29ya2xvYWRfc2ddXHJcbiAgICAgIClcclxuICAgIH0pO1xyXG5cclxuXHJcbiAgICBzYWdlbWFrZXJfdnBjLmFkZEludGVyZmFjZUVuZHBvaW50KFwic2FnZW1ha2VyX3J1bnRpbWVfZW5kcG9pbnRcIix7XHJcbiAgICAgIHNlcnZpY2U6IEludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5TQUdFTUFLRVJfUlVOVElNRSxcclxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXHJcbiAgICAgIHN1Ym5ldHM6IHtcclxuICAgICAgICAgc3VibmV0czogW1xyXG4gICAgICAgICAgc2FnZW1ha2VyX3ZwYy5zZWxlY3RTdWJuZXRzKHtzdWJuZXRHcm91cE5hbWU6IFwid29ya2xvYWRfc3VibmV0X3dpdGhfbmF0XCJ9KS5zdWJuZXRzWzBdXHJcbiAgICAgICAgIF1cclxuICAgICAgfSxcclxuICAgICAgc2VjdXJpdHlHcm91cHM6IChcclxuICAgICAgICBbc2FnZW1ha2VyX3dvcmtsb2FkX3NnXVxyXG4gICAgICApXHJcbiAgICB9KTtcclxuXHJcbiAgICBzYWdlbWFrZXJfdnBjLmFkZEludGVyZmFjZUVuZHBvaW50KFwic2FnZW1ha2VyX3N0dWRpb19lbmRwb2ludFwiLHtcclxuICAgICAgc2VydmljZTogbmV3IEludGVyZmFjZVZwY0VuZHBvaW50U2VydmljZShcImF3cy5zYWdlbWFrZXIuXCIgKyB0aGlzLnJlZ2lvbiArIFwiLnN0dWRpb1wiLCA0NDMpLFxyXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcclxuICAgICAgc3VibmV0czoge1xyXG4gICAgICAgICBzdWJuZXRzOiBbXHJcbiAgICAgICAgICBzYWdlbWFrZXJfdnBjLnNlbGVjdFN1Ym5ldHMoe3N1Ym5ldEdyb3VwTmFtZTogXCJ3b3JrbG9hZF9zdWJuZXRfd2l0aF9uYXRcIn0pLnN1Ym5ldHNbMF1cclxuICAgICAgICAgXVxyXG4gICAgICB9LFxyXG4gICAgICBzZWN1cml0eUdyb3VwczogKFxyXG4gICAgICAgIFtzYWdlbWFrZXJfd29ya2xvYWRfc2ddXHJcbiAgICAgIClcclxuICAgIH0pO1xyXG5cclxuICAgIHNhZ2VtYWtlcl92cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoXCJhdGhlbmFfZW5kcG9pbnRcIix7XHJcbiAgICAgIHNlcnZpY2U6IEludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5BVEhFTkEsXHJcbiAgICAgIHByaXZhdGVEbnNFbmFibGVkOiB0cnVlLFxyXG4gICAgICBzdWJuZXRzOiB7XHJcbiAgICAgICAgIHN1Ym5ldHM6IFtcclxuICAgICAgICAgIHNhZ2VtYWtlcl92cGMuc2VsZWN0U3VibmV0cyh7c3VibmV0R3JvdXBOYW1lOiBcIndvcmtsb2FkX3N1Ym5ldF93aXRoX25hdFwifSkuc3VibmV0c1swXVxyXG4gICAgICAgICBdXHJcbiAgICAgIH0sXHJcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiAoXHJcbiAgICAgICAgW3NhZ2VtYWtlcl93b3JrbG9hZF9zZ11cclxuICAgICAgKVxyXG4gICAgfSk7XHJcblxyXG4gICAgc2FnZW1ha2VyX3ZwYy5hZGRJbnRlcmZhY2VFbmRwb2ludChcInMzX2VuZHBvaW50XCIse1xyXG4gICAgICBzZXJ2aWNlOiBuZXcgSW50ZXJmYWNlVnBjRW5kcG9pbnRTZXJ2aWNlKFwiY29tLmFtYXpvbmF3cy5cIiArIHRoaXMucmVnaW9uICsgXCIuczNcIiwgNDQzKSxcclxuICAgICAgc3VibmV0czoge1xyXG4gICAgICAgICBzdWJuZXRzOiBbXHJcbiAgICAgICAgICBzYWdlbWFrZXJfdnBjLnNlbGVjdFN1Ym5ldHMoe3N1Ym5ldEdyb3VwTmFtZTogXCJ3b3JrbG9hZF9zdWJuZXRfd2l0aF9uYXRcIn0pLnN1Ym5ldHNbMF1cclxuICAgICAgICAgXVxyXG4gICAgICB9LFxyXG4gICAgICBzZWN1cml0eUdyb3VwczogKFxyXG4gICAgICAgIFtzYWdlbWFrZXJfd29ya2xvYWRfc2ddXHJcbiAgICAgIClcclxuICAgIH0pO1xyXG5cclxuICAgIHNhZ2VtYWtlcl92cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoXCJjb2RlY29tbWl0X2VuZHBvaW50XCIse1xyXG4gICAgICBzZXJ2aWNlOiBJbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuQ09ERUNPTU1JVCxcclxuICAgICAgc3VibmV0czoge1xyXG4gICAgICAgICBzdWJuZXRzOiBbXHJcbiAgICAgICAgICBzYWdlbWFrZXJfdnBjLnNlbGVjdFN1Ym5ldHMoe3N1Ym5ldEdyb3VwTmFtZTogXCJ3b3JrbG9hZF9zdWJuZXRfd2l0aF9uYXRcIn0pLnN1Ym5ldHNbMF1cclxuICAgICAgICAgXVxyXG4gICAgICB9LFxyXG4gICAgICBzZWN1cml0eUdyb3VwczogKFxyXG4gICAgICAgIFtzYWdlbWFrZXJfd29ya2xvYWRfc2ddXHJcbiAgICAgIClcclxuICAgIH0pO1xyXG5cclxuICAgIHNhZ2VtYWtlcl92cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoXCJjb2RlY29tbWl0X2dpdF9lbmRwb2ludFwiLHtcclxuICAgICAgc2VydmljZTogSW50ZXJmYWNlVnBjRW5kcG9pbnRBd3NTZXJ2aWNlLkNPREVDT01NSVRfR0lULFxyXG4gICAgICBzdWJuZXRzOiB7XHJcbiAgICAgICAgIHN1Ym5ldHM6IFtcclxuICAgICAgICAgIHNhZ2VtYWtlcl92cGMuc2VsZWN0U3VibmV0cyh7c3VibmV0R3JvdXBOYW1lOiBcIndvcmtsb2FkX3N1Ym5ldF93aXRoX25hdFwifSkuc3VibmV0c1swXVxyXG4gICAgICAgICBdXHJcbiAgICAgIH0sXHJcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiAoXHJcbiAgICAgICAgW3NhZ2VtYWtlcl93b3JrbG9hZF9zZ11cclxuICAgICAgKVxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gUzMgQnVja2V0IGZvciBBdGhlbmEgb3V0cHV0XHJcbiAgICBjb25zdCBzM19hY2Nlc3NfbG9ncyA9IG5ldyBCdWNrZXQodGhpcywgJ3MzX2FjY2Vzc19sb2dzJywge1xyXG4gICAgICBidWNrZXROYW1lOiAnYXRoZW5hLW1sLWluc2lnaHRzLXMzLWFjY2Vzcy1sb2dzLScgKyB0aGlzLmFjY291bnQsXHJcbiAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWSxcclxuICAgICAgYnVja2V0S2V5RW5hYmxlZDogdHJ1ZSxcclxuICAgICAgZW5jcnlwdGlvbjogQnVja2V0RW5jcnlwdGlvbi5LTVNfTUFOQUdFRCxcclxuICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcclxuICAgICAgdmVyc2lvbmVkOiB0cnVlLFxyXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxyXG4gICAgICBvYmplY3RPd25lcnNoaXA6IE9iamVjdE93bmVyc2hpcC5CVUNLRVRfT1dORVJfUFJFRkVSUkVELFxyXG4gICAgICBwdWJsaWNSZWFkQWNjZXNzOiBmYWxzZSxcclxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFt7XHJcbiAgICAgICAgZXhwaXJhdGlvbjogRHVyYXRpb24uZGF5cygzNjUpLFxyXG4gICAgICAgIHRyYW5zaXRpb25zOiBbe1xyXG4gICAgICAgICAgICBzdG9yYWdlQ2xhc3M6IFN0b3JhZ2VDbGFzcy5JTlRFTExJR0VOVF9USUVSSU5HLFxyXG4gICAgICAgICAgICB0cmFuc2l0aW9uQWZ0ZXI6IER1cmF0aW9uLmRheXMoMzEpXHJcbiAgICAgICAgfV1cclxuICAgIH1dXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBhdGhlbmFfb3V0cHV0X3MzX2J1Y2tldCA9IG5ldyBCdWNrZXQodGhpcywgJ2F0aGVuYV9vdXRwdXRfczNfYnVja2V0Jywge1xyXG4gICAgICBidWNrZXROYW1lOiAnYXRoZW5hLW1sLWluc2lnaHRzLWJ1Y2tldC1yZXN1bHRzLScgKyB0aGlzLmFjY291bnQsXHJcbiAgICAgIHNlcnZlckFjY2Vzc0xvZ3NCdWNrZXQ6IHMzX2FjY2Vzc19sb2dzLFxyXG4gICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXHJcbiAgICAgIGJ1Y2tldEtleUVuYWJsZWQ6IHRydWUsXHJcbiAgICAgIGVuY3J5cHRpb246IEJ1Y2tldEVuY3J5cHRpb24uS01TLFxyXG4gICAgICBlbmNyeXB0aW9uS2V5OiBhdGhlbmFfczNfb3V0cHV0X2ttc19rZXksXHJcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXHJcbiAgICAgIHZlcnNpb25lZDogdHJ1ZSxcclxuICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IEJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcclxuICAgICAgb2JqZWN0T3duZXJzaGlwOiBPYmplY3RPd25lcnNoaXAuQlVDS0VUX09XTkVSX1BSRUZFUlJFRCxcclxuICAgICAgcHVibGljUmVhZEFjY2VzczogZmFsc2UsXHJcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbe1xyXG4gICAgICAgIGV4cGlyYXRpb246IER1cmF0aW9uLmRheXMoMzY1KSxcclxuICAgICAgICB0cmFuc2l0aW9uczogW3tcclxuICAgICAgICAgICAgc3RvcmFnZUNsYXNzOiBTdG9yYWdlQ2xhc3MuSU5URUxMSUdFTlRfVElFUklORyxcclxuICAgICAgICAgICAgdHJhbnNpdGlvbkFmdGVyOiBEdXJhdGlvbi5kYXlzKDMxKVxyXG4gICAgICAgIH1dXHJcbiAgICB9XVxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gSUFNIFJvbGUgZm9yIFNhZ2VNYWtlciB1c2VyIHByb2ZpbGVzXHJcbiAgICBjb25zdCBzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgXCJzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGVcIiwge1xyXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcInNhZ2VtYWtlci5hbWF6b25hd3MuY29tXCIpLFxyXG4gICAgICByb2xlTmFtZTogXCJzYWdlbWFrZXItdXNlci1wcm9maWxlLWZvci1zZWN1cml0eS1sYWtlXCIsXHJcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xyXG4gICAgICBdXHJcbiAgICB9KTtcclxuXHJcbiAgICBzYWdlbWFrZXJfa21zX2tleS5hZGRUb1Jlc291cmNlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgIFwia21zOkRlc2NyaWJlS2V5XCIsXHJcbiAgICAgICAgXCJrbXM6RGVjcnlwdFwiLFxyXG4gICAgICAgIFwia21zOkdlbmVyYXRlRGF0YUtleVwiLFxyXG4gICAgICAgIFwia21zOkNyZWF0ZUdyYW50XCJcclxuICAgICAgXSxcclxuICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgXCIqXCJcclxuICAgICAgXSxcclxuICAgICAgcHJpbmNpcGFsczogW1xyXG4gICAgICAgIG5ldyBpYW0uQXJuUHJpbmNpcGFsKHNhZ2VtYWtlcl91c2VyX3Byb2ZpbGVfcm9sZS5yb2xlQXJuKVxyXG4gICAgICBdXHJcbiAgICB9KSk7XHJcblxyXG4gICAgY29uc3Qgc2FnZW1ha2VyX3VzZXJfcHJvZmlsZV9wb2xpY3kgPSBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcclxuICAgICAgc3RhdGVtZW50czogW1xyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJDbG91ZFdhdGNoTG9nR3JvdXBBbGxvd1wiLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICBcImxvZ3M6Q3JlYXRlTG9nR3JvdXBcIixcclxuICAgICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ1N0cmVhbVwiLFxyXG4gICAgICAgICAgICBcImxvZ3M6UHV0TG9nRXZlbnRzXCJcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICAgICAgXCJhcm46YXdzOmxvZ3M6XCIgKyB0aGlzLnJlZ2lvbiArXCI6XCIgKyB0aGlzLmFjY291bnQgKyBcIjpsb2ctZ3JvdXA6L2F3cy9zYWdlbWFrZXIvc3R1ZGlvOipcIlxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJTM1JlYWRcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJzMzpMaXN0QnVja2V0XCIsXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIFwiKlwiXHJcbiAgICAgICAgICBdICAgXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgc2lkOiBcIlMzQWxsb3dcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJzMzpBYm9ydE11bHRpcGFydFVwbG9hZFwiLFxyXG4gICAgICAgICAgICBcInMzOkRlbGV0ZU9iamVjdFwiLFxyXG4gICAgICAgICAgICBcInMzOkdldE9iamVjdFwiLFxyXG4gICAgICAgICAgICBcInMzOkxpc3RCdWNrZXRcIixcclxuICAgICAgICAgICAgXCJzMzpQdXRPYmplY3RcIixcclxuICAgICAgICAgICAgXCJzMzpQdXRPYmplY3RBY2xcIixcclxuICAgICAgICAgICAgXCJzMzpHZXRCdWNrZXRBY2xcIixcclxuICAgICAgICAgICAgXCJzMzpHZXRCdWNrZXRMb2NhdGlvblwiXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIGF0aGVuYV9vdXRwdXRfczNfYnVja2V0LmJ1Y2tldEFybixcclxuICAgICAgICAgICAgYXRoZW5hX291dHB1dF9zM19idWNrZXQuYnVja2V0QXJuICsgXCIvKlwiXHJcbiAgICAgICAgICBdICAgXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgc2lkOiBcIkF0aGVuYUFsbG93XCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwiYXRoZW5hOkdldCpcIixcclxuICAgICAgICAgICAgXCJhdGhlbmE6TGlzdCpcIixcclxuICAgICAgICAgICAgXCJhdGhlbmE6U3RhcnRRdWVyeUV4ZWN1dGlvblwiLFxyXG4gICAgICAgICAgICBcImF0aGVuYTpTdGFydFNlc3Npb25cIixcclxuICAgICAgICAgICAgXCJhdGhlbmE6U3RvcFF1ZXJ5RXhlY3V0aW9uXCIsXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIFwiYXJuOmF3czphdGhlbmE6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOlwiICsgdGhpcy5hY2NvdW50ICtcIjpkYXRhY2F0YWxvZy8qXCIsXHJcbiAgICAgICAgICAgIFwiYXJuOmF3czphdGhlbmE6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOlwiICsgdGhpcy5hY2NvdW50ICtcIjp3b3JrZ3JvdXAvKlwiXHJcbiAgICAgICAgICBdICAgXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgc2lkOiBcIkdsdWVBbGxvd1wiLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICBcImdsdWU6Q3JlYXRlRGF0YWJhc2VcIixcclxuICAgICAgICAgICAgXCJnbHVlOkdldERhdGFiYXNlXCIsXHJcbiAgICAgICAgICAgIFwiZ2x1ZTpHZXREYXRhYmFzZXNcIixcclxuICAgICAgICAgICAgXCJnbHVlOkdldFRhYmxlXCIsXHJcbiAgICAgICAgICAgIFwiZ2x1ZTpHZXRUYWJsZXNcIixcclxuICAgICAgICAgICAgXCJnbHVlOkdldFBhcnRpdGlvblwiLFxyXG4gICAgICAgICAgICBcImdsdWU6R2V0UGFydGl0aW9uc1wiLFxyXG4gICAgICAgICAgICBcImdsdWU6QmF0Y2hHZXRQYXJ0aXRpb25cIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgXCJhcm46YXdzOmdsdWU6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOlwiICsgdGhpcy5hY2NvdW50ICtcIjpkYXRhYmFzZS8qXCIsXG4gICAgICAgICAgICBcImFybjphd3M6Z2x1ZTpcIiArIHRoaXMucmVnaW9uICsgXCI6XCIgKyB0aGlzLmFjY291bnQgK1wiOnRhYmxlLypcIixcbiAgICAgICAgICAgIFwiYXJuOmF3czpnbHVlOlwiICsgdGhpcy5yZWdpb24gKyBcIjpcIiArIHRoaXMuYWNjb3VudCArXCI6Y2F0YWxvZ1wiLFxuICAgICAgICAgIF0gICBcbiAgICAgICAgfSksXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJMYWtlRm9ybWF0aW9uQWxsb3dcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJsYWtlZm9ybWF0aW9uOkdldERhdGFBY2Nlc3NcIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBcIipcIlxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJDb2RlQ29tbWl0QWxsb3dcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkJhdGNoR2V0KlwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6RGVzY3JpYmUqXCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpHZXQqXCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpMaXN0KlwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6R2l0UHVsbFwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6R2l0UHVzaFwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6Q3JlYXRlQnJhbmNoXCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpEZWxldGVCcmFuY2hcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0Ok1lcmdlQnJhbmNoZXNCeSpcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OlVwZGF0ZURlZmF1bHRCcmFuY2hcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkJhdGNoRGVzY3JpYmVNZXJnZUNvbmZsaWN0c1wiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6Q3JlYXRlVW5yZWZlcmVuY2VkTWVyZ2VDb21taXRcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkNyZWF0ZUNvbW1pdFwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6Q3JlYXRlUHVsbFJlcXVlc3RcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkNyZWF0ZVB1bGxSZXF1ZXN0QXBwcm92YWxSdWxlXCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpEZWxldGVQdWxsUmVxdWVzdEFwcHJvdmFsUnVsZVwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6RXZhbHVhdGVQdWxsUmVxdWVzdEFwcHJvdmFsUnVsZXNcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0Ok1lcmdlUHVsbFJlcXVlc3RCeSpcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OlBvc3RDb21tZW50Rm9yUHVsbFJlcXVlc3RcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OlVwZGF0ZVB1bGxSZXF1ZXN0KlwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6UHV0RmlsZVwiXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIHNhZ2VtYWtlcl9ub3RlYm9va19tbF9pbnNpZ2h0c19yZXBvc2l0b3J5LnJlcG9zaXRvcnlBcm5cclxuICAgICAgICAgIF0gICBcclxuICAgICAgICB9KSxcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiU2FnZU1ha2VyTm90UmVzb3VyY2VBbGxvd1wiLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjoqXCJcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICBub3RSZXNvdXJjZXM6IFtcclxuICAgICAgICAgICAgXCJhcm46YXdzOnNhZ2VtYWtlcjoqOio6ZG9tYWluLypcIixcclxuICAgICAgICAgICAgXCJhcm46YXdzOnNhZ2VtYWtlcjoqOio6dXNlci1wcm9maWxlLypcIixcclxuICAgICAgICAgICAgXCJhcm46YXdzOnNhZ2VtYWtlcjoqOio6YXBwLypcIixcclxuICAgICAgICAgICAgXCJhcm46YXdzOnNhZ2VtYWtlcjoqOio6Zmxvdy1kZWZpbml0aW9uLypcIlxyXG4gICAgICAgICAgXVxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJTYWdlTWFrZXJEb21haW5BbGxvd1wiLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpDcmVhdGVQcmVzaWduZWREb21haW5VcmxcIixcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6RGVzY3JpYmVEb21haW5cIixcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6TGlzdERvbWFpbnNcIixcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6RGVzY3JpYmVVc2VyUHJvZmlsZVwiLFxyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpMaXN0VXNlclByb2ZpbGVzXCIsXHJcbiAgICAgICAgICAgIFwic2FnZW1ha2VyOipBcHBcIixcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6TGlzdEFwcHNcIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBcImFybjphd3M6c2FnZW1ha2VyOio6Kjpkb21haW4vKlwiLFxyXG4gICAgICAgICAgICBcImFybjphd3M6c2FnZW1ha2VyOio6Kjp1c2VyLXByb2ZpbGUvKlwiLFxyXG4gICAgICAgICAgICBcImFybjphd3M6c2FnZW1ha2VyOio6KjphcHAvKlwiLFxyXG4gICAgICAgICAgICBcImFybjphd3M6c2FnZW1ha2VyOio6KjpmbG93LWRlZmluaXRpb24vKlwiXHJcbiAgICAgICAgICBdXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgc2lkOiBcIlNhZ2VNYWtlcldvcmtzdHJlYW1cIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJpYW06UGFzc1JvbGVcIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBcImFybjphd3M6c2FnZW1ha2VyOlwiICsgdGhpcy5yZWdpb24gKyBcIjpcIiArIHRoaXMuYWNjb3VudCArXCI6Zmxvdy1kZWZpbml0aW9uLypcIixcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICBjb25kaXRpb25zOiB7XHJcbiAgICAgICAgICAgIFN0cmluZ0VxdWFsc0lmRXhpc3RzOntcclxuICAgICAgICAgICAgICBcInNhZ2VtYWtlcjpXb3JrdGVhbVR5cGVcIjogW1xyXG4gICAgICAgICAgICAgICAgXCJwcml2YXRlLWNyb3dkXCIsXHJcbiAgICAgICAgICAgICAgICBcInZlbmRvci1jcm93ZFwiXHJcbiAgICAgICAgICAgICAgXVxyXG4gICAgICAgICAgICB9fSBcclxuICAgICAgICB9KSxcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiSUFNUGFzc1JvbGVTZXJ2aWNlXCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwiaWFtOlBhc3NSb2xlXCJcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICAgICAgc2FnZW1ha2VyX3VzZXJfcHJvZmlsZV9yb2xlLnJvbGVBcm5cclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICBjb25kaXRpb25zOiB7XHJcbiAgICAgICAgICAgIFN0cmluZ0xpa2U6e1xyXG4gICAgICAgICAgICAgIFwiaWFtOlBhc3NlZFRvU2VydmljZVwiOiBbXHJcbiAgICAgICAgICAgICAgICBcImdsdWUuYW1hem9uYXdzLmNvbVwiLFxyXG4gICAgICAgICAgICAgICAgXCJyb2JvbWFrZXIuYW1hem9uYXdzLmNvbVwiLFxyXG4gICAgICAgICAgICAgICAgXCJzdGF0ZXMuYW1hem9uYXdzLmNvbVwiLFxyXG4gICAgICAgICAgICAgICAgXCJzYWdlbWFrZXIuYW1hem9uYXdzLmNvbVwiXHJcbiAgICAgICAgICAgICAgXVxyXG4gICAgICAgICAgICB9fSBcclxuICAgICAgICB9KSxcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiS01TRW5jcnlwdFwiLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICBcImttczpDcmVhdGVHcmFudFwiLFxyXG4gICAgICAgICAgICBcImttczpEZXNjcmliZUtleVwiLFxyXG4gICAgICAgICAgICBcImttczpEZWNyeXB0XCIsXHJcbiAgICAgICAgICAgIFwia21zOkVuY3J5cHRcIixcclxuICAgICAgICAgICAgXCJrbXM6R2VuZXJhdGVEYXRhS2V5XCIsXHJcbiAgICAgICAgICAgIFwia21zOlJlRW5jcnlwdCpcIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBzYWdlbWFrZXJfa21zX2tleS5rZXlBcm4sXHJcbiAgICAgICAgICAgIGF0aGVuYV9zM19vdXRwdXRfa21zX2tleS5rZXlBcm5cclxuICAgICAgICAgIF0gICBcclxuICAgICAgICB9KSxcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgc2lkOiBcIlNhZ2VNYWtlclBlcm1pc3Npb25zXCIsXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgIFwic2FnZW1ha2VyOkNyZWF0ZUFwcFwiXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBcImFybjphd3M6c2FnZW1ha2VyOlwiICsgdGhpcy5yZWdpb24gKyBcIjpcIiArIHRoaXMuYWNjb3VudCArXCI6YXBwLypcIixcbiAgICAgICAgICBdICAgXG4gICAgICAgIH0pLFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgc2lkOiBcIkJlZHJvY2tJbnZva2VBbGxvd1wiLFxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICBcImJlZHJvY2s6SW52b2tlTW9kZWxcIixcbiAgICAgICAgICAgIFwiYmVkcm9jazpJbnZva2VNb2RlbFdpdGhSZXNwb25zZVN0cmVhbVwiXG4gICAgICAgICAgXSxcbiAgICAgICAgICByZXNvdXJjZXM6IGJlZHJvY2tfbW9kZWxfcmVzb3VyY2VzXG4gICAgICAgIH0pLFxuICAgICAgXSxcbiAgICB9KTtcblxyXG4gICAgYXRoZW5hX291dHB1dF9zM19idWNrZXQuYWRkVG9SZXNvdXJjZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAnczM6UHV0T2JqZWN0JyxcclxuICAgICAgICAnczM6UHV0T2JqZWN0QWNsJyxcclxuICAgICAgICAnczM6RGVsZXRlT2JqZWN0JyxcclxuICAgICAgICAnczM6R2V0QnVja2V0TG9jYXRpb24nXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgIGF0aGVuYV9vdXRwdXRfczNfYnVja2V0LmJ1Y2tldEFybixcclxuICAgICAgICBhdGhlbmFfb3V0cHV0X3MzX2J1Y2tldC5idWNrZXRBcm4gKyAnLyonXHJcbiAgICAgIF0sXHJcbiAgICAgIHByaW5jaXBhbHM6IFtcclxuICAgICAgICBuZXcgaWFtLkFyblByaW5jaXBhbChzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZUFybildLFxyXG4gICAgfSkpO1xyXG5cclxuICAgIG5ldyBpYW0uTWFuYWdlZFBvbGljeSh0aGlzLCBcIlNhZ2VNYWtlclN0dWRpb1VzZXJQcm9maWxlTWFuYWdlZFBvbGljeVwiLCB7XG4gICAgICBkZXNjcmlwdGlvbjogXCJNYW5hZ2VkIHBvbGljeSBhc3NvY2lhdGVkIHRvIHRoZSBTYWdlTWFrZXIgU3R1ZGlvcyB1c2VyIHByb2ZpbGUuXCIsXG4gICAgICBkb2N1bWVudDpzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3BvbGljeSxcbiAgICAgIG1hbmFnZWRQb2xpY3lOYW1lOiBcInNhZ2VtYWtlci1zdHVkaW8tdXNlci1zZWN1cml0eS1sYWtlLXBvbGljeVwiLFxuICAgICAgcm9sZXM6IFtzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGVdXG4gICAgfSk7XG5cbiAgICBpZiAoY3JlYXRlX2xha2VfZm9ybWF0aW9uX3Blcm1pc3Npb25zKSB7XG4gICAgICBuZXcgQ2ZuUHJpbmNpcGFsUGVybWlzc2lvbnModGhpcywgXCJTYWdlTWFrZXJTZWN1cml0eUxha2VEYXRhYmFzZVBlcm1pc3Npb25zXCIsIHtcbiAgICAgICAgcHJpbmNpcGFsOiB7XG4gICAgICAgICAgZGF0YUxha2VQcmluY2lwYWxJZGVudGlmaWVyOiBzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZUFybixcbiAgICAgICAgfSxcbiAgICAgICAgcmVzb3VyY2U6IHtcbiAgICAgICAgICBkYXRhYmFzZToge1xuICAgICAgICAgICAgY2F0YWxvZ0lkOiB0aGlzLmFjY291bnQsXG4gICAgICAgICAgICBuYW1lOiBzZWN1cml0eV9sYWtlX2RhdGFiYXNlX25hbWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcGVybWlzc2lvbnM6IFtcIkRFU0NSSUJFXCJdLFxuICAgICAgICBwZXJtaXNzaW9uc1dpdGhHcmFudE9wdGlvbjogW10sXG4gICAgICB9KTtcblxuICAgICAgbmV3IENmblByaW5jaXBhbFBlcm1pc3Npb25zKHRoaXMsIFwiU2FnZU1ha2VyU2VjdXJpdHlMYWtlVGFibGVQZXJtaXNzaW9uc1wiLCB7XG4gICAgICAgIHByaW5jaXBhbDoge1xuICAgICAgICAgIGRhdGFMYWtlUHJpbmNpcGFsSWRlbnRpZmllcjogc2FnZW1ha2VyX3VzZXJfcHJvZmlsZV9yb2xlLnJvbGVBcm4sXG4gICAgICAgIH0sXG4gICAgICAgIHJlc291cmNlOiB7XG4gICAgICAgICAgdGFibGU6IHtcbiAgICAgICAgICAgIGNhdGFsb2dJZDogdGhpcy5hY2NvdW50LFxuICAgICAgICAgICAgZGF0YWJhc2VOYW1lOiBzZWN1cml0eV9sYWtlX2RhdGFiYXNlX25hbWUsXG4gICAgICAgICAgICBuYW1lOiBzZWN1cml0eV9sYWtlX3RhYmxlX25hbWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcGVybWlzc2lvbnM6IFtcIkRFU0NSSUJFXCIsIFwiU0VMRUNUXCJdLFxuICAgICAgICBwZXJtaXNzaW9uc1dpdGhHcmFudE9wdGlvbjogW10sXG4gICAgICB9KTtcbiAgICB9XG5cclxuICAgIGNvbnN0IHNhZ2VtYWtlcl9kb21haW4gPSBuZXcgQ2ZuRG9tYWluKHRoaXMsIFwic2FnZW1ha2VyX2RvbWFpblwiLCB7XHJcbiAgICAgIGF1dGhNb2RlOiBcIklBTVwiLFxyXG4gICAgICBkZWZhdWx0VXNlclNldHRpbmdzOiB7XHJcbiAgICAgICAgZXhlY3V0aW9uUm9sZTogc2FnZW1ha2VyX3VzZXJfcHJvZmlsZV9yb2xlLnJvbGVBcm4sXHJcbiAgICAgICAganVweXRlclNlcnZlckFwcFNldHRpbmdzOiB7XHJcbiAgICAgICAgICBkZWZhdWx0UmVzb3VyY2VTcGVjOiB7XHJcbiAgICAgICAgICAgIGluc3RhbmNlVHlwZTogXCJzeXN0ZW1cIixcclxuICAgICAgICAgICAgLy8gbGlmZWN5Y2xlQ29uZmlnQXJuOiBcImxpZmVjeWNsZUNvbmZpZ0FyblwiLFxyXG4gICAgICAgICAgICAvLyBzYWdlTWFrZXJJbWFnZUFybjogXCJzYWdlTWFrZXJJbWFnZUFyblwiLFxyXG4gICAgICAgICAgICAvLyBzYWdlTWFrZXJJbWFnZVZlcnNpb25Bcm46IFwic2FnZU1ha2VySW1hZ2VWZXJzaW9uQXJuXCIsXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAga2VybmVsR2F0ZXdheUFwcFNldHRpbmdzOiB7XHJcbiAgICAgICAgICAvLyBjdXN0b21JbWFnZXM6IFt7XHJcbiAgICAgICAgICAvLyAgIGFwcEltYWdlQ29uZmlnTmFtZTogXCJhcHBJbWFnZUNvbmZpZ05hbWVcIixcclxuICAgICAgICAgIC8vICAgaW1hZ2VOYW1lOiBcImltYWdlTmFtZVwiLFxyXG4gICAgXHJcbiAgICAgICAgICAvLyAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICAgICAgLy8gICBpbWFnZVZlcnNpb25OdW1iZXI6IDEyMyxcclxuICAgICAgICAgIC8vIH1dLFxyXG4gICAgICAgICAgZGVmYXVsdFJlc291cmNlU3BlYzoge1xyXG4gICAgICAgICAgICBpbnN0YW5jZVR5cGU6IFwibWwudDMubWVkaXVtXCIsXHJcbiAgICAgICAgICAgIC8vIGxpZmVjeWNsZUNvbmZpZ0FybjogXCJsaWZlY3ljbGVDb25maWdBcm5cIixcclxuICAgICAgICAgICAgc2FnZU1ha2VySW1hZ2VBcm46IFwiYXJuOmF3czpzYWdlbWFrZXI6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOjA4MTMyNTM5MDE5OTppbWFnZS9kYXRhc2NpZW5jZS0xLjBcIixcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICAvLyByU2Vzc2lvbkFwcFNldHRpbmdzOiB7XHJcbiAgICAgICAgLy8gICBjdXN0b21JbWFnZXM6IFt7XHJcbiAgICAgICAgLy8gICAgIGFwcEltYWdlQ29uZmlnTmFtZTogXCJhcHBJbWFnZUNvbmZpZ05hbWVcIixcclxuICAgICAgICAvLyAgICAgaW1hZ2VOYW1lOiBcImltYWdlTmFtZVwiLFxyXG4gICAgXHJcbiAgICAgICAgLy8gICAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICAgIC8vICAgICBpbWFnZVZlcnNpb25OdW1iZXI6IDEyMyxcclxuICAgICAgICAvLyAgIH1dLFxyXG4gICAgICAgIC8vICAgZGVmYXVsdFJlc291cmNlU3BlYzoge1xyXG4gICAgICAgIC8vICAgICBpbnN0YW5jZVR5cGU6IFwiaW5zdGFuY2VUeXBlXCIsXHJcbiAgICAgICAgLy8gICAgIGxpZmVjeWNsZUNvbmZpZ0FybjogXCJsaWZlY3ljbGVDb25maWdBcm5cIixcclxuICAgICAgICAvLyAgICAgc2FnZU1ha2VySW1hZ2VBcm46IFwic2FnZU1ha2VySW1hZ2VBcm5cIixcclxuICAgICAgICAvLyAgICAgc2FnZU1ha2VySW1hZ2VWZXJzaW9uQXJuOiBcInNhZ2VNYWtlckltYWdlVmVyc2lvbkFyblwiLFxyXG4gICAgICAgIC8vICAgfSxcclxuICAgICAgICAvLyB9LFxyXG4gICAgICAgIC8vIHJTdHVkaW9TZXJ2ZXJQcm9BcHBTZXR0aW5nczoge1xyXG4gICAgICAgIC8vICAgYWNjZXNzU3RhdHVzOiBcImFjY2Vzc1N0YXR1c1wiLFxyXG4gICAgICAgIC8vICAgdXNlckdyb3VwOiBcInVzZXJHcm91cFwiLFxyXG4gICAgICAgIC8vIH0sXHJcbiAgICAgICAgc2VjdXJpdHlHcm91cHM6IFtzYWdlbWFrZXJfd29ya2xvYWRfc2cuc2VjdXJpdHlHcm91cElkXSxcclxuICAgICAgICAvLyBzaGFyaW5nU2V0dGluZ3M6IHtcclxuICAgICAgICAvLyAgIG5vdGVib29rT3V0cHV0T3B0aW9uOiBcIm5vdGVib29rT3V0cHV0T3B0aW9uXCIsXHJcbiAgICAgICAgLy8gICBzM0ttc0tleUlkOiBcInMzS21zS2V5SWRcIixcclxuICAgICAgICAvLyAgIHMzT3V0cHV0UGF0aDogXCJzM091dHB1dFBhdGhcIixcclxuICAgICAgICAvLyB9LFxyXG4gICAgICB9LFxyXG4gICAgICBkb21haW5OYW1lOiBcInNlY3VyaXR5LWxha2UtbWwtaW5zaWdodHMtXCIgKyB0aGlzLmFjY291bnQsXHJcbiAgICAgIHN1Ym5ldElkczogW3NhZ2VtYWtlcl92cGMuc2VsZWN0U3VibmV0cyh7c3VibmV0R3JvdXBOYW1lOiBcIndvcmtsb2FkX3N1Ym5ldF93aXRoX25hdFwifSkuc3VibmV0c1swXS5zdWJuZXRJZF0sXHJcbiAgICAgIHZwY0lkOiBzYWdlbWFrZXJfdnBjLnZwY0lkLFxyXG4gICAgICAvLyB0aGUgcHJvcGVydGllcyBiZWxvdyBhcmUgb3B0aW9uYWxcclxuICAgICAgYXBwTmV0d29ya0FjY2Vzc1R5cGU6IFwiVnBjT25seVwiLFxyXG4gICAgICAvLyBhcHBTZWN1cml0eUdyb3VwTWFuYWdlbWVudDogXCJhcHBTZWN1cml0eUdyb3VwTWFuYWdlbWVudFwiLFxyXG4gICAgICAvLyBkb21haW5TZXR0aW5nczoge1xyXG4gICAgICAvLyAgIHJTdHVkaW9TZXJ2ZXJQcm9Eb21haW5TZXR0aW5nczoge1xyXG4gICAgICAvLyAgICAgZG9tYWluRXhlY3V0aW9uUm9sZUFybjogXCJkb21haW5FeGVjdXRpb25Sb2xlQXJuXCIsXHJcbiAgICBcclxuICAgICAgLy8gICAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICAvLyAgICAgZGVmYXVsdFJlc291cmNlU3BlYzoge1xyXG4gICAgICAvLyAgICAgICBpbnN0YW5jZVR5cGU6IFwiaW5zdGFuY2VUeXBlXCIsXHJcbiAgICAgIC8vICAgICAgIGxpZmVjeWNsZUNvbmZpZ0FybjogXCJsaWZlY3ljbGVDb25maWdBcm5cIixcclxuICAgICAgLy8gICAgICAgc2FnZU1ha2VySW1hZ2VBcm46IFwic2FnZU1ha2VySW1hZ2VBcm5cIixcclxuICAgICAgLy8gICAgICAgc2FnZU1ha2VySW1hZ2VWZXJzaW9uQXJuOiBcInNhZ2VNYWtlckltYWdlVmVyc2lvbkFyblwiLFxyXG4gICAgICAvLyAgICAgfSxcclxuICAgICAgLy8gICAgIHJTdHVkaW9Db25uZWN0VXJsOiBcInJTdHVkaW9Db25uZWN0VXJsXCIsXHJcbiAgICAgIC8vICAgICByU3R1ZGlvUGFja2FnZU1hbmFnZXJVcmw6IFwiclN0dWRpb1BhY2thZ2VNYW5hZ2VyVXJsXCIsXHJcbiAgICAgIC8vICAgfSxcclxuICAgICAgLy8gICBzZWN1cml0eUdyb3VwSWRzOiBbXCJzZWN1cml0eUdyb3VwSWRzXCJdLFxyXG4gICAgICAvLyB9LFxyXG4gICAgICBrbXNLZXlJZDogc2FnZW1ha2VyX2ttc19rZXkua2V5SWQsXHJcbiAgICAgIHRhZ3M6IFt7XHJcbiAgICAgICAga2V5OiBcInByb2plY3RcIixcclxuICAgICAgICB2YWx1ZTogXCJzZWN1cml0eS1sYWtlLW1sLWluc2lnaHRzXCIsXHJcbiAgICAgIH1dLFxyXG4gICAgfSk7XHJcblxyXG4gICAgc2FnZW1ha2VyX2RvbWFpbi5hcHBseVJlbW92YWxQb2xpY3koUmVtb3ZhbFBvbGljeS5ERVNUUk9ZKVxyXG5cclxuICAgIGNvbnN0IHNhZ2VtYWtlcl91c2VyX3Byb2ZpbGUgPSBuZXcgQ2ZuVXNlclByb2ZpbGUodGhpcywgJ3NhZ2VtYWtlcl91c2VyX3Byb2ZpbGUnLCB7XHJcbiAgICAgIGRvbWFpbklkOiBzYWdlbWFrZXJfZG9tYWluLmF0dHJEb21haW5JZCxcclxuICAgICAgdXNlclByb2ZpbGVOYW1lOiBzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZU5hbWUsXHJcbiAgICBcclxuICAgICAgLy8gdGhlIHByb3BlcnRpZXMgYmVsb3cgYXJlIG9wdGlvbmFsXHJcbiAgICAgIC8vIHNpbmdsZVNpZ25PblVzZXJJZGVudGlmaWVyOiAnc2luZ2xlU2lnbk9uVXNlcklkZW50aWZpZXInLFxyXG4gICAgICAvLyBzaW5nbGVTaWduT25Vc2VyVmFsdWU6ICdzaW5nbGVTaWduT25Vc2VyVmFsdWUnLFxyXG4gICAgICB0YWdzOiBbe1xyXG4gICAgICAgIGtleTogJ3Byb2plY3QnLFxyXG4gICAgICAgIHZhbHVlOiAnc2VjdXJpdHktbGFrZS1tbC1pbnNpZ2h0cycsXHJcbiAgICAgIH1dLFxyXG4gICAgICB1c2VyU2V0dGluZ3M6IHtcclxuICAgICAgICBleGVjdXRpb25Sb2xlOiBzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZUFybixcclxuICAgICAgICAvLyBqdXB5dGVyU2VydmVyQXBwU2V0dGluZ3M6IHtcclxuICAgICAgICAvLyAgIGRlZmF1bHRSZXNvdXJjZVNwZWM6IHtcclxuICAgICAgICAvLyAgICAgaW5zdGFuY2VUeXBlOiAnaW5zdGFuY2VUeXBlJyxcclxuICAgICAgICAvLyAgICAgc2FnZU1ha2VySW1hZ2VBcm46ICdzYWdlTWFrZXJJbWFnZUFybicsXHJcbiAgICAgICAgLy8gICAgIHNhZ2VNYWtlckltYWdlVmVyc2lvbkFybjogJ3NhZ2VNYWtlckltYWdlVmVyc2lvbkFybicsXHJcbiAgICAgICAgLy8gICB9LFxyXG4gICAgICAgIC8vIH0sXHJcbiAgICAgICAgLy8ga2VybmVsR2F0ZXdheUFwcFNldHRpbmdzOiB7XHJcbiAgICAgICAgLy8gICBjdXN0b21JbWFnZXM6IFt7XHJcbiAgICAgICAgLy8gICAgIGFwcEltYWdlQ29uZmlnTmFtZTogJ2FwcEltYWdlQ29uZmlnTmFtZScsXHJcbiAgICAgICAgLy8gICAgIGltYWdlTmFtZTogJ2ltYWdlTmFtZScsXHJcbiAgICBcclxuICAgICAgICAvLyAgICAgLy8gdGhlIHByb3BlcnRpZXMgYmVsb3cgYXJlIG9wdGlvbmFsXHJcbiAgICAgICAgLy8gICAgIGltYWdlVmVyc2lvbk51bWJlcjogMTIzLFxyXG4gICAgICAgIC8vICAgfV0sXHJcbiAgICAgICAgLy8gICBkZWZhdWx0UmVzb3VyY2VTcGVjOiB7XHJcbiAgICAgICAgLy8gICAgIGluc3RhbmNlVHlwZTogJ2luc3RhbmNlVHlwZScsXHJcbiAgICAgICAgLy8gICAgIHNhZ2VNYWtlckltYWdlQXJuOiAnc2FnZU1ha2VySW1hZ2VBcm4nLFxyXG4gICAgICAgIC8vICAgICBzYWdlTWFrZXJJbWFnZVZlcnNpb25Bcm46ICdzYWdlTWFrZXJJbWFnZVZlcnNpb25Bcm4nLFxyXG4gICAgICAgIC8vICAgfSxcclxuICAgICAgICAvLyB9LFxyXG4gICAgICAgIC8vIHJTdHVkaW9TZXJ2ZXJQcm9BcHBTZXR0aW5nczoge1xyXG4gICAgICAgIC8vICAgYWNjZXNzU3RhdHVzOiAnYWNjZXNzU3RhdHVzJyxcclxuICAgICAgICAvLyAgIHVzZXJHcm91cDogJ3VzZXJHcm91cCcsXHJcbiAgICAgICAgLy8gfSxcclxuICAgICAgICAvL3NlY3VyaXR5R3JvdXBzOiBbJ3NlY3VyaXR5R3JvdXBzJ10sXHJcbiAgICAgICAgLy8gc2hhcmluZ1NldHRpbmdzOiB7XHJcbiAgICAgICAgLy8gICBub3RlYm9va091dHB1dE9wdGlvbjogJ25vdGVib29rT3V0cHV0T3B0aW9uJyxcclxuICAgICAgICAvLyAgIHMzS21zS2V5SWQ6ICdzM0ttc0tleUlkJyxcclxuICAgICAgICAvLyAgIHMzT3V0cHV0UGF0aDogJ3MzT3V0cHV0UGF0aCcsXHJcbiAgICAgICAgLy8gfSxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIHNhZ2VtYWtlcl91c2VyX3Byb2ZpbGUuYWRkRGVwZW5kZW5jeShzYWdlbWFrZXJfZG9tYWluKVxyXG4gICAgc2FnZW1ha2VyX3VzZXJfcHJvZmlsZS5hcHBseVJlbW92YWxQb2xpY3koUmVtb3ZhbFBvbGljeS5ERVNUUk9ZKVxyXG5cclxuICAgIGNvbnN0IHNhZ2VtYWtlcl9hcHAgPSBuZXcgQ2ZuQXBwKHRoaXMsICdzYWdlbWFrZXJfYXBwJywge1xyXG4gICAgICBhcHBOYW1lOiAnZGVmYXVsdCcsXHJcbiAgICAgIGFwcFR5cGU6ICdKdXB5dGVyU2VydmVyJyxcclxuICAgICAgZG9tYWluSWQ6IHNhZ2VtYWtlcl9kb21haW4uYXR0ckRvbWFpbklkLFxyXG4gICAgICB1c2VyUHJvZmlsZU5hbWU6IHNhZ2VtYWtlcl91c2VyX3Byb2ZpbGUudXNlclByb2ZpbGVOYW1lLFxyXG4gICAgXHJcbiAgICAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICByZXNvdXJjZVNwZWM6IHtcclxuICAgICAgICBpbnN0YW5jZVR5cGU6ICdzeXN0ZW0nXHJcbiAgICAgIH0sXHJcbiAgICAgIHRhZ3M6IFt7XHJcbiAgICAgICAga2V5OiAncHJvamVjdCcsXHJcbiAgICAgICAgdmFsdWU6ICdzZWN1cml0eS1sYWtlLW1sLWluc2lnaHRzJyxcclxuICAgICAgfV0sXHJcbiAgICB9KTtcclxuXHJcbiAgICBzYWdlbWFrZXJfYXBwLmFkZERlcGVuZGVuY3koc2FnZW1ha2VyX3VzZXJfcHJvZmlsZSlcclxuICAgIHNhZ2VtYWtlcl9hcHAuYXBwbHlSZW1vdmFsUG9saWN5KFJlbW92YWxQb2xpY3kuREVTVFJPWSlcclxuICAgIFxyXG4gICAgLy8gSUFNIFJvbGUgZm9yIFNhZ2VNYWtlciB1c2VyIHByb2ZpbGVzXG4gICAgY29uc3Qgc2FnZW1ha2VyX2NvbnNvbGVfcHJlc2lnbmVkX3VybF9yb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwic2FnZW1ha2VyX2NvbnNvbGVfcHJlc2lnbmVkX3VybF9yb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5Db21wb3NpdGVQcmluY2lwYWwoXG4gICAgICAgIG5ldyBpYW0uQXJuUHJpbmNpcGFsKHNhZ2VtYWtlcl9wcmVzaWduZWRfdXJsX3RydXN0ZWRfcHJpbmNpcGFsX2FybiksXG4gICAgICApLFxuICAgICAgcm9sZU5hbWU6IFwic2FnZW1ha2VyLWNvbnNvbGUtcHJlc2lnbmVkLXVybC1yb2xlXCIsXG4gICAgICAvLyBtYW5hZ2VkUG9saWNpZXM6IFtcclxuICAgICAgLy8gXVxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3Qgc2FnZW1ha2VyX3ByZXNpZ25lZF91cmxfcG9saWN5ID0gbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XHJcbiAgICAgIHN0YXRlbWVudHM6IFtcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiU01TdHVkaW9DcmVhdGVQcmVzaWduZWRVUkxBbGxvd1wiLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpDcmVhdGVQcmVzaWduZWREb21haW5VcmxcIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBzYWdlbWFrZXJfdXNlcl9wcm9maWxlLmF0dHJVc2VyUHJvZmlsZUFyblxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIGNvbmRpdGlvbnM6IHtcclxuICAgICAgICAgICAgSXBBZGRyZXNzOntcbiAgICAgICAgICAgICAgXCJhd3M6U291cmNlSXBcIjogW1xuICAgICAgICAgICAgICAgIHNhZ2VtYWtlcl9yZXN0cmljdF9jaWRyX3ByZXNpZ25lZF91cmxcbiAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgfX0gICBcbiAgICAgICAgfSksXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJTTVN0dWRpb0NvbnNvbGVSZWFkQWxsb3dcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6RGVzY3JpYmVEb21haW5cIixcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6RGVzY3JpYmVVc2VyUHJvZmlsZVwiLFxyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpMaXN0QXBwc1wiLFxyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpMaXN0RG9tYWluc1wiLFxyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpMaXN0VXNlclByb2ZpbGVzXCIsXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIFwiYXJuOlwiICsgdGhpcy5wYXJ0aXRpb24gKyBcIjpzYWdlbWFrZXI6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOlwiICsgdGhpcy5hY2NvdW50ICsgXCI6ZG9tYWluLypcIixcclxuICAgICAgICAgICAgXCJhcm46XCIgKyB0aGlzLnBhcnRpdGlvbiArIFwiOnNhZ2VtYWtlcjpcIiArIHRoaXMucmVnaW9uICsgXCI6XCIgKyB0aGlzLmFjY291bnQgKyBcIjp1c2VyLXByb2ZpbGUvXCIgKyBzYWdlbWFrZXJfZG9tYWluLmF0dHJEb21haW5JZCArIFwiLypcIixcclxuICAgICAgICAgICAgXCJhcm46XCIgKyB0aGlzLnBhcnRpdGlvbiArIFwiOnNhZ2VtYWtlcjpcIiArIHRoaXMucmVnaW9uICsgXCI6XCIgKyB0aGlzLmFjY291bnQgKyBcIjphcHAvXCIgKyBzYWdlbWFrZXJfZG9tYWluLmF0dHJEb21haW5JZCArIFwiLypcIlxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJTTVN0dWRpb1NlcnZpY2VDYXRhbG9nUmVhZEFsbG93XCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwibGljZW5zZS1tYW5hZ2VyOkxpc3RSZWNlaXZlZExpY2Vuc2VzXCIsXHJcbiAgICAgICAgICAgIFwic2FnZW1ha2VyOkdldFNhZ2VtYWtlclNlcnZpY2VjYXRhbG9nUG9ydGZvbGlvU3RhdHVzXCIsXHJcbiAgICAgICAgICAgIFwic2VydmljZWNhdGFsb2c6TGlzdEFjY2VwdGVkUG9ydGZvbGlvU2hhcmVzXCIsXHJcbiAgICAgICAgICAgIFwic2VydmljZWNhdGFsb2c6TGlzdFByaW5jaXBhbHNGb3JQb3J0Zm9saW9cIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBcIipcIlxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pXHJcbiAgICAgIF0sXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgaWFtLk1hbmFnZWRQb2xpY3kodGhpcywgXCJTYWdlTWFrZXJTdHVkaW9Db25zb2xlTWFuYWdlZFBvbGljeVwiLCB7XHJcbiAgICAgIGRlc2NyaXB0aW9uOiBcIk1hbmFnZWQgcG9saWN5IGFzc29jaWF0ZWQgdG8gdGhlIEFXUyBjb25zb2xlIHJvbGUgdG8gYWNjZXNzIFNhZ2VNYWtlciBTdHVkaW8gRG9tYWluIHByZXNpZ25lZCBVUkwuXCIsXHJcbiAgICAgIGRvY3VtZW50OnNhZ2VtYWtlcl9wcmVzaWduZWRfdXJsX3BvbGljeSxcclxuICAgICAgbWFuYWdlZFBvbGljeU5hbWU6IFwic2FnZW1ha2VyLXN0dWRpby1jb25zb2xlLWFjY2Vzcy1wb2xpY3lcIixcclxuICAgICAgcm9sZXM6IFtzYWdlbWFrZXJfY29uc29sZV9wcmVzaWduZWRfdXJsX3JvbGVdXHJcbiAgICB9KTtcclxuXHJcbiAgICBhdGhlbmFfczNfb3V0cHV0X2ttc19rZXkuYWRkVG9SZXNvdXJjZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAna21zOkRlc2NyaWJlS2V5JyxcclxuICAgICAgICAna21zOkVuY3J5cHQnLFxyXG4gICAgICAgICdrbXM6R2VuZXJhdGVEYXRhS2V5KidcclxuICAgICAgXSxcclxuICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgJyonXHJcbiAgICAgIF0sXHJcbiAgICAgIHByaW5jaXBhbHM6IFtcclxuICAgICAgICBuZXcgaWFtLkFyblByaW5jaXBhbChzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZUFybildXHJcbiAgICB9KSk7XHJcblxyXG4gICAgY29uc3QgbWxfaW5zaWdodHNfd29ya2dyb3VwID0gbmV3IGF0aGVuYS5DZm5Xb3JrR3JvdXAodGhpcywgJ21sX2luc2lnaHRzX3dvcmtncm91cCcsIHtcbiAgICAgIG5hbWU6IGF0aGVuYV93b3JrZ3JvdXBfbmFtZSxcbiAgICAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ1dvcmtncm91cCBmb3IgU2VjdXJpdHkgTGFrZSBNTCBJbnNpZ2h0cy4nLFxyXG4gICAgICByZWN1cnNpdmVEZWxldGVPcHRpb246IHRydWUsXHJcbiAgICAgIHN0YXRlOiAnRU5BQkxFRCcsXHJcbiAgICAgIC8vIHRhZ3M6IFt7XHJcbiAgICAgIC8vICAga2V5OiAna2V5JyxcclxuICAgICAgLy8gICB2YWx1ZTogJ3ZhbHVlJyxcclxuICAgICAgLy8gfV0sXHJcbiAgICAgIHdvcmtHcm91cENvbmZpZ3VyYXRpb246IHtcclxuICAgICAgICAvLyBieXRlc1NjYW5uZWRDdXRvZmZQZXJRdWVyeTogMTAwMDAwMDAsXHJcbiAgICAgICAgZW5mb3JjZVdvcmtHcm91cENvbmZpZ3VyYXRpb246IHRydWUsXHJcbiAgICAgICAgLy8gZW5naW5lVmVyc2lvbjoge1xyXG4gICAgICAgIC8vICAgZWZmZWN0aXZlRW5naW5lVmVyc2lvbjogJ2VmZmVjdGl2ZUVuZ2luZVZlcnNpb24nLFxyXG4gICAgICAgIC8vICAgc2VsZWN0ZWRFbmdpbmVWZXJzaW9uOiAnc2VsZWN0ZWRFbmdpbmVWZXJzaW9uJyxcclxuICAgICAgICAvLyB9LFxyXG4gICAgICAgIHB1Ymxpc2hDbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IGZhbHNlLFxyXG4gICAgICAgIHJlcXVlc3RlclBheXNFbmFibGVkOiBmYWxzZSxcclxuICAgICAgICByZXN1bHRDb25maWd1cmF0aW9uOiB7XHJcbiAgICAgICAgICBlbmNyeXB0aW9uQ29uZmlndXJhdGlvbjoge1xyXG4gICAgICAgICAgICBlbmNyeXB0aW9uT3B0aW9uOiBFbmNyeXB0aW9uT3B0aW9uLktNUyxcclxuICAgICAgICAgICAga21zS2V5OiBhdGhlbmFfczNfb3V0cHV0X2ttc19rZXkua2V5QXJuLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIG91dHB1dExvY2F0aW9uOiAnczM6Ly8nICsgYXRoZW5hX291dHB1dF9zM19idWNrZXQuYnVja2V0TmFtZSArICcvJyxcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcblxyXG4gIFxyXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKHRoaXMsJy9TYWdlTWFrZXJEb21haW5TdGFjay9TYWdlTWFrZXJTdHVkaW9Db25zb2xlTWFuYWdlZFBvbGljeS9SZXNvdXJjZScsXHJcbiAgICAgIFtcclxuICAgICAgICB7XHJcbiAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcclxuICAgICAgICAgIHJlYXNvbjogJ1RoZSBzcGVjaWZpYyBhY3Rpb25zIGluIHRoZSBTTVN0dWRpb1NlcnZpY2VDYXRhbG9nUmVhZEFsbG93IFNJRCByZXF1aXJlICogcmVzb3VyY2UuIFRoZSBhY3Rpb25zIGFyZSBhbGwgcmVhZC1vbmx5LicsXHJcbiAgICAgICAgfSxcclxuICAgICAgXVxyXG4gICAgKTtcclxuXHJcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgodGhpcywnL1NhZ2VNYWtlckRvbWFpblN0YWNrL1NhZ2VNYWtlclN0dWRpb1VzZXJQcm9maWxlTWFuYWdlZFBvbGljeS9SZXNvdXJjZScsXHJcbiAgICAgIFtcclxuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgICAgcmVhc29uOiAnVGhlIHNwZWNpZmljIGFjdGlvbnMgaW4gdGhlIFMzUmVhZCBhbmQgTGFrZUZvcm1hdGlvbkFsbG93IFNJRCByZXF1aXJlICogcmVzb3VyY2UuIEJlZHJvY2sgY3Jvc3MtcmVnaW9uIGluZmVyZW5jZSBhbHNvIHJlcXVpcmVzIHdpbGRjYXJkIGZvdW5kYXRpb24tbW9kZWwgcmVzb3VyY2VzIGZvciB0aGUgcm91dGVkIG1vZGVsIHJlZ2lvbnMuJyxcbiAgICAgICAgfSxcbiAgICAgIF1cbiAgICApO1xuXHJcbiAgfVxyXG59XHJcbiJdfQ==