/**
 * Creates the dev resources in eu-central-1 for running the service locally against real AWS:
 * an encrypted, private S3 bucket and the two DynamoDB tables. Idempotent.
 *
 *   AWS_PROFILE=... bun scripts/bootstrap-dev.ts --prefix doccheck-dev-<you>
 */
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};
const region = arg("--region") ?? process.env.AWS_REGION ?? "eu-central-1";
const prefix = arg("--prefix") ?? "";
if (!prefix) throw new Error("usage: bun scripts/bootstrap-dev.ts --prefix doccheck-dev-<name> [--region us-west-2]");
console.log(`region: ${region}${process.env.AWS_DEFAULT_REGION && process.env.AWS_DEFAULT_REGION !== region ? ` (note: AWS_DEFAULT_REGION=${process.env.AWS_DEFAULT_REGION})` : ""}`);

const s3 = new S3Client({ region });
const ddb = new DynamoDBClient({ region });
const bucket = `${prefix}-documents`;

try {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`bucket ${bucket} exists`);
} catch {
  // us-east-1 is S3's default region and rejects an explicit LocationConstraint
  await s3.send(new CreateBucketCommand({ Bucket: bucket, ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }) }));
  console.log(`created bucket ${bucket}`);
}
await s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } }));
await s3.send(new PutBucketEncryptionCommand({ Bucket: bucket, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" }, BucketKeyEnabled: true }] } }));

async function table(name: string, pk: string, sk: string, skType: "S" | "N") {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: name }));
    console.log(`table ${name} exists`);
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
    await ddb.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: pk, AttributeType: "S" }, { AttributeName: sk, AttributeType: skType }],
        KeySchema: [{ AttributeName: pk, KeyType: "HASH" }, { AttributeName: sk, KeyType: "RANGE" }],
        SSESpecification: { Enabled: true },
      }),
    );
    console.log(`created table ${name}`);
  }
}
await table(`${prefix}-cases`, "pk", "sk", "S");
await table(`${prefix}-audit`, "caseId", "seq", "N");

console.log(`\nexport AWS_REGION=${region}\nexport DOC_BUCKET=${bucket}\nexport CASES_TABLE=${prefix}-cases\nexport AUDIT_TABLE=${prefix}-audit`);
