/**
 * DEV ONLY: deletes cases (and everything belonging to them) from the dev DynamoDB tables and
 * S3 bucket. The app itself never deletes: in production case files and the audit log are kept
 * for the retention period (Law 129/2019 art. 21).
 *
 *   source ~/doccheck.env
 *   bun scripts/delete-dev-data.ts --list                       # show cases, delete nothing
 *   bun scripts/delete-dev-data.ts --case <caseId> [--case …]   # dry run: show what would go
 *   bun scripts/delete-dev-data.ts --case <caseId> --yes        # delete those cases
 *   bun scripts/delete-dev-data.ts --all --yes                  # delete every case (+ OCR cache)
 *
 * Refuses to run when NODE_ENV=production or a resource name contains "prod".
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const env = process.env;
const need = (k: string) => env[k] ?? (() => { throw new Error(`Missing ${k} — run: source ~/doccheck.env`); })();
const region = env.AWS_REGION ?? "eu-central-1";
const bucket = need("DOC_BUCKET");
const casesTable = need("CASES_TABLE");
const auditTable = need("AUDIT_TABLE");
if (env.NODE_ENV === "production" || [bucket, casesTable, auditTable].some((n) => /prod/i.test(n)))
  throw new Error("Refusing to delete: this looks like a production environment.");

const args = process.argv.slice(2);
const caseIds = args.flatMap((a, i) => (a === "--case" && args[i + 1] ? [args[i + 1]!] : []));
const all = args.includes("--all");
const yes = args.includes("--yes");
const list = args.includes("--list") || (!all && !caseIds.length);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });

async function scanAll(table: string, filter?: { expr: string; names?: Record<string, string>; values?: Record<string, unknown> }) {
  const items: Record<string, any>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({ TableName: table, ExclusiveStartKey: start, ...(filter ? { FilterExpression: filter.expr, ExpressionAttributeNames: filter.names, ExpressionAttributeValues: filter.values } : {}) }),
    );
    items.push(...(out.Items ?? []));
    start = out.LastEvaluatedKey;
  } while (start);
  return items;
}

async function deleteKeys(table: string, keys: Record<string, unknown>[]) {
  for (let i = 0; i < keys.length; i += 25) {
    let req: any = { [table]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
    while (req && Object.keys(req).length) req = (await ddb.send(new BatchWriteCommand({ RequestItems: req }))).UnprocessedItems;
  }
}

async function s3Keys(prefix: string) {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    keys.push(...(out.Contents ?? []).map((o) => o.Key!));
    token = out.NextContinuationToken;
  } while (token);
  return keys;
}

async function deleteS3(keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000)
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
}

const cases = await scanAll(casesTable, { expr: "#t = :c", names: { "#t": "type" }, values: { ":c": "case" } });
if (list) {
  console.log(`${cases.length} case(s) in ${casesTable} (${region}):`);
  for (const c of cases.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))))
    console.log(`  ${c.body.id}  ${String(c.body.workflow).padEnd(10)} ${String(c.body.subject?.customerRef).padEnd(32)} ${c.createdAt}`);
  if (!all && !caseIds.length) process.exit(0);
}

const targets = all ? cases.map((c) => c.body.id as string) : caseIds;
const unknown = targets.filter((id) => !cases.some((c) => c.body.id === id));
if (unknown.length) console.warn(`Not found (skipped): ${unknown.join(", ")}`);
const ids = targets.filter((id) => !unknown.includes(id));
if (!ids.length) process.exit(0);

let plan = { caseItems: 0, runItems: 0, hashItems: 0, auditItems: 0, s3Objects: 0 };
const work: (() => Promise<void>)[] = [];
for (const id of ids) {
  const body = cases.find((c) => c.body.id === id)!.body;
  const runKeys = (body.runs ?? []).map((r: string) => ({ pk: `RUN#${r}`, sk: "RUN" }));
  const hashKeys = (await scanAll(casesTable, { expr: "begins_with(pk, :p) AND begins_with(sk, :s)", values: { ":p": "PHASH#", ":s": `${id}#` } })).map((i) => ({ pk: i.pk, sk: i.sk }));
  const audit: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(new QueryCommand({ TableName: auditTable, KeyConditionExpression: "caseId = :c", ExpressionAttributeValues: { ":c": id }, ProjectionExpression: "caseId, seq", ExclusiveStartKey: start }));
    audit.push(...(out.Items ?? []));
    start = out.LastEvaluatedKey;
  } while (start);
  const objects = [...(await s3Keys(`cases/${id}/`)), ...(await s3Keys(`runs/${id}/`))];
  plan = { caseItems: plan.caseItems + 1, runItems: plan.runItems + runKeys.length, hashItems: plan.hashItems + hashKeys.length, auditItems: plan.auditItems + audit.length, s3Objects: plan.s3Objects + objects.length };
  console.log(`- ${id} (${body.subject?.customerRef}): ${runKeys.length} runs, ${hashKeys.length} hash index, ${audit.length} audit entries, ${objects.length} S3 objects`);
  work.push(async () => {
    await deleteS3(objects);
    await deleteKeys(casesTable, [...runKeys, ...hashKeys, { pk: `CASE#${id}`, sk: "CASE" }]);
    await deleteKeys(auditTable, audit);
  });
}
const ocrCache = all ? await s3Keys("ocr/") : [];
if (all) console.log(`- shared OCR cache: ${ocrCache.length} S3 objects`);

if (!yes) {
  console.log(`\nDry run — nothing deleted. Add --yes to delete ${plan.caseItems} case(s).`);
  process.exit(0);
}
for (const w of work) await w();
if (ocrCache.length) await deleteS3(ocrCache);
console.log(`\nDeleted ${plan.caseItems} case(s), ${plan.runItems} runs, ${plan.auditItems} audit entries, ${plan.s3Objects + ocrCache.length} S3 objects.`);
