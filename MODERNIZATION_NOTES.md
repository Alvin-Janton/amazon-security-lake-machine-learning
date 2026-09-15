# Modernization Notes

This file summarizes the changes made in this fork of the AWS sample `amazon-security-lake-machine-learning`.

The original project was designed around a multi-account architecture with a Security Lake account and a separate ML Insights subscriber account. This fork modernizes the project for a single-account lab or personal AWS environment.

## Architecture Changes

### Original Architecture

The original sample expected:

- A dedicated Amazon Security Lake account.
- A separate SageMaker/ML Insights subscriber account.
- Resource Access Manager sharing from the Security Lake account.
- Lake Formation resource links in the subscriber account.
- Manual Lake Formation grants after deployment.

### Modernized Architecture

This fork expects:

- Amazon Security Lake in the same account as SageMaker.
- Security Hub findings already configured as a Security Lake source.
- Existing Security Lake Glue database and table names supplied through CDK context.
- SageMaker Studio, CodeCommit, Athena, Lake Formation permissions, and Athena output storage deployed in the same account.

The CDK stack no longer models the original cross-account subscriber workflow. Instead, the SageMaker execution role receives access to the configured Security Lake database and table in the same account.

## CDK Changes

The CDK stack was updated to support configurable, single-account deployment.

Key changes:

- Removed the need for cross-account Resource Access Manager setup.
- Removed the need for Lake Formation resource-link databases.
- Added context-driven configuration for Security Lake database/table names.
- Added optional CDK-managed Lake Formation permissions through `createLakeFormationPermissions`.
- Added `glue:GetDatabases` and related Glue permissions needed by Athena metadata queries.
- Added Bedrock invoke permissions to the SageMaker user profile role for later course/lab work.
- Added support for Bedrock inference profile IDs such as `us.anthropic.claude-sonnet-4-6`.
- Kept the CodeCommit notebook repository deployment so SageMaker users can clone the notebooks into Studio.

The stack still does not create Amazon Security Lake. Security Lake and its source tables must exist before deploying this project.

## CDK Context

The modernized deployment is configured through `source/cdk.context.json`.

Important context keys:

- `sagemakerRestrictCidrPresignedUrl`
- `sagemakerPresignedUrlTrustedPrincipalArn`
- `cloudWatchVpcFlowLogsLogGroupName`
- `securityLakeDatabaseName`
- `securityLakeTableName`
- `athenaWorkgroupName`
- `bedrockModelId`
- `createLakeFormationPermissions`

## Notebook Changes

The notebook workflow was kept close to the original lab, but the implementation was updated so it can run in a modern SageMaker environment.

Key changes:

- Updated dependencies for modern Python versions, including Python 3.12.
- Removed reliance on outdated or difficult-to-install time-series libraries where practical.
- Reworked the local `mlsec.tsat` helpers so trend, outlier, and change-point workflows still function.
- Updated query logic for current Security Lake table naming and OCSF v2-style schemas.
- Adjusted notebook examples away from stale fields such as older `eventDay` usage where the current table uses timestamp fields such as `time_dt`.
- Kept some original notebook explanation text for continuity with the AWS lab.

Some notebooks may still mention older libraries or original lab wording. Those references are retained as context. The current code and requirements should be treated as authoritative.

## Security Lake Schema Notes

Security Lake schemas can vary by:

- AWS region.
- Enabled Security Lake source.
- OCSF version.
- Source-specific table.

The default configuration targets:

```text
amazon_security_lake_glue_db_us_east_1
amazon_security_lake_table_us_east_1_sh_findings_2_0
```

If your table name or columns differ, update `cdk.context.json` and the relevant notebook SQL cells.

## SageMaker Studio Notes

The original AWS blog used older SageMaker Studio UI screenshots and workflows. Current SageMaker Studio may present JupyterLab, Code Editor, and spaces differently.

Recommended workflow:

1. Open the deployed SageMaker Studio domain.
2. Start a JupyterLab or Code Editor space.
3. Open a terminal.
4. Clone the CodeCommit notebook repository from the CloudFormation output.
5. Use a Python 3 kernel for the notebooks.

## Lake Formation Notes

When `createLakeFormationPermissions` is `true`, CDK attempts to grant the SageMaker user profile role:

- `DESCRIBE` on the configured Security Lake database.
- `DESCRIBE` and `SELECT` on the configured Security Lake table.

If deployment fails while creating `AWS::LakeFormation::PrincipalPermissions`, the deployer likely lacks Lake Formation/Glue grant permissions. Either grant the deployer sufficient Lake Formation permissions or set `createLakeFormationPermissions` to `false` and grant access manually.

## Bedrock Notes

Bedrock permissions were added to support later lab work that uses generative AI over Security Lake data.

The `bedrockModelId` context value may be:

- A foundation model ID.
- A cross-region inference profile ID.
- A full model ARN.

For example:

```text
us.anthropic.claude-sonnet-4-6
```

The first ML insights notebooks do not require Bedrock for the basic time-series analysis flow.

## Files Worth Reviewing Before Publishing

Before publishing this fork, review:

- `README.md`
- `MODERNIZATION_NOTES.md`
- `source/cdk.context.json`
- `source/notebooks/tsat/requirements.txt`
- `source/notebooks/tsat/*.ipynb`
- `sagemaker_ml_insights_architecture.png`

The architecture diagram should be updated to show the single-account architecture. The current diagram may still contain visual elements from the original multi-account AWS sample.
