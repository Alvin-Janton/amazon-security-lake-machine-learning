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
        const create_lake_formation_permissions = contextBoolean("createLakeFormationPermissions", false);
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
                reason: 'The specific actions in the S3Read and LakeFormationAllow SID require * resource. The actions are all read-only.',
            },
        ]);
    }
}
exports.SageMakerDomainStack = SageMakerDomainStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2FnZW1ha2VyX2RvbWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNhZ2VtYWtlcl9kb21haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsNkNBQW9GO0FBQ3BGLDJDQUEyQztBQUUzQyxpREFBMEM7QUFDMUMsNkRBQThFO0FBQzlFLCtCQUE0QjtBQUM1QixpREFBc0w7QUFDdEwsbURBQStEO0FBQy9ELHlEQUF5RDtBQUN6RCxpREFBaUQ7QUFDakQsK0NBQWdIO0FBQ2hILGlGQUF1RTtBQUN2RSxxQ0FBMEM7QUFDMUMscUVBQXdFO0FBRXhFLE1BQWEsb0JBQXFCLFNBQVEsbUJBQUs7SUFDN0MsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFrQjtRQUMxRCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLGFBQWEsR0FBRyxDQUFDLEdBQVcsRUFBRSxZQUFvQixFQUFVLEVBQUU7WUFDbEUsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDM0MsT0FBTyxLQUFLLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztRQUNwRCxDQUFDLENBQUM7UUFFRixNQUFNLGNBQWMsR0FBRyxDQUFDLEdBQVcsRUFBRSxZQUFxQixFQUFXLEVBQUU7WUFDckUsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDM0MsT0FBTyxLQUFLLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztRQUNwRCxDQUFDLENBQUM7UUFFRixNQUFNLHFDQUFxQyxHQUFHLGFBQWEsQ0FBQyxtQ0FBbUMsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUM5RyxNQUFNLDZDQUE2QyxHQUFHLGFBQWEs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cEQsS0FBSztnQkFDTCwrQkFBK0IsRUFBRSxLQUFLO2dCQUN0QyxvQkFBb0IsRUFBRSxLQUFLO2dCQUMzQixtQkFBbUIsRUFBRTtvQkFDbkIsdUJBQXVCLEVBQUU7d0JBQ3ZCLGdCQUFnQixFQUFFLDBDQUFnQixDQUFDLEdBQUc7d0JBQ3RDLE1BQU0sRUFBRSx3QkFBd0IsQ0FBQyxNQUFNO3FCQUN4QztvQkFDRCxjQUFjLEVBQUUsT0FBTyxHQUFHLHVCQUF1QixDQUFDLFVBQVUsR0FBRyxHQUFHO2lCQUNuRTthQUNGO1NBQ0YsQ0FBQyxDQUFDO1FBR0gseUJBQWUsQ0FBQyw2QkFBNkIsQ0FBQyxJQUFJLEVBQUMsb0VBQW9FLEVBQ3JIO1lBQ0U7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLG9IQUFvSDthQUM3SDtTQUNGLENBQ0YsQ0FBQztRQUVGLHlCQUFlLENBQUMsNkJBQTZCLENBQUMsSUFBSSxFQUFDLHdFQUF3RSxFQUN6SDtZQUNFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxrSEFBa0g7YUFDM0g7U0FDRixDQUNGLENBQUM7SUFFSixDQUFDO0NBQ0Y7QUFwMEJELG9EQW8wQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBTdGFjaywgU3RhY2tQcm9wcywgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIENmbk91dHB1dCB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuaW1wb3J0IHsgS2V5IH0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1rbXNcIjtcbmltcG9ydCB7IENmbkFwcCwgQ2ZuRG9tYWluLCBDZm5Vc2VyUHJvZmlsZSB9IGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc2FnZW1ha2VyXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBGbG93TG9nRGVzdGluYXRpb24sIEZsb3dMb2dUcmFmZmljVHlwZSwgVnBjLCBTdWJuZXRUeXBlLCBTZWN1cml0eUdyb3VwLCBQZWVyLCBQb3J0LCBJbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UsIEludGVyZmFjZVZwY0VuZHBvaW50U2VydmljZSB9IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWMyXCI7XG5pbXBvcnQgeyBMb2dHcm91cCwgUmV0ZW50aW9uRGF5cyB9IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgY29kZWNvbW1pdCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29kZWNvbW1pdCc7XG5pbXBvcnQgKiBhcyBhdGhlbmEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWF0aGVuYSc7XG5pbXBvcnQgeyBCbG9ja1B1YmxpY0FjY2VzcywgQnVja2V0LCBCdWNrZXRFbmNyeXB0aW9uLCBPYmplY3RPd25lcnNoaXAsIFN0b3JhZ2VDbGFzcyB9IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IEVuY3J5cHRpb25PcHRpb24gfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXN0ZXBmdW5jdGlvbnMtdGFza3NcIjtcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuaW1wb3J0IHsgQ2ZuUHJpbmNpcGFsUGVybWlzc2lvbnMgfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxha2Vmb3JtYXRpb25cIjtcblxuZXhwb3J0IGNsYXNzIFNhZ2VNYWtlckRvbWFpblN0YWNrIGV4dGVuZHMgU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IGNvbnRleHRTdHJpbmcgPSAoa2V5OiBzdHJpbmcsIGRlZmF1bHRWYWx1ZTogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gdGhpcy5ub2RlLnRyeUdldENvbnRleHQoa2V5KTtcbiAgICAgIHJldHVybiB2YWx1ZSA9PT0gdW5kZWZpbmVkID8gZGVmYXVsdFZhbHVlIDogdmFsdWU7XG4gICAgfTtcblxuICAgIGNvbnN0IGNvbnRleHRCb29sZWFuID0gKGtleTogc3RyaW5nLCBkZWZhdWx0VmFsdWU6IGJvb2xlYW4pOiBib29sZWFuID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gdGhpcy5ub2RlLnRyeUdldENvbnRleHQoa2V5KTtcbiAgICAgIHJldHVybiB2YWx1ZSA9PT0gdW5kZWZpbmVkID8gZGVmYXVsdFZhbHVlIDogdmFsdWU7XG4gICAgfTtcblxuICAgIGNvbnN0IHNhZ2VtYWtlcl9yZXN0cmljdF9jaWRyX3ByZXNpZ25lZF91cmwgPSBjb250ZXh0U3RyaW5nKFwic2FnZW1ha2VyUmVzdHJpY3RDaWRyUHJlc2lnbmVkVXJsXCIsIFwiMC4wLjAuMC8wXCIpO1xuICAgIGNvbnN0IHNhZ2VtYWtlcl9wcmVzaWduZWRfdXJsX3RydXN0ZWRfcHJpbmNpcGFsX2FybiA9IGNvbnRleHRTdHJpbmcoXCJzYWdlbWFrZXJQcmVzaWduZWRVcmxUcnVzdGVkUHJpbmNpcGFsQXJuXCIsIFwiYXJuOmF3czppYW06OjEyMzQ1Njc4OTAxMjpyb2xlL0FkbWluXCIpO1xuICAgIGNvbnN0IGN3X3ZwY19mbG93X2xvZ3NfbG9nX2dyb3VwX25hbWUgPSBjb250ZXh0U3RyaW5nKFwiY2xvdWRXYXRjaFZwY0Zsb3dMb2dzTG9nR3JvdXBOYW1lXCIsIFwiL2F3cy92cGMvZmxvd2xvZ3MvU2FnZU1ha2VyRG9tYWluU3RhY2tcIik7XG4gICAgY29uc3Qgc2VjdXJpdHlfbGFrZV9kYXRhYmFzZV9uYW1lID0gY29udGV4dFN0cmluZyhcInNlY3VyaXR5TGFrZURhdGFiYXNlTmFtZVwiLCBcImFtYXpvbl9zZWN1cml0eV9sYWtlX2dsdWVfZGJfdXNfZWFzdF8xXCIpO1xuICAgIGNvbnN0IHNlY3VyaXR5X2xha2VfdGFibGVfbmFtZSA9IGNvbnRleHRTdHJpbmcoXCJzZWN1cml0eUxha2VUYWJsZU5hbWVcIiwgXCJhbWF6b25fc2VjdXJpdHlfbGFrZV90YWJsZV91c19lYXN0XzFfc2hfZmluZGluZ3NfMl8wXCIpO1xuICAgIGNvbnN0IGF0aGVuYV93b3JrZ3JvdXBfbmFtZSA9IGNvbnRleHRTdHJpbmcoXCJhdGhlbmFXb3JrZ3JvdXBOYW1lXCIsIFwic2VjdXJpdHlfbGFrZV9pbnNpZ2h0c1wiKTtcbiAgICBjb25zdCBjcmVhdGVfbGFrZV9mb3JtYXRpb25fcGVybWlzc2lvbnMgPSBjb250ZXh0Qm9vbGVhbihcImNyZWF0ZUxha2VGb3JtYXRpb25QZXJtaXNzaW9uc1wiLCBmYWxzZSk7XG5cclxuICAgIC8vIENvZGVDb21taXQgcmVwb3NpdG9yeVxyXG4gICAgY29uc3Qgc2FnZW1ha2VyX25vdGVib29rX21sX2luc2lnaHRzX3JlcG9zaXRvcnkgPSBuZXcgY29kZWNvbW1pdC5SZXBvc2l0b3J5KHRoaXMsICdzYWdlbWFrZXJfbm90ZWJvb2tfbWxfaW5zaWdodHNfcmVwb3NpdG9yeScsIHtcclxuICAgICAgcmVwb3NpdG9yeU5hbWU6ICdzYWdlbWFrZXJfbWxfaW5zaWdodHNfcmVwbycsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnUmVwb3NpdG9yeSBmb3IgU2FnZU1ha2VyIG5vdGVib29rcyB0byBydW4gYW5hbHl0aWNzIGZvciBTZWN1cml0eSBMYWtlLicsXHJcbiAgICAgIGNvZGU6IGNvZGVjb21taXQuQ29kZS5mcm9tWmlwRmlsZShqb2luKF9fZGlybmFtZSwgXCIuLi9ub3RlYm9va3Mvbm90ZWJvb2tzLnppcFwiKSwgXCJtYWluXCIpXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsJ3NhZ2VtYWtlci1ub3RlYm9vay1tbC1pbnNpZ2h0cy1yZXBvc2l0b3J5LVVSTCcsIHtcclxuICAgICAgZGVzY3JpcHRpb246J1RoZSBDb2RlQ29tbWl0IHJlcG9zaXRvcnkgVVJMIHRvIGNsb25lIHdpdGhpbiB5b3VyIFNhZ2VNYWtlciB1c2VyLXByb2ZpbGUgbm90ZWJvb2suJyxcclxuICAgICAgdmFsdWU6IHNhZ2VtYWtlcl9ub3RlYm9va19tbF9pbnNpZ2h0c19yZXBvc2l0b3J5LnJlcG9zaXRvcnlDbG9uZVVybEh0dHBcclxuICAgIH0pXHJcblxyXG5cclxuICAgIC8vIEtNUyBLZXkgZm9yIFMzIGJ1Y2tldFxyXG4gICAgY29uc3QgYXRoZW5hX3MzX291dHB1dF9rbXNfa2V5ID0gbmV3IEtleSh0aGlzLCBcImF0aGVuYV9zM19vdXRwdXRfa21zX2tleVwiLCB7XHJcbiAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWSxcclxuICAgICAgcGVuZGluZ1dpbmRvdzogRHVyYXRpb24uZGF5cyg3KSxcclxuICAgICAgZGVzY3JpcHRpb246IFwiS01TIGtleSBmb3IgUzMgYnVja2V0IHRvIHN0b3JlIGF0aGVuYSB3b3JrZ3JvdXAgb3V0cHV0LlwiLFxyXG4gICAgICBlbmFibGVLZXlSb3RhdGlvbjogdHJ1ZSxcclxuICAgICAgYWxpYXM6IFwiYXRoZW5hX3MzX291dHB1dF9rbXNfa2V5XCJcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEtNUyBLZXkgZm9yIFNhZ2VNYWtlciBEb21haW5cclxuICAgIGNvbnN0IHNhZ2VtYWtlcl9rbXNfa2V5ID0gbmV3IEtleSh0aGlzLCBcInNhZ2VtYWtlcl9rbXNfa2V5XCIsIHtcclxuICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxyXG4gICAgICBwZW5kaW5nV2luZG93OiBEdXJhdGlvbi5kYXlzKDcpLFxyXG4gICAgICBkZXNjcmlwdGlvbjogXCJLTVMga2V5IGZvciBTYWdlTWFrZXIgRG9tYWluIHJlc291cmNlcy5cIixcclxuICAgICAgZW5hYmxlS2V5Um90YXRpb246IHRydWUsXHJcbiAgICAgIGFsaWFzOiBcInNhZ2VtYWtlcl9kb21haW5fa21zX2tleVwiXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBjd19mbG93X2xvZ3MgPSBuZXcgTG9nR3JvdXAodGhpcywgXCJjd19mbG93X2xvZ3NcIiwge1xuICAgICAgbG9nR3JvdXBOYW1lOiBjd192cGNfZmxvd19sb2dzX2xvZ19ncm91cF9uYW1lLFxuICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgcmV0ZW50aW9uOiBSZXRlbnRpb25EYXlzLk9ORV9ZRUFSLFxuICAgICAgZW5jcnlwdGlvbktleTogc2FnZW1ha2VyX2ttc19rZXlcbiAgICAgIH0pO1xyXG4gICAgXHJcbiAgICBzYWdlbWFrZXJfa21zX2tleS5hZGRUb1Jlc291cmNlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgIFwia21zOkVuY3J5cHQqXCIsXHJcbiAgICAgICAgXCJrbXM6RGVjcnlwdCpcIixcclxuICAgICAgICBcImttczpSZUVuY3J5cHQqXCIsXHJcbiAgICAgICAgXCJrbXM6R2VuZXJhdGVEYXRhS2V5KlwiLFxyXG4gICAgICAgIFwia21zOkRlc2NyaWJlKlwiXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgIFwiKlwiXHJcbiAgICAgIF0sXHJcbiAgICAgIHByaW5jaXBhbHM6IFtcclxuICAgICAgICBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJsb2dzLlwiICsgdGhpcy5yZWdpb24gKyBcIi5hbWF6b25hd3MuY29tXCIpXHJcbiAgICAgIF0sXG4gICAgICBjb25kaXRpb25zOntcbiAgICAgICAgQXJuRXF1YWxzOntcbiAgICAgICAgICBcImttczpFbmNyeXB0aW9uQ29udGV4dDphd3M6bG9nczphcm5cIjogW1xuICAgICAgICAgICAgXCJhcm46YXdzOmxvZ3M6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOlwiICsgdGhpcy5hY2NvdW50KyBcIjpsb2ctZ3JvdXA6XCIgKyBjd192cGNfZmxvd19sb2dzX2xvZ19ncm91cF9uYW1lXG4gICAgICAgICAgXVxuICAgICAgICB9fSBcbiAgICB9KSk7XG5cclxuICAgIC8vIENyZWF0ZSBTYWdlTWFrZXIgVlBDXHJcbiAgICBjb25zdCBzYWdlbWFrZXJfdnBjID0gbmV3IFZwYyh0aGlzLCBcInNhZ2VtYWtlcl92cGNcIiwge1xyXG4gICAgICBtYXhBenM6IDIsXHJcbiAgICAgIHN1Ym5ldENvbmZpZ3VyYXRpb246IFtcclxuICAgICAgICB7XHJcbiAgICAgICAgICBjaWRyTWFzazogMjQsXHJcbiAgICAgICAgICBuYW1lOiBcInB1YmxpY19zdWJuZXRfZm9yX25hdF9nd1wiLFxyXG4gICAgICAgICAgc3VibmV0VHlwZTogU3VibmV0VHlwZS5QVUJMSUMsXHJcbiAgICAgICAgICBtYXBQdWJsaWNJcE9uTGF1bmNoOiBmYWxzZVxyXG4gICAgICAgIH0sXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxyXG4gICAgICAgICAgbmFtZTogXCJ3b3JrbG9hZF9zdWJuZXRfd2l0aF9uYXRcIixcclxuICAgICAgICAgIHN1Ym5ldFR5cGU6IFN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyxcclxuICAgICAgICB9LFxyXG4gICAgICBdLFxyXG4gICAgICBmbG93TG9nczoge1xyXG4gICAgICAgIFwiczNcIjoge1xyXG4gICAgICAgICAgZGVzdGluYXRpb246IEZsb3dMb2dEZXN0aW5hdGlvbi50b0Nsb3VkV2F0Y2hMb2dzKGN3X2Zsb3dfbG9ncyksXHJcbiAgICAgICAgICB0cmFmZmljVHlwZTogRmxvd0xvZ1RyYWZmaWNUeXBlLkFMTCxcclxuICAgICAgfX1cclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IHNhZ2VtYWtlcl93b3JrbG9hZF9zZyA9IG5ldyBTZWN1cml0eUdyb3VwKHRoaXMsIFwic2FnZW1ha2VyX3dvcmtsb2FkX3NnXCIsIHtcclxuICAgICAgdnBjOiBzYWdlbWFrZXJfdnBjLFxyXG4gICAgICBkZXNjcmlwdGlvbjogXCJTYWdlTWFrZXIgV29ya2xvYWQgU0dcIixcclxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogZmFsc2UsXHJcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiBcInNhZ2VtYWtlcl93b3JrbG9hZF9zZ1wiXHJcbiAgICB9KTtcclxuXHJcbiAgICBzYWdlbWFrZXJfd29ya2xvYWRfc2cuY29ubmVjdGlvbnMuYWxsb3dUbyhzYWdlbWFrZXJfd29ya2xvYWRfc2csIFBvcnQudGNwUmFuZ2UoODE5Miw2NTUzNSksIFwiQ29tbXVuaWNhdGlvbiByZXF1aXJlZCB3aXRoIFNhZ2VNYWtlciBzZXJ2aWNlLW93bmVkIFZQQ1wiKVxyXG4gICAgc2FnZW1ha2VyX3dvcmtsb2FkX3NnLmNvbm5lY3Rpb25zLmFsbG93VG8oc2FnZW1ha2VyX3dvcmtsb2FkX3NnLCBQb3J0LnVkcCg1MDApLCBcIkNvbW11bmljYXRpb24gcmVxdWlyZWQgd2l0aCBTYWdlTWFrZXIgc2VydmljZS1vd25lZCBWUENcIilcclxuICAgIHNhZ2VtYWtlcl93b3JrbG9hZF9zZy5jb25uZWN0aW9ucy5hbGxvd1RvKHNhZ2VtYWtlcl93b3JrbG9hZF9zZywgUG9ydC5lc3AoKSwgXCJDb21tdW5pY2F0aW9uIHJlcXVpcmVkIHdpdGggU2FnZU1ha2VyIHNlcnZpY2Utb3duZWQgVlBDXCIpXHJcbiAgICBzYWdlbWFrZXJfd29ya2xvYWRfc2cuY29ubmVjdGlvbnMuYWxsb3dUbyhQZWVyLmFueUlwdjQoKSwgUG9ydC50Y3AoNDQzKSwgXCJBbGxvdyBIVFRQUyBPdXRib3VuZCBmb3IgZWdyZXNzLW9ubHkgaW50ZXJuZXQgYWNjZXNzXCIpXHJcbiAgICBzYWdlbWFrZXJfd29ya2xvYWRfc2cuY29ubmVjdGlvbnMuYWxsb3dUbyhQZWVyLmFueUlwdjQoKSwgUG9ydC50Y3AoODApLCBcIkFsbG93IEhUVFAgT3V0Ym91bmQgZm9yIGVncmVzcy1vbmx5IGludGVybmV0IGFjY2Vzc1wiKVxyXG5cclxuICAgIHNhZ2VtYWtlcl93b3JrbG9hZF9zZy5jb25uZWN0aW9ucy5hbGxvd0Zyb20oc2FnZW1ha2VyX3dvcmtsb2FkX3NnLCBQb3J0LnRjcFJhbmdlKDgxOTIsNjU1MzUpLCBcIkNvbW11bmljYXRpb24gcmVxdWlyZWQgd2l0aCBTYWdlTWFrZXIgc2VydmljZS1vd25lZCBWUENcIilcclxuICAgIHNhZ2VtYWtlcl93b3JrbG9hZF9zZy5jb25uZWN0aW9ucy5hbGxvd0Zyb20oc2FnZW1ha2VyX3dvcmtsb2FkX3NnLCBQb3J0LnVkcCg1MDApLCBcIkNvbW11bmljYXRpb24gcmVxdWlyZWQgd2l0aCBTYWdlTWFrZXIgc2VydmljZS1vd25lZCBWUENcIilcclxuICAgIHNhZ2VtYWtlcl93b3JrbG9hZF9zZy5jb25uZWN0aW9ucy5hbGxvd0Zyb20oc2FnZW1ha2VyX3dvcmtsb2FkX3NnLCBQb3J0LmVzcCgpLCBcIkNvbW11bmljYXRpb24gcmVxdWlyZWQgd2l0aCBTYWdlTWFrZXIgc2VydmljZS1vd25lZCBWUENcIilcclxuICAgIHNhZ2VtYWtlcl93b3JrbG9hZF9zZy5jb25uZWN0aW9ucy5hbGxvd0Zyb20oc2FnZW1ha2VyX3dvcmtsb2FkX3NnLCBQb3J0LnRjcCg0NDMpLCBcIkFsbG93IEhUVFBTIEluYm91bmQgZm9yIFZQQyBpbnRlcmZhY2UgZW5kcG9pbnRcIilcclxuXHJcbiAgICBzYWdlbWFrZXJfdnBjLmFkZEludGVyZmFjZUVuZHBvaW50KFwia21zX2VuZHBvaW50XCIse1xyXG4gICAgICBzZXJ2aWNlOiBJbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuS01TLFxyXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcclxuICAgICAgc3VibmV0czoge1xyXG4gICAgICAgICBzdWJuZXRzOiBbXHJcbiAgICAgICAgICBzYWdlbWFrZXJfdnBjLnNlbGVjdFN1Ym5ldHMoe3N1Ym5ldEdyb3VwTmFtZTogXCJ3b3JrbG9hZF9zdWJuZXRfd2l0aF9uYXRcIn0pLnN1Ym5ldHNbMF1cclxuICAgICAgICAgXVxyXG4gICAgICB9LFxyXG4gICAgICBzZWN1cml0eUdyb3VwczogKFxyXG4gICAgICAgIFtzYWdlbWFrZXJfd29ya2xvYWRfc2ddXHJcbiAgICAgIClcclxuICAgIH0pO1xyXG5cclxuICAgIHNhZ2VtYWtlcl92cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoXCJzYWdlbWFrZXJfYXBpX2VuZHBvaW50XCIse1xyXG4gICAgICBzZXJ2aWNlOiBJbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuU0FHRU1BS0VSX0FQSSxcclxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXHJcbiAgICAgIHN1Ym5ldHM6IHtcclxuICAgICAgICAgc3VibmV0czogW1xyXG4gICAgICAgICAgc2FnZW1ha2VyX3ZwYy5zZWxlY3RTdWJuZXRzKHtzdWJuZXRHcm91cE5hbWU6IFwid29ya2xvYWRfc3VibmV0X3dpdGhfbmF0XCJ9KS5zdWJuZXRzWzBdXHJcbiAgICAgICAgIF1cclxuICAgICAgfSxcclxuICAgICAgc2VjdXJpdHlHcm91cHM6IChcclxuICAgICAgICBbc2FnZW1ha2VyX3dvcmtsb2FkX3NnXVxyXG4gICAgICApXHJcbiAgICB9KTtcclxuXHJcblxyXG4gICAgc2FnZW1ha2VyX3ZwYy5hZGRJbnRlcmZhY2VFbmRwb2ludChcInNhZ2VtYWtlcl9ydW50aW1lX2VuZHBvaW50XCIse1xyXG4gICAgICBzZXJ2aWNlOiBJbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuU0FHRU1BS0VSX1JVTlRJTUUsXHJcbiAgICAgIHByaXZhdGVEbnNFbmFibGVkOiB0cnVlLFxyXG4gICAgICBzdWJuZXRzOiB7XHJcbiAgICAgICAgIHN1Ym5ldHM6IFtcclxuICAgICAgICAgIHNhZ2VtYWtlcl92cGMuc2VsZWN0U3VibmV0cyh7c3VibmV0R3JvdXBOYW1lOiBcIndvcmtsb2FkX3N1Ym5ldF93aXRoX25hdFwifSkuc3VibmV0c1swXVxyXG4gICAgICAgICBdXHJcbiAgICAgIH0sXHJcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiAoXHJcbiAgICAgICAgW3NhZ2VtYWtlcl93b3JrbG9hZF9zZ11cclxuICAgICAgKVxyXG4gICAgfSk7XHJcblxyXG4gICAgc2FnZW1ha2VyX3ZwYy5hZGRJbnRlcmZhY2VFbmRwb2ludChcInNhZ2VtYWtlcl9zdHVkaW9fZW5kcG9pbnRcIix7XHJcbiAgICAgIHNlcnZpY2U6IG5ldyBJbnRlcmZhY2VWcGNFbmRwb2ludFNlcnZpY2UoXCJhd3Muc2FnZW1ha2VyLlwiICsgdGhpcy5yZWdpb24gKyBcIi5zdHVkaW9cIiwgNDQzKSxcclxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXHJcbiAgICAgIHN1Ym5ldHM6IHtcclxuICAgICAgICAgc3VibmV0czogW1xyXG4gICAgICAgICAgc2FnZW1ha2VyX3ZwYy5zZWxlY3RTdWJuZXRzKHtzdWJuZXRHcm91cE5hbWU6IFwid29ya2xvYWRfc3VibmV0X3dpdGhfbmF0XCJ9KS5zdWJuZXRzWzBdXHJcbiAgICAgICAgIF1cclxuICAgICAgfSxcclxuICAgICAgc2VjdXJpdHlHcm91cHM6IChcclxuICAgICAgICBbc2FnZW1ha2VyX3dvcmtsb2FkX3NnXVxyXG4gICAgICApXHJcbiAgICB9KTtcclxuXHJcbiAgICBzYWdlbWFrZXJfdnBjLmFkZEludGVyZmFjZUVuZHBvaW50KFwiYXRoZW5hX2VuZHBvaW50XCIse1xyXG4gICAgICBzZXJ2aWNlOiBJbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuQVRIRU5BLFxyXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcclxuICAgICAgc3VibmV0czoge1xyXG4gICAgICAgICBzdWJuZXRzOiBbXHJcbiAgICAgICAgICBzYWdlbWFrZXJfdnBjLnNlbGVjdFN1Ym5ldHMoe3N1Ym5ldEdyb3VwTmFtZTogXCJ3b3JrbG9hZF9zdWJuZXRfd2l0aF9uYXRcIn0pLnN1Ym5ldHNbMF1cclxuICAgICAgICAgXVxyXG4gICAgICB9LFxyXG4gICAgICBzZWN1cml0eUdyb3VwczogKFxyXG4gICAgICAgIFtzYWdlbWFrZXJfd29ya2xvYWRfc2ddXHJcbiAgICAgIClcclxuICAgIH0pO1xyXG5cclxuICAgIHNhZ2VtYWtlcl92cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoXCJzM19lbmRwb2ludFwiLHtcclxuICAgICAgc2VydmljZTogbmV3IEludGVyZmFjZVZwY0VuZHBvaW50U2VydmljZShcImNvbS5hbWF6b25hd3MuXCIgKyB0aGlzLnJlZ2lvbiArIFwiLnMzXCIsIDQ0MyksXHJcbiAgICAgIHN1Ym5ldHM6IHtcclxuICAgICAgICAgc3VibmV0czogW1xyXG4gICAgICAgICAgc2FnZW1ha2VyX3ZwYy5zZWxlY3RTdWJuZXRzKHtzdWJuZXRHcm91cE5hbWU6IFwid29ya2xvYWRfc3VibmV0X3dpdGhfbmF0XCJ9KS5zdWJuZXRzWzBdXHJcbiAgICAgICAgIF1cclxuICAgICAgfSxcclxuICAgICAgc2VjdXJpdHlHcm91cHM6IChcclxuICAgICAgICBbc2FnZW1ha2VyX3dvcmtsb2FkX3NnXVxyXG4gICAgICApXHJcbiAgICB9KTtcclxuXHJcbiAgICBzYWdlbWFrZXJfdnBjLmFkZEludGVyZmFjZUVuZHBvaW50KFwiY29kZWNvbW1pdF9lbmRwb2ludFwiLHtcclxuICAgICAgc2VydmljZTogSW50ZXJmYWNlVnBjRW5kcG9pbnRBd3NTZXJ2aWNlLkNPREVDT01NSVQsXHJcbiAgICAgIHN1Ym5ldHM6IHtcclxuICAgICAgICAgc3VibmV0czogW1xyXG4gICAgICAgICAgc2FnZW1ha2VyX3ZwYy5zZWxlY3RTdWJuZXRzKHtzdWJuZXRHcm91cE5hbWU6IFwid29ya2xvYWRfc3VibmV0X3dpdGhfbmF0XCJ9KS5zdWJuZXRzWzBdXHJcbiAgICAgICAgIF1cclxuICAgICAgfSxcclxuICAgICAgc2VjdXJpdHlHcm91cHM6IChcclxuICAgICAgICBbc2FnZW1ha2VyX3dvcmtsb2FkX3NnXVxyXG4gICAgICApXHJcbiAgICB9KTtcclxuXHJcbiAgICBzYWdlbWFrZXJfdnBjLmFkZEludGVyZmFjZUVuZHBvaW50KFwiY29kZWNvbW1pdF9naXRfZW5kcG9pbnRcIix7XHJcbiAgICAgIHNlcnZpY2U6IEludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5DT0RFQ09NTUlUX0dJVCxcclxuICAgICAgc3VibmV0czoge1xyXG4gICAgICAgICBzdWJuZXRzOiBbXHJcbiAgICAgICAgICBzYWdlbWFrZXJfdnBjLnNlbGVjdFN1Ym5ldHMoe3N1Ym5ldEdyb3VwTmFtZTogXCJ3b3JrbG9hZF9zdWJuZXRfd2l0aF9uYXRcIn0pLnN1Ym5ldHNbMF1cclxuICAgICAgICAgXVxyXG4gICAgICB9LFxyXG4gICAgICBzZWN1cml0eUdyb3VwczogKFxyXG4gICAgICAgIFtzYWdlbWFrZXJfd29ya2xvYWRfc2ddXHJcbiAgICAgIClcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIFMzIEJ1Y2tldCBmb3IgQXRoZW5hIG91dHB1dFxyXG4gICAgY29uc3QgczNfYWNjZXNzX2xvZ3MgPSBuZXcgQnVja2V0KHRoaXMsICdzM19hY2Nlc3NfbG9ncycsIHtcclxuICAgICAgYnVja2V0TmFtZTogJ2F0aGVuYS1tbC1pbnNpZ2h0cy1zMy1hY2Nlc3MtbG9ncy0nICsgdGhpcy5hY2NvdW50LFxyXG4gICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXHJcbiAgICAgIGJ1Y2tldEtleUVuYWJsZWQ6IHRydWUsXHJcbiAgICAgIGVuY3J5cHRpb246IEJ1Y2tldEVuY3J5cHRpb24uS01TX01BTkFHRUQsXHJcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXHJcbiAgICAgIHZlcnNpb25lZDogdHJ1ZSxcclxuICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IEJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcclxuICAgICAgb2JqZWN0T3duZXJzaGlwOiBPYmplY3RPd25lcnNoaXAuQlVDS0VUX09XTkVSX1BSRUZFUlJFRCxcclxuICAgICAgcHVibGljUmVhZEFjY2VzczogZmFsc2UsXHJcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbe1xyXG4gICAgICAgIGV4cGlyYXRpb246IER1cmF0aW9uLmRheXMoMzY1KSxcclxuICAgICAgICB0cmFuc2l0aW9uczogW3tcclxuICAgICAgICAgICAgc3RvcmFnZUNsYXNzOiBTdG9yYWdlQ2xhc3MuSU5URUxMSUdFTlRfVElFUklORyxcclxuICAgICAgICAgICAgdHJhbnNpdGlvbkFmdGVyOiBEdXJhdGlvbi5kYXlzKDMxKVxyXG4gICAgICAgIH1dXHJcbiAgICB9XVxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3QgYXRoZW5hX291dHB1dF9zM19idWNrZXQgPSBuZXcgQnVja2V0KHRoaXMsICdhdGhlbmFfb3V0cHV0X3MzX2J1Y2tldCcsIHtcclxuICAgICAgYnVja2V0TmFtZTogJ2F0aGVuYS1tbC1pbnNpZ2h0cy1idWNrZXQtcmVzdWx0cy0nICsgdGhpcy5hY2NvdW50LFxyXG4gICAgICBzZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0OiBzM19hY2Nlc3NfbG9ncyxcclxuICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxyXG4gICAgICBidWNrZXRLZXlFbmFibGVkOiB0cnVlLFxyXG4gICAgICBlbmNyeXB0aW9uOiBCdWNrZXRFbmNyeXB0aW9uLktNUyxcclxuICAgICAgZW5jcnlwdGlvbktleTogYXRoZW5hX3MzX291dHB1dF9rbXNfa2V5LFxyXG4gICAgICBlbmZvcmNlU1NMOiB0cnVlLFxyXG4gICAgICB2ZXJzaW9uZWQ6IHRydWUsXHJcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBCbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXHJcbiAgICAgIG9iamVjdE93bmVyc2hpcDogT2JqZWN0T3duZXJzaGlwLkJVQ0tFVF9PV05FUl9QUkVGRVJSRUQsXHJcbiAgICAgIHB1YmxpY1JlYWRBY2Nlc3M6IGZhbHNlLFxyXG4gICAgICBsaWZlY3ljbGVSdWxlczogW3tcclxuICAgICAgICBleHBpcmF0aW9uOiBEdXJhdGlvbi5kYXlzKDM2NSksXHJcbiAgICAgICAgdHJhbnNpdGlvbnM6IFt7XHJcbiAgICAgICAgICAgIHN0b3JhZ2VDbGFzczogU3RvcmFnZUNsYXNzLklOVEVMTElHRU5UX1RJRVJJTkcsXHJcbiAgICAgICAgICAgIHRyYW5zaXRpb25BZnRlcjogRHVyYXRpb24uZGF5cygzMSlcclxuICAgICAgICB9XVxyXG4gICAgfV1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIElBTSBSb2xlIGZvciBTYWdlTWFrZXIgdXNlciBwcm9maWxlc1xyXG4gICAgY29uc3Qgc2FnZW1ha2VyX3VzZXJfcHJvZmlsZV9yb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwic2FnZW1ha2VyX3VzZXJfcHJvZmlsZV9yb2xlXCIsIHtcclxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJzYWdlbWFrZXIuYW1hem9uYXdzLmNvbVwiKSxcclxuICAgICAgcm9sZU5hbWU6IFwic2FnZW1ha2VyLXVzZXItcHJvZmlsZS1mb3Itc2VjdXJpdHktbGFrZVwiLFxyXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcclxuICAgICAgXVxyXG4gICAgfSk7XHJcblxyXG4gICAgc2FnZW1ha2VyX2ttc19rZXkuYWRkVG9SZXNvdXJjZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICBcImttczpEZXNjcmliZUtleVwiLFxyXG4gICAgICAgIFwia21zOkRlY3J5cHRcIixcclxuICAgICAgICBcImttczpHZW5lcmF0ZURhdGFLZXlcIixcclxuICAgICAgICBcImttczpDcmVhdGVHcmFudFwiXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgIFwiKlwiXHJcbiAgICAgIF0sXHJcbiAgICAgIHByaW5jaXBhbHM6IFtcclxuICAgICAgICBuZXcgaWFtLkFyblByaW5jaXBhbChzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZUFybilcclxuICAgICAgXVxyXG4gICAgfSkpO1xyXG5cclxuICAgIGNvbnN0IHNhZ2VtYWtlcl91c2VyX3Byb2ZpbGVfcG9saWN5ID0gbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XHJcbiAgICAgIHN0YXRlbWVudHM6IFtcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiQ2xvdWRXYXRjaExvZ0dyb3VwQWxsb3dcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ0dyb3VwXCIsXHJcbiAgICAgICAgICAgIFwibG9nczpDcmVhdGVMb2dTdHJlYW1cIixcclxuICAgICAgICAgICAgXCJsb2dzOlB1dExvZ0V2ZW50c1wiXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIFwiYXJuOmF3czpsb2dzOlwiICsgdGhpcy5yZWdpb24gK1wiOlwiICsgdGhpcy5hY2NvdW50ICsgXCI6bG9nLWdyb3VwOi9hd3Mvc2FnZW1ha2VyL3N0dWRpbzoqXCJcclxuICAgICAgICAgIF0gICBcclxuICAgICAgICB9KSxcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiUzNSZWFkXCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwiczM6TGlzdEJ1Y2tldFwiLFxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBcIipcIlxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJTM0FsbG93XCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwiczM6QWJvcnRNdWx0aXBhcnRVcGxvYWRcIixcclxuICAgICAgICAgICAgXCJzMzpEZWxldGVPYmplY3RcIixcclxuICAgICAgICAgICAgXCJzMzpHZXRPYmplY3RcIixcclxuICAgICAgICAgICAgXCJzMzpMaXN0QnVja2V0XCIsXHJcbiAgICAgICAgICAgIFwiczM6UHV0T2JqZWN0XCIsXHJcbiAgICAgICAgICAgIFwiczM6UHV0T2JqZWN0QWNsXCIsXHJcbiAgICAgICAgICAgIFwiczM6R2V0QnVja2V0QWNsXCIsXHJcbiAgICAgICAgICAgIFwiczM6R2V0QnVja2V0TG9jYXRpb25cIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBhdGhlbmFfb3V0cHV0X3MzX2J1Y2tldC5idWNrZXRBcm4sXHJcbiAgICAgICAgICAgIGF0aGVuYV9vdXRwdXRfczNfYnVja2V0LmJ1Y2tldEFybiArIFwiLypcIlxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJBdGhlbmFBbGxvd1wiLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICBcImF0aGVuYTpHZXQqXCIsXHJcbiAgICAgICAgICAgIFwiYXRoZW5hOkxpc3QqXCIsXHJcbiAgICAgICAgICAgIFwiYXRoZW5hOlN0YXJ0UXVlcnlFeGVjdXRpb25cIixcclxuICAgICAgICAgICAgXCJhdGhlbmE6U3RhcnRTZXNzaW9uXCIsXHJcbiAgICAgICAgICAgIFwiYXRoZW5hOlN0b3BRdWVyeUV4ZWN1dGlvblwiLFxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBcImFybjphd3M6YXRoZW5hOlwiICsgdGhpcy5yZWdpb24gKyBcIjpcIiArIHRoaXMuYWNjb3VudCArXCI6ZGF0YWNhdGFsb2cvKlwiLFxyXG4gICAgICAgICAgICBcImFybjphd3M6YXRoZW5hOlwiICsgdGhpcy5yZWdpb24gKyBcIjpcIiArIHRoaXMuYWNjb3VudCArXCI6d29ya2dyb3VwLypcIlxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJHbHVlQWxsb3dcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJnbHVlOkNyZWF0ZURhdGFiYXNlXCIsXHJcbiAgICAgICAgICAgIFwiZ2x1ZTpHZXREYXRhYmFzZVwiLFxyXG4gICAgICAgICAgICBcImdsdWU6R2V0RGF0YWJhc2VzXCIsXHJcbiAgICAgICAgICAgIFwiZ2x1ZTpHZXRUYWJsZVwiLFxyXG4gICAgICAgICAgICBcImdsdWU6R2V0VGFibGVzXCIsXHJcbiAgICAgICAgICAgIFwiZ2x1ZTpHZXRQYXJ0aXRpb25cIixcclxuICAgICAgICAgICAgXCJnbHVlOkdldFBhcnRpdGlvbnNcIixcclxuICAgICAgICAgICAgXCJnbHVlOkJhdGNoR2V0UGFydGl0aW9uXCJcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgIFwiYXJuOmF3czpnbHVlOlwiICsgdGhpcy5yZWdpb24gKyBcIjpcIiArIHRoaXMuYWNjb3VudCArXCI6ZGF0YWJhc2UvKlwiLFxuICAgICAgICAgICAgXCJhcm46YXdzOmdsdWU6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOlwiICsgdGhpcy5hY2NvdW50ICtcIjp0YWJsZS8qXCIsXG4gICAgICAgICAgICBcImFybjphd3M6Z2x1ZTpcIiArIHRoaXMucmVnaW9uICsgXCI6XCIgKyB0aGlzLmFjY291bnQgK1wiOmNhdGFsb2dcIixcbiAgICAgICAgICBdICAgXG4gICAgICAgIH0pLFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiTGFrZUZvcm1hdGlvbkFsbG93XCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwibGFrZWZvcm1hdGlvbjpHZXREYXRhQWNjZXNzXCJcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICAgICAgXCIqXCJcclxuICAgICAgICAgIF0gICBcclxuICAgICAgICB9KSxcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiQ29kZUNvbW1pdEFsbG93XCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpCYXRjaEdldCpcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkRlc2NyaWJlKlwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6R2V0KlwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6TGlzdCpcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkdpdFB1bGxcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkdpdFB1c2hcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkNyZWF0ZUJyYW5jaFwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6RGVsZXRlQnJhbmNoXCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpNZXJnZUJyYW5jaGVzQnkqXCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpVcGRhdGVEZWZhdWx0QnJhbmNoXCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpCYXRjaERlc2NyaWJlTWVyZ2VDb25mbGljdHNcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkNyZWF0ZVVucmVmZXJlbmNlZE1lcmdlQ29tbWl0XCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpDcmVhdGVDb21taXRcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkNyZWF0ZVB1bGxSZXF1ZXN0XCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpDcmVhdGVQdWxsUmVxdWVzdEFwcHJvdmFsUnVsZVwiLFxyXG4gICAgICAgICAgICBcImNvZGVjb21taXQ6RGVsZXRlUHVsbFJlcXVlc3RBcHByb3ZhbFJ1bGVcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OkV2YWx1YXRlUHVsbFJlcXVlc3RBcHByb3ZhbFJ1bGVzXCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpNZXJnZVB1bGxSZXF1ZXN0QnkqXCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpQb3N0Q29tbWVudEZvclB1bGxSZXF1ZXN0XCIsXHJcbiAgICAgICAgICAgIFwiY29kZWNvbW1pdDpVcGRhdGVQdWxsUmVxdWVzdCpcIixcclxuICAgICAgICAgICAgXCJjb2RlY29tbWl0OlB1dEZpbGVcIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBzYWdlbWFrZXJfbm90ZWJvb2tfbWxfaW5zaWdodHNfcmVwb3NpdG9yeS5yZXBvc2l0b3J5QXJuXHJcbiAgICAgICAgICBdICAgXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgc2lkOiBcIlNhZ2VNYWtlck5vdFJlc291cmNlQWxsb3dcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6KlwiXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgbm90UmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIFwiYXJuOmF3czpzYWdlbWFrZXI6KjoqOmRvbWFpbi8qXCIsXHJcbiAgICAgICAgICAgIFwiYXJuOmF3czpzYWdlbWFrZXI6KjoqOnVzZXItcHJvZmlsZS8qXCIsXHJcbiAgICAgICAgICAgIFwiYXJuOmF3czpzYWdlbWFrZXI6KjoqOmFwcC8qXCIsXHJcbiAgICAgICAgICAgIFwiYXJuOmF3czpzYWdlbWFrZXI6KjoqOmZsb3ctZGVmaW5pdGlvbi8qXCJcclxuICAgICAgICAgIF1cclxuICAgICAgICB9KSxcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiU2FnZU1ha2VyRG9tYWluQWxsb3dcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6Q3JlYXRlUHJlc2lnbmVkRG9tYWluVXJsXCIsXHJcbiAgICAgICAgICAgIFwic2FnZW1ha2VyOkRlc2NyaWJlRG9tYWluXCIsXHJcbiAgICAgICAgICAgIFwic2FnZW1ha2VyOkxpc3REb21haW5zXCIsXHJcbiAgICAgICAgICAgIFwic2FnZW1ha2VyOkRlc2NyaWJlVXNlclByb2ZpbGVcIixcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6TGlzdFVzZXJQcm9maWxlc1wiLFxyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjoqQXBwXCIsXHJcbiAgICAgICAgICAgIFwic2FnZW1ha2VyOkxpc3RBcHBzXCJcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICAgICAgXCJhcm46YXdzOnNhZ2VtYWtlcjoqOio6ZG9tYWluLypcIixcclxuICAgICAgICAgICAgXCJhcm46YXdzOnNhZ2VtYWtlcjoqOio6dXNlci1wcm9maWxlLypcIixcclxuICAgICAgICAgICAgXCJhcm46YXdzOnNhZ2VtYWtlcjoqOio6YXBwLypcIixcclxuICAgICAgICAgICAgXCJhcm46YXdzOnNhZ2VtYWtlcjoqOio6Zmxvdy1kZWZpbml0aW9uLypcIlxyXG4gICAgICAgICAgXVxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJTYWdlTWFrZXJXb3Jrc3RyZWFtXCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwiaWFtOlBhc3NSb2xlXCJcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICAgICAgXCJhcm46YXdzOnNhZ2VtYWtlcjpcIiArIHRoaXMucmVnaW9uICsgXCI6XCIgKyB0aGlzLmFjY291bnQgK1wiOmZsb3ctZGVmaW5pdGlvbi8qXCIsXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgY29uZGl0aW9uczoge1xyXG4gICAgICAgICAgICBTdHJpbmdFcXVhbHNJZkV4aXN0czp7XHJcbiAgICAgICAgICAgICAgXCJzYWdlbWFrZXI6V29ya3RlYW1UeXBlXCI6IFtcclxuICAgICAgICAgICAgICAgIFwicHJpdmF0ZS1jcm93ZFwiLFxyXG4gICAgICAgICAgICAgICAgXCJ2ZW5kb3ItY3Jvd2RcIlxyXG4gICAgICAgICAgICAgIF1cclxuICAgICAgICAgICAgfX0gXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgc2lkOiBcIklBTVBhc3NSb2xlU2VydmljZVwiLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICBcImlhbTpQYXNzUm9sZVwiXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIHNhZ2VtYWtlcl91c2VyX3Byb2ZpbGVfcm9sZS5yb2xlQXJuXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgY29uZGl0aW9uczoge1xyXG4gICAgICAgICAgICBTdHJpbmdMaWtlOntcclxuICAgICAgICAgICAgICBcImlhbTpQYXNzZWRUb1NlcnZpY2VcIjogW1xyXG4gICAgICAgICAgICAgICAgXCJnbHVlLmFtYXpvbmF3cy5jb21cIixcclxuICAgICAgICAgICAgICAgIFwicm9ib21ha2VyLmFtYXpvbmF3cy5jb21cIixcclxuICAgICAgICAgICAgICAgIFwic3RhdGVzLmFtYXpvbmF3cy5jb21cIixcclxuICAgICAgICAgICAgICAgIFwic2FnZW1ha2VyLmFtYXpvbmF3cy5jb21cIlxyXG4gICAgICAgICAgICAgIF1cclxuICAgICAgICAgICAgfX0gXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgc2lkOiBcIktNU0VuY3J5cHRcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJrbXM6Q3JlYXRlR3JhbnRcIixcclxuICAgICAgICAgICAgXCJrbXM6RGVzY3JpYmVLZXlcIixcclxuICAgICAgICAgICAgXCJrbXM6RGVjcnlwdFwiLFxyXG4gICAgICAgICAgICBcImttczpFbmNyeXB0XCIsXHJcbiAgICAgICAgICAgIFwia21zOkdlbmVyYXRlRGF0YUtleVwiLFxyXG4gICAgICAgICAgICBcImttczpSZUVuY3J5cHQqXCJcclxuICAgICAgICAgIF0sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICAgICAgc2FnZW1ha2VyX2ttc19rZXkua2V5QXJuLFxyXG4gICAgICAgICAgICBhdGhlbmFfczNfb3V0cHV0X2ttc19rZXkua2V5QXJuXHJcbiAgICAgICAgICBdICAgXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgc2lkOiBcIlNhZ2VNYWtlclBlcm1pc3Npb25zXCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwic2FnZW1ha2VyOkNyZWF0ZUFwcFwiXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIFwiYXJuOmF3czpzYWdlbWFrZXI6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOlwiICsgdGhpcy5hY2NvdW50ICtcIjphcHAvKlwiLFxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pLFxyXG4gICAgICBdLFxyXG4gICAgfSk7XHJcblxyXG4gICAgYXRoZW5hX291dHB1dF9zM19idWNrZXQuYWRkVG9SZXNvdXJjZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAnczM6UHV0T2JqZWN0JyxcclxuICAgICAgICAnczM6UHV0T2JqZWN0QWNsJyxcclxuICAgICAgICAnczM6RGVsZXRlT2JqZWN0JyxcclxuICAgICAgICAnczM6R2V0QnVja2V0TG9jYXRpb24nXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgIGF0aGVuYV9vdXRwdXRfczNfYnVja2V0LmJ1Y2tldEFybixcclxuICAgICAgICBhdGhlbmFfb3V0cHV0X3MzX2J1Y2tldC5idWNrZXRBcm4gKyAnLyonXHJcbiAgICAgIF0sXHJcbiAgICAgIHByaW5jaXBhbHM6IFtcclxuICAgICAgICBuZXcgaWFtLkFyblByaW5jaXBhbChzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZUFybildLFxyXG4gICAgfSkpO1xyXG5cclxuICAgIG5ldyBpYW0uTWFuYWdlZFBvbGljeSh0aGlzLCBcIlNhZ2VNYWtlclN0dWRpb1VzZXJQcm9maWxlTWFuYWdlZFBvbGljeVwiLCB7XG4gICAgICBkZXNjcmlwdGlvbjogXCJNYW5hZ2VkIHBvbGljeSBhc3NvY2lhdGVkIHRvIHRoZSBTYWdlTWFrZXIgU3R1ZGlvcyB1c2VyIHByb2ZpbGUuXCIsXG4gICAgICBkb2N1bWVudDpzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3BvbGljeSxcbiAgICAgIG1hbmFnZWRQb2xpY3lOYW1lOiBcInNhZ2VtYWtlci1zdHVkaW8tdXNlci1zZWN1cml0eS1sYWtlLXBvbGljeVwiLFxuICAgICAgcm9sZXM6IFtzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGVdXG4gICAgfSk7XG5cbiAgICBpZiAoY3JlYXRlX2xha2VfZm9ybWF0aW9uX3Blcm1pc3Npb25zKSB7XG4gICAgICBuZXcgQ2ZuUHJpbmNpcGFsUGVybWlzc2lvbnModGhpcywgXCJTYWdlTWFrZXJTZWN1cml0eUxha2VEYXRhYmFzZVBlcm1pc3Npb25zXCIsIHtcbiAgICAgICAgcHJpbmNpcGFsOiB7XG4gICAgICAgICAgZGF0YUxha2VQcmluY2lwYWxJZGVudGlmaWVyOiBzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZUFybixcbiAgICAgICAgfSxcbiAgICAgICAgcmVzb3VyY2U6IHtcbiAgICAgICAgICBkYXRhYmFzZToge1xuICAgICAgICAgICAgY2F0YWxvZ0lkOiB0aGlzLmFjY291bnQsXG4gICAgICAgICAgICBuYW1lOiBzZWN1cml0eV9sYWtlX2RhdGFiYXNlX25hbWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcGVybWlzc2lvbnM6IFtcIkRFU0NSSUJFXCJdLFxuICAgICAgICBwZXJtaXNzaW9uc1dpdGhHcmFudE9wdGlvbjogW10sXG4gICAgICB9KTtcblxuICAgICAgbmV3IENmblByaW5jaXBhbFBlcm1pc3Npb25zKHRoaXMsIFwiU2FnZU1ha2VyU2VjdXJpdHlMYWtlVGFibGVQZXJtaXNzaW9uc1wiLCB7XG4gICAgICAgIHByaW5jaXBhbDoge1xuICAgICAgICAgIGRhdGFMYWtlUHJpbmNpcGFsSWRlbnRpZmllcjogc2FnZW1ha2VyX3VzZXJfcHJvZmlsZV9yb2xlLnJvbGVBcm4sXG4gICAgICAgIH0sXG4gICAgICAgIHJlc291cmNlOiB7XG4gICAgICAgICAgdGFibGU6IHtcbiAgICAgICAgICAgIGNhdGFsb2dJZDogdGhpcy5hY2NvdW50LFxuICAgICAgICAgICAgZGF0YWJhc2VOYW1lOiBzZWN1cml0eV9sYWtlX2RhdGFiYXNlX25hbWUsXG4gICAgICAgICAgICBuYW1lOiBzZWN1cml0eV9sYWtlX3RhYmxlX25hbWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcGVybWlzc2lvbnM6IFtcIkRFU0NSSUJFXCIsIFwiU0VMRUNUXCJdLFxuICAgICAgICBwZXJtaXNzaW9uc1dpdGhHcmFudE9wdGlvbjogW10sXG4gICAgICB9KTtcbiAgICB9XG5cclxuICAgIGNvbnN0IHNhZ2VtYWtlcl9kb21haW4gPSBuZXcgQ2ZuRG9tYWluKHRoaXMsIFwic2FnZW1ha2VyX2RvbWFpblwiLCB7XHJcbiAgICAgIGF1dGhNb2RlOiBcIklBTVwiLFxyXG4gICAgICBkZWZhdWx0VXNlclNldHRpbmdzOiB7XHJcbiAgICAgICAgZXhlY3V0aW9uUm9sZTogc2FnZW1ha2VyX3VzZXJfcHJvZmlsZV9yb2xlLnJvbGVBcm4sXHJcbiAgICAgICAganVweXRlclNlcnZlckFwcFNldHRpbmdzOiB7XHJcbiAgICAgICAgICBkZWZhdWx0UmVzb3VyY2VTcGVjOiB7XHJcbiAgICAgICAgICAgIGluc3RhbmNlVHlwZTogXCJzeXN0ZW1cIixcclxuICAgICAgICAgICAgLy8gbGlmZWN5Y2xlQ29uZmlnQXJuOiBcImxpZmVjeWNsZUNvbmZpZ0FyblwiLFxyXG4gICAgICAgICAgICAvLyBzYWdlTWFrZXJJbWFnZUFybjogXCJzYWdlTWFrZXJJbWFnZUFyblwiLFxyXG4gICAgICAgICAgICAvLyBzYWdlTWFrZXJJbWFnZVZlcnNpb25Bcm46IFwic2FnZU1ha2VySW1hZ2VWZXJzaW9uQXJuXCIsXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAga2VybmVsR2F0ZXdheUFwcFNldHRpbmdzOiB7XHJcbiAgICAgICAgICAvLyBjdXN0b21JbWFnZXM6IFt7XHJcbiAgICAgICAgICAvLyAgIGFwcEltYWdlQ29uZmlnTmFtZTogXCJhcHBJbWFnZUNvbmZpZ05hbWVcIixcclxuICAgICAgICAgIC8vICAgaW1hZ2VOYW1lOiBcImltYWdlTmFtZVwiLFxyXG4gICAgXHJcbiAgICAgICAgICAvLyAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICAgICAgLy8gICBpbWFnZVZlcnNpb25OdW1iZXI6IDEyMyxcclxuICAgICAgICAgIC8vIH1dLFxyXG4gICAgICAgICAgZGVmYXVsdFJlc291cmNlU3BlYzoge1xyXG4gICAgICAgICAgICBpbnN0YW5jZVR5cGU6IFwibWwudDMubWVkaXVtXCIsXHJcbiAgICAgICAgICAgIC8vIGxpZmVjeWNsZUNvbmZpZ0FybjogXCJsaWZlY3ljbGVDb25maWdBcm5cIixcclxuICAgICAgICAgICAgc2FnZU1ha2VySW1hZ2VBcm46IFwiYXJuOmF3czpzYWdlbWFrZXI6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOjA4MTMyNTM5MDE5OTppbWFnZS9kYXRhc2NpZW5jZS0xLjBcIixcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICAvLyByU2Vzc2lvbkFwcFNldHRpbmdzOiB7XHJcbiAgICAgICAgLy8gICBjdXN0b21JbWFnZXM6IFt7XHJcbiAgICAgICAgLy8gICAgIGFwcEltYWdlQ29uZmlnTmFtZTogXCJhcHBJbWFnZUNvbmZpZ05hbWVcIixcclxuICAgICAgICAvLyAgICAgaW1hZ2VOYW1lOiBcImltYWdlTmFtZVwiLFxyXG4gICAgXHJcbiAgICAgICAgLy8gICAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICAgIC8vICAgICBpbWFnZVZlcnNpb25OdW1iZXI6IDEyMyxcclxuICAgICAgICAvLyAgIH1dLFxyXG4gICAgICAgIC8vICAgZGVmYXVsdFJlc291cmNlU3BlYzoge1xyXG4gICAgICAgIC8vICAgICBpbnN0YW5jZVR5cGU6IFwiaW5zdGFuY2VUeXBlXCIsXHJcbiAgICAgICAgLy8gICAgIGxpZmVjeWNsZUNvbmZpZ0FybjogXCJsaWZlY3ljbGVDb25maWdBcm5cIixcclxuICAgICAgICAvLyAgICAgc2FnZU1ha2VySW1hZ2VBcm46IFwic2FnZU1ha2VySW1hZ2VBcm5cIixcclxuICAgICAgICAvLyAgICAgc2FnZU1ha2VySW1hZ2VWZXJzaW9uQXJuOiBcInNhZ2VNYWtlckltYWdlVmVyc2lvbkFyblwiLFxyXG4gICAgICAgIC8vICAgfSxcclxuICAgICAgICAvLyB9LFxyXG4gICAgICAgIC8vIHJTdHVkaW9TZXJ2ZXJQcm9BcHBTZXR0aW5nczoge1xyXG4gICAgICAgIC8vICAgYWNjZXNzU3RhdHVzOiBcImFjY2Vzc1N0YXR1c1wiLFxyXG4gICAgICAgIC8vICAgdXNlckdyb3VwOiBcInVzZXJHcm91cFwiLFxyXG4gICAgICAgIC8vIH0sXHJcbiAgICAgICAgc2VjdXJpdHlHcm91cHM6IFtzYWdlbWFrZXJfd29ya2xvYWRfc2cuc2VjdXJpdHlHcm91cElkXSxcclxuICAgICAgICAvLyBzaGFyaW5nU2V0dGluZ3M6IHtcclxuICAgICAgICAvLyAgIG5vdGVib29rT3V0cHV0T3B0aW9uOiBcIm5vdGVib29rT3V0cHV0T3B0aW9uXCIsXHJcbiAgICAgICAgLy8gICBzM0ttc0tleUlkOiBcInMzS21zS2V5SWRcIixcclxuICAgICAgICAvLyAgIHMzT3V0cHV0UGF0aDogXCJzM091dHB1dFBhdGhcIixcclxuICAgICAgICAvLyB9LFxyXG4gICAgICB9LFxyXG4gICAgICBkb21haW5OYW1lOiBcInNlY3VyaXR5LWxha2UtbWwtaW5zaWdodHMtXCIgKyB0aGlzLmFjY291bnQsXHJcbiAgICAgIHN1Ym5ldElkczogW3NhZ2VtYWtlcl92cGMuc2VsZWN0U3VibmV0cyh7c3VibmV0R3JvdXBOYW1lOiBcIndvcmtsb2FkX3N1Ym5ldF93aXRoX25hdFwifSkuc3VibmV0c1swXS5zdWJuZXRJZF0sXHJcbiAgICAgIHZwY0lkOiBzYWdlbWFrZXJfdnBjLnZwY0lkLFxyXG4gICAgICAvLyB0aGUgcHJvcGVydGllcyBiZWxvdyBhcmUgb3B0aW9uYWxcclxuICAgICAgYXBwTmV0d29ya0FjY2Vzc1R5cGU6IFwiVnBjT25seVwiLFxyXG4gICAgICAvLyBhcHBTZWN1cml0eUdyb3VwTWFuYWdlbWVudDogXCJhcHBTZWN1cml0eUdyb3VwTWFuYWdlbWVudFwiLFxyXG4gICAgICAvLyBkb21haW5TZXR0aW5nczoge1xyXG4gICAgICAvLyAgIHJTdHVkaW9TZXJ2ZXJQcm9Eb21haW5TZXR0aW5nczoge1xyXG4gICAgICAvLyAgICAgZG9tYWluRXhlY3V0aW9uUm9sZUFybjogXCJkb21haW5FeGVjdXRpb25Sb2xlQXJuXCIsXHJcbiAgICBcclxuICAgICAgLy8gICAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICAvLyAgICAgZGVmYXVsdFJlc291cmNlU3BlYzoge1xyXG4gICAgICAvLyAgICAgICBpbnN0YW5jZVR5cGU6IFwiaW5zdGFuY2VUeXBlXCIsXHJcbiAgICAgIC8vICAgICAgIGxpZmVjeWNsZUNvbmZpZ0FybjogXCJsaWZlY3ljbGVDb25maWdBcm5cIixcclxuICAgICAgLy8gICAgICAgc2FnZU1ha2VySW1hZ2VBcm46IFwic2FnZU1ha2VySW1hZ2VBcm5cIixcclxuICAgICAgLy8gICAgICAgc2FnZU1ha2VySW1hZ2VWZXJzaW9uQXJuOiBcInNhZ2VNYWtlckltYWdlVmVyc2lvbkFyblwiLFxyXG4gICAgICAvLyAgICAgfSxcclxuICAgICAgLy8gICAgIHJTdHVkaW9Db25uZWN0VXJsOiBcInJTdHVkaW9Db25uZWN0VXJsXCIsXHJcbiAgICAgIC8vICAgICByU3R1ZGlvUGFja2FnZU1hbmFnZXJVcmw6IFwiclN0dWRpb1BhY2thZ2VNYW5hZ2VyVXJsXCIsXHJcbiAgICAgIC8vICAgfSxcclxuICAgICAgLy8gICBzZWN1cml0eUdyb3VwSWRzOiBbXCJzZWN1cml0eUdyb3VwSWRzXCJdLFxyXG4gICAgICAvLyB9LFxyXG4gICAgICBrbXNLZXlJZDogc2FnZW1ha2VyX2ttc19rZXkua2V5SWQsXHJcbiAgICAgIHRhZ3M6IFt7XHJcbiAgICAgICAga2V5OiBcInByb2plY3RcIixcclxuICAgICAgICB2YWx1ZTogXCJzZWN1cml0eS1sYWtlLW1sLWluc2lnaHRzXCIsXHJcbiAgICAgIH1dLFxyXG4gICAgfSk7XHJcblxyXG4gICAgc2FnZW1ha2VyX2RvbWFpbi5hcHBseVJlbW92YWxQb2xpY3koUmVtb3ZhbFBvbGljeS5ERVNUUk9ZKVxyXG5cclxuICAgIGNvbnN0IHNhZ2VtYWtlcl91c2VyX3Byb2ZpbGUgPSBuZXcgQ2ZuVXNlclByb2ZpbGUodGhpcywgJ3NhZ2VtYWtlcl91c2VyX3Byb2ZpbGUnLCB7XHJcbiAgICAgIGRvbWFpbklkOiBzYWdlbWFrZXJfZG9tYWluLmF0dHJEb21haW5JZCxcclxuICAgICAgdXNlclByb2ZpbGVOYW1lOiBzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZU5hbWUsXHJcbiAgICBcclxuICAgICAgLy8gdGhlIHByb3BlcnRpZXMgYmVsb3cgYXJlIG9wdGlvbmFsXHJcbiAgICAgIC8vIHNpbmdsZVNpZ25PblVzZXJJZGVudGlmaWVyOiAnc2luZ2xlU2lnbk9uVXNlcklkZW50aWZpZXInLFxyXG4gICAgICAvLyBzaW5nbGVTaWduT25Vc2VyVmFsdWU6ICdzaW5nbGVTaWduT25Vc2VyVmFsdWUnLFxyXG4gICAgICB0YWdzOiBbe1xyXG4gICAgICAgIGtleTogJ3Byb2plY3QnLFxyXG4gICAgICAgIHZhbHVlOiAnc2VjdXJpdHktbGFrZS1tbC1pbnNpZ2h0cycsXHJcbiAgICAgIH1dLFxyXG4gICAgICB1c2VyU2V0dGluZ3M6IHtcclxuICAgICAgICBleGVjdXRpb25Sb2xlOiBzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZUFybixcclxuICAgICAgICAvLyBqdXB5dGVyU2VydmVyQXBwU2V0dGluZ3M6IHtcclxuICAgICAgICAvLyAgIGRlZmF1bHRSZXNvdXJjZVNwZWM6IHtcclxuICAgICAgICAvLyAgICAgaW5zdGFuY2VUeXBlOiAnaW5zdGFuY2VUeXBlJyxcclxuICAgICAgICAvLyAgICAgc2FnZU1ha2VySW1hZ2VBcm46ICdzYWdlTWFrZXJJbWFnZUFybicsXHJcbiAgICAgICAgLy8gICAgIHNhZ2VNYWtlckltYWdlVmVyc2lvbkFybjogJ3NhZ2VNYWtlckltYWdlVmVyc2lvbkFybicsXHJcbiAgICAgICAgLy8gICB9LFxyXG4gICAgICAgIC8vIH0sXHJcbiAgICAgICAgLy8ga2VybmVsR2F0ZXdheUFwcFNldHRpbmdzOiB7XHJcbiAgICAgICAgLy8gICBjdXN0b21JbWFnZXM6IFt7XHJcbiAgICAgICAgLy8gICAgIGFwcEltYWdlQ29uZmlnTmFtZTogJ2FwcEltYWdlQ29uZmlnTmFtZScsXHJcbiAgICAgICAgLy8gICAgIGltYWdlTmFtZTogJ2ltYWdlTmFtZScsXHJcbiAgICBcclxuICAgICAgICAvLyAgICAgLy8gdGhlIHByb3BlcnRpZXMgYmVsb3cgYXJlIG9wdGlvbmFsXHJcbiAgICAgICAgLy8gICAgIGltYWdlVmVyc2lvbk51bWJlcjogMTIzLFxyXG4gICAgICAgIC8vICAgfV0sXHJcbiAgICAgICAgLy8gICBkZWZhdWx0UmVzb3VyY2VTcGVjOiB7XHJcbiAgICAgICAgLy8gICAgIGluc3RhbmNlVHlwZTogJ2luc3RhbmNlVHlwZScsXHJcbiAgICAgICAgLy8gICAgIHNhZ2VNYWtlckltYWdlQXJuOiAnc2FnZU1ha2VySW1hZ2VBcm4nLFxyXG4gICAgICAgIC8vICAgICBzYWdlTWFrZXJJbWFnZVZlcnNpb25Bcm46ICdzYWdlTWFrZXJJbWFnZVZlcnNpb25Bcm4nLFxyXG4gICAgICAgIC8vICAgfSxcclxuICAgICAgICAvLyB9LFxyXG4gICAgICAgIC8vIHJTdHVkaW9TZXJ2ZXJQcm9BcHBTZXR0aW5nczoge1xyXG4gICAgICAgIC8vICAgYWNjZXNzU3RhdHVzOiAnYWNjZXNzU3RhdHVzJyxcclxuICAgICAgICAvLyAgIHVzZXJHcm91cDogJ3VzZXJHcm91cCcsXHJcbiAgICAgICAgLy8gfSxcclxuICAgICAgICAvL3NlY3VyaXR5R3JvdXBzOiBbJ3NlY3VyaXR5R3JvdXBzJ10sXHJcbiAgICAgICAgLy8gc2hhcmluZ1NldHRpbmdzOiB7XHJcbiAgICAgICAgLy8gICBub3RlYm9va091dHB1dE9wdGlvbjogJ25vdGVib29rT3V0cHV0T3B0aW9uJyxcclxuICAgICAgICAvLyAgIHMzS21zS2V5SWQ6ICdzM0ttc0tleUlkJyxcclxuICAgICAgICAvLyAgIHMzT3V0cHV0UGF0aDogJ3MzT3V0cHV0UGF0aCcsXHJcbiAgICAgICAgLy8gfSxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIHNhZ2VtYWtlcl91c2VyX3Byb2ZpbGUuYWRkRGVwZW5kZW5jeShzYWdlbWFrZXJfZG9tYWluKVxyXG4gICAgc2FnZW1ha2VyX3VzZXJfcHJvZmlsZS5hcHBseVJlbW92YWxQb2xpY3koUmVtb3ZhbFBvbGljeS5ERVNUUk9ZKVxyXG5cclxuICAgIGNvbnN0IHNhZ2VtYWtlcl9hcHAgPSBuZXcgQ2ZuQXBwKHRoaXMsICdzYWdlbWFrZXJfYXBwJywge1xyXG4gICAgICBhcHBOYW1lOiAnZGVmYXVsdCcsXHJcbiAgICAgIGFwcFR5cGU6ICdKdXB5dGVyU2VydmVyJyxcclxuICAgICAgZG9tYWluSWQ6IHNhZ2VtYWtlcl9kb21haW4uYXR0ckRvbWFpbklkLFxyXG4gICAgICB1c2VyUHJvZmlsZU5hbWU6IHNhZ2VtYWtlcl91c2VyX3Byb2ZpbGUudXNlclByb2ZpbGVOYW1lLFxyXG4gICAgXHJcbiAgICAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICByZXNvdXJjZVNwZWM6IHtcclxuICAgICAgICBpbnN0YW5jZVR5cGU6ICdzeXN0ZW0nXHJcbiAgICAgIH0sXHJcbiAgICAgIHRhZ3M6IFt7XHJcbiAgICAgICAga2V5OiAncHJvamVjdCcsXHJcbiAgICAgICAgdmFsdWU6ICdzZWN1cml0eS1sYWtlLW1sLWluc2lnaHRzJyxcclxuICAgICAgfV0sXHJcbiAgICB9KTtcclxuXHJcbiAgICBzYWdlbWFrZXJfYXBwLmFkZERlcGVuZGVuY3koc2FnZW1ha2VyX3VzZXJfcHJvZmlsZSlcclxuICAgIHNhZ2VtYWtlcl9hcHAuYXBwbHlSZW1vdmFsUG9saWN5KFJlbW92YWxQb2xpY3kuREVTVFJPWSlcclxuICAgIFxyXG4gICAgLy8gSUFNIFJvbGUgZm9yIFNhZ2VNYWtlciB1c2VyIHByb2ZpbGVzXG4gICAgY29uc3Qgc2FnZW1ha2VyX2NvbnNvbGVfcHJlc2lnbmVkX3VybF9yb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwic2FnZW1ha2VyX2NvbnNvbGVfcHJlc2lnbmVkX3VybF9yb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5Db21wb3NpdGVQcmluY2lwYWwoXG4gICAgICAgIG5ldyBpYW0uQXJuUHJpbmNpcGFsKHNhZ2VtYWtlcl9wcmVzaWduZWRfdXJsX3RydXN0ZWRfcHJpbmNpcGFsX2FybiksXG4gICAgICApLFxuICAgICAgcm9sZU5hbWU6IFwic2FnZW1ha2VyLWNvbnNvbGUtcHJlc2lnbmVkLXVybC1yb2xlXCIsXG4gICAgICAvLyBtYW5hZ2VkUG9saWNpZXM6IFtcclxuICAgICAgLy8gXVxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3Qgc2FnZW1ha2VyX3ByZXNpZ25lZF91cmxfcG9saWN5ID0gbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XHJcbiAgICAgIHN0YXRlbWVudHM6IFtcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBzaWQ6IFwiU01TdHVkaW9DcmVhdGVQcmVzaWduZWRVUkxBbGxvd1wiLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpDcmVhdGVQcmVzaWduZWREb21haW5VcmxcIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBzYWdlbWFrZXJfdXNlcl9wcm9maWxlLmF0dHJVc2VyUHJvZmlsZUFyblxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIGNvbmRpdGlvbnM6IHtcclxuICAgICAgICAgICAgSXBBZGRyZXNzOntcbiAgICAgICAgICAgICAgXCJhd3M6U291cmNlSXBcIjogW1xuICAgICAgICAgICAgICAgIHNhZ2VtYWtlcl9yZXN0cmljdF9jaWRyX3ByZXNpZ25lZF91cmxcbiAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgfX0gICBcbiAgICAgICAgfSksXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJTTVN0dWRpb0NvbnNvbGVSZWFkQWxsb3dcIixcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6RGVzY3JpYmVEb21haW5cIixcclxuICAgICAgICAgICAgXCJzYWdlbWFrZXI6RGVzY3JpYmVVc2VyUHJvZmlsZVwiLFxyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpMaXN0QXBwc1wiLFxyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpMaXN0RG9tYWluc1wiLFxyXG4gICAgICAgICAgICBcInNhZ2VtYWtlcjpMaXN0VXNlclByb2ZpbGVzXCIsXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgIFwiYXJuOlwiICsgdGhpcy5wYXJ0aXRpb24gKyBcIjpzYWdlbWFrZXI6XCIgKyB0aGlzLnJlZ2lvbiArIFwiOlwiICsgdGhpcy5hY2NvdW50ICsgXCI6ZG9tYWluLypcIixcclxuICAgICAgICAgICAgXCJhcm46XCIgKyB0aGlzLnBhcnRpdGlvbiArIFwiOnNhZ2VtYWtlcjpcIiArIHRoaXMucmVnaW9uICsgXCI6XCIgKyB0aGlzLmFjY291bnQgKyBcIjp1c2VyLXByb2ZpbGUvXCIgKyBzYWdlbWFrZXJfZG9tYWluLmF0dHJEb21haW5JZCArIFwiLypcIixcclxuICAgICAgICAgICAgXCJhcm46XCIgKyB0aGlzLnBhcnRpdGlvbiArIFwiOnNhZ2VtYWtlcjpcIiArIHRoaXMucmVnaW9uICsgXCI6XCIgKyB0aGlzLmFjY291bnQgKyBcIjphcHAvXCIgKyBzYWdlbWFrZXJfZG9tYWluLmF0dHJEb21haW5JZCArIFwiLypcIlxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIHNpZDogXCJTTVN0dWRpb1NlcnZpY2VDYXRhbG9nUmVhZEFsbG93XCIsXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgIFwibGljZW5zZS1tYW5hZ2VyOkxpc3RSZWNlaXZlZExpY2Vuc2VzXCIsXHJcbiAgICAgICAgICAgIFwic2FnZW1ha2VyOkdldFNhZ2VtYWtlclNlcnZpY2VjYXRhbG9nUG9ydGZvbGlvU3RhdHVzXCIsXHJcbiAgICAgICAgICAgIFwic2VydmljZWNhdGFsb2c6TGlzdEFjY2VwdGVkUG9ydGZvbGlvU2hhcmVzXCIsXHJcbiAgICAgICAgICAgIFwic2VydmljZWNhdGFsb2c6TGlzdFByaW5jaXBhbHNGb3JQb3J0Zm9saW9cIlxyXG4gICAgICAgICAgXSxcclxuICAgICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgICBcIipcIlxyXG4gICAgICAgICAgXSAgIFxyXG4gICAgICAgIH0pXHJcbiAgICAgIF0sXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgaWFtLk1hbmFnZWRQb2xpY3kodGhpcywgXCJTYWdlTWFrZXJTdHVkaW9Db25zb2xlTWFuYWdlZFBvbGljeVwiLCB7XHJcbiAgICAgIGRlc2NyaXB0aW9uOiBcIk1hbmFnZWQgcG9saWN5IGFzc29jaWF0ZWQgdG8gdGhlIEFXUyBjb25zb2xlIHJvbGUgdG8gYWNjZXNzIFNhZ2VNYWtlciBTdHVkaW8gRG9tYWluIHByZXNpZ25lZCBVUkwuXCIsXHJcbiAgICAgIGRvY3VtZW50OnNhZ2VtYWtlcl9wcmVzaWduZWRfdXJsX3BvbGljeSxcclxuICAgICAgbWFuYWdlZFBvbGljeU5hbWU6IFwic2FnZW1ha2VyLXN0dWRpby1jb25zb2xlLWFjY2Vzcy1wb2xpY3lcIixcclxuICAgICAgcm9sZXM6IFtzYWdlbWFrZXJfY29uc29sZV9wcmVzaWduZWRfdXJsX3JvbGVdXHJcbiAgICB9KTtcclxuXHJcbiAgICBhdGhlbmFfczNfb3V0cHV0X2ttc19rZXkuYWRkVG9SZXNvdXJjZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAna21zOkRlc2NyaWJlS2V5JyxcclxuICAgICAgICAna21zOkVuY3J5cHQnLFxyXG4gICAgICAgICdrbXM6R2VuZXJhdGVEYXRhS2V5KidcclxuICAgICAgXSxcclxuICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgJyonXHJcbiAgICAgIF0sXHJcbiAgICAgIHByaW5jaXBhbHM6IFtcclxuICAgICAgICBuZXcgaWFtLkFyblByaW5jaXBhbChzYWdlbWFrZXJfdXNlcl9wcm9maWxlX3JvbGUucm9sZUFybildXHJcbiAgICB9KSk7XHJcblxyXG4gICAgY29uc3QgbWxfaW5zaWdodHNfd29ya2dyb3VwID0gbmV3IGF0aGVuYS5DZm5Xb3JrR3JvdXAodGhpcywgJ21sX2luc2lnaHRzX3dvcmtncm91cCcsIHtcbiAgICAgIG5hbWU6IGF0aGVuYV93b3JrZ3JvdXBfbmFtZSxcbiAgICAgIC8vIHRoZSBwcm9wZXJ0aWVzIGJlbG93IGFyZSBvcHRpb25hbFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ1dvcmtncm91cCBmb3IgU2VjdXJpdHkgTGFrZSBNTCBJbnNpZ2h0cy4nLFxyXG4gICAgICByZWN1cnNpdmVEZWxldGVPcHRpb246IHRydWUsXHJcbiAgICAgIHN0YXRlOiAnRU5BQkxFRCcsXHJcbiAgICAgIC8vIHRhZ3M6IFt7XHJcbiAgICAgIC8vICAga2V5OiAna2V5JyxcclxuICAgICAgLy8gICB2YWx1ZTogJ3ZhbHVlJyxcclxuICAgICAgLy8gfV0sXHJcbiAgICAgIHdvcmtHcm91cENvbmZpZ3VyYXRpb246IHtcclxuICAgICAgICAvLyBieXRlc1NjYW5uZWRDdXRvZmZQZXJRdWVyeTogMTAwMDAwMDAsXHJcbiAgICAgICAgZW5mb3JjZVdvcmtHcm91cENvbmZpZ3VyYXRpb246IHRydWUsXHJcbiAgICAgICAgLy8gZW5naW5lVmVyc2lvbjoge1xyXG4gICAgICAgIC8vICAgZWZmZWN0aXZlRW5naW5lVmVyc2lvbjogJ2VmZmVjdGl2ZUVuZ2luZVZlcnNpb24nLFxyXG4gICAgICAgIC8vICAgc2VsZWN0ZWRFbmdpbmVWZXJzaW9uOiAnc2VsZWN0ZWRFbmdpbmVWZXJzaW9uJyxcclxuICAgICAgICAvLyB9LFxyXG4gICAgICAgIHB1Ymxpc2hDbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IGZhbHNlLFxyXG4gICAgICAgIHJlcXVlc3RlclBheXNFbmFibGVkOiBmYWxzZSxcclxuICAgICAgICByZXN1bHRDb25maWd1cmF0aW9uOiB7XHJcbiAgICAgICAgICBlbmNyeXB0aW9uQ29uZmlndXJhdGlvbjoge1xyXG4gICAgICAgICAgICBlbmNyeXB0aW9uT3B0aW9uOiBFbmNyeXB0aW9uT3B0aW9uLktNUyxcclxuICAgICAgICAgICAga21zS2V5OiBhdGhlbmFfczNfb3V0cHV0X2ttc19rZXkua2V5QXJuLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIG91dHB1dExvY2F0aW9uOiAnczM6Ly8nICsgYXRoZW5hX291dHB1dF9zM19idWNrZXQuYnVja2V0TmFtZSArICcvJyxcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcblxyXG4gIFxyXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zQnlQYXRoKHRoaXMsJy9TYWdlTWFrZXJEb21haW5TdGFjay9TYWdlTWFrZXJTdHVkaW9Db25zb2xlTWFuYWdlZFBvbGljeS9SZXNvdXJjZScsXHJcbiAgICAgIFtcclxuICAgICAgICB7XHJcbiAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcclxuICAgICAgICAgIHJlYXNvbjogJ1RoZSBzcGVjaWZpYyBhY3Rpb25zIGluIHRoZSBTTVN0dWRpb1NlcnZpY2VDYXRhbG9nUmVhZEFsbG93IFNJRCByZXF1aXJlICogcmVzb3VyY2UuIFRoZSBhY3Rpb25zIGFyZSBhbGwgcmVhZC1vbmx5LicsXHJcbiAgICAgICAgfSxcclxuICAgICAgXVxyXG4gICAgKTtcclxuXHJcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnNCeVBhdGgodGhpcywnL1NhZ2VNYWtlckRvbWFpblN0YWNrL1NhZ2VNYWtlclN0dWRpb1VzZXJQcm9maWxlTWFuYWdlZFBvbGljeS9SZXNvdXJjZScsXHJcbiAgICAgIFtcclxuICAgICAgICB7XHJcbiAgICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcclxuICAgICAgICAgIHJlYXNvbjogJ1RoZSBzcGVjaWZpYyBhY3Rpb25zIGluIHRoZSBTM1JlYWQgYW5kIExha2VGb3JtYXRpb25BbGxvdyBTSUQgcmVxdWlyZSAqIHJlc291cmNlLiBUaGUgYWN0aW9ucyBhcmUgYWxsIHJlYWQtb25seS4nLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIF1cclxuICAgICk7XHJcblxyXG4gIH1cclxufVxyXG4iXX0=