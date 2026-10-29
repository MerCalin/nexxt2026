/**
 * Finds what a restricted AWS account (e.g. Workshop Studio) allows: regions, pre-existing buckets
 * and tables, Bedrock inference profiles, and whether S3/DynamoDB resources can be created.
 * Anything this script creates is deleted again immediately.
 *
 *   bun scripts/probe-aws.ts
 */
import { BedrockClient, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ListTablesCommand, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand, DeleteBucketCommand, GetBucketLocationCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const REGIONS = ["eu-central-1", "eu-west-1", "eu-west-3", "eu-north-1", "us-east-1", "us-west-2"];
const short = (e: unknown) => {
  const err = e as { name?: string; message?: string };
  return `${err.name}: ${(err.message ?? "").includes("service control policy") ? "blocked by SCP" : (err.message ?? "").slice(0, 90)}`;
};

const id = await new STSClient({ region: "us-east-1" }).send(new GetCallerIdentityCommand({}));
console.log(`identity: ${id.Arn}\n`);

const s3 = new S3Client({ region: "us-east-1" });
try {
  const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
  console.log(`existing buckets (${Buckets.length}):`);
  for (const b of Buckets) {
    const loc = await s3.send(new GetBucketLocationCommand({ Bucket: b.Name })).catch(() => undefined);
    console.log(`  ${b.Name}  [${loc?.LocationConstraint ?? "us-east-1"}]`);
  }
} catch (e) {
  console.log(`list buckets: ${short(e)}`);
}

const suffix = Math.random().toString(36).slice(2, 8);
for (const region of REGIONS) {
  console.log(`\n== ${region}`);

  try {
    const r = await new BedrockClient({ region }).send(new ListInferenceProfilesCommand({}));
    const claude = (r.inferenceProfileSummaries ?? []).map((p) => p.inferenceProfileId).filter((x) => x?.includes("anthropic"));
    console.log(`  bedrock claude profiles: ${claude.length ? claude.join(", ") : "(none)"}`);
  } catch (e) {
    console.log(`  bedrock: ${short(e)}`);
  }

  const ddb = new DynamoDBClient({ region });
  try {
    const t = await ddb.send(new ListTablesCommand({}));
    console.log(`  dynamodb tables: ${(t.TableNames ?? []).join(", ") || "(none)"}`);
    const name = `doccheck-probe-${suffix}`;
    await ddb.send(new CreateTableCommand({ TableName: name, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }] }));
    await waitUntilTableExists({ client: ddb, maxWaitTime: 60 }, { TableName: name });
    await ddb.send(new DeleteTableCommand({ TableName: name }));
    console.log("  dynamodb create table: allowed");
  } catch (e) {
    console.log(`  dynamodb: ${short(e)}`);
  }

  const bucket = `doccheck-probe-${suffix}-${region}`;
  const rs3 = new S3Client({ region });
  try {
    await rs3.send(new CreateBucketCommand({ Bucket: bucket, ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }) }));
    await rs3.send(new DeleteBucketCommand({ Bucket: bucket }));
    console.log("  s3 create bucket: allowed");
  } catch (e) {
    console.log(`  s3 create bucket: ${short(e)}`);
  }
}
