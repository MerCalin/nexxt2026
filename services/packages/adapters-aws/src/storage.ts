import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { AuditEntry, Case, Run } from "@dc/contracts";
import { AuditConflictError, type AuditStorePort, type CaseStorePort, type DocumentStorePort } from "@dc/ports";

/** S3 document store, server-side encrypted with the bank's KMS key. */
export class S3DocumentStore implements DocumentStorePort {
  private s3: S3Client;
  constructor(
    private cfg: { region: string; bucket: string; kmsKeyId?: string },
    client?: S3Client,
  ) {
    this.s3 = client ?? new S3Client({ region: cfg.region });
  }

  private enc() {
    return this.cfg.kmsKeyId
      ? { ServerSideEncryption: "aws:kms" as const, SSEKMSKeyId: this.cfg.kmsKeyId }
      : { ServerSideEncryption: "aws:kms" as const };
  }

  async put(key: string, bytes: Uint8Array, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: bytes, ContentType: contentType, ...this.enc() }));
  }

  async get(key: string) {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return out.Body!.transformToByteArray();
  }

  async putJson(key: string, value: unknown) {
    await this.put(key, new TextEncoder().encode(JSON.stringify(value)), "application/json");
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(new TextDecoder().decode(await this.get(key))) as T;
    } catch (e) {
      if (e instanceof NoSuchKey) return undefined;
      throw e;
    }
  }
}

/**
 * Cases live in DynamoDB (single table, pk/sk). Runs carry many facts and can exceed the
 * 400 KB item limit, so their bodies are stored as JSON in S3 and indexed in DynamoDB.
 */
export class DynamoCaseStore implements CaseStorePort {
  private doc: DynamoDBDocumentClient;
  constructor(
    private cfg: { region: string; table: string },
    private blobs: DocumentStorePort,
    client?: DynamoDBClient,
  ) {
    this.doc = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({ region: cfg.region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async createCase(c: Case) {
    await this.doc.send(
      new PutCommand({
        TableName: this.cfg.table,
        Item: { pk: `CASE#${c.id}`, sk: "CASE", type: "case", createdAt: c.createdAt, body: c },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  async getCase(id: string) {
    const out = await this.doc.send(new GetCommand({ TableName: this.cfg.table, Key: { pk: `CASE#${id}`, sk: "CASE" } }));
    return out.Item?.body as Case | undefined;
  }

  async putCase(c: Case) {
    await this.doc.send(
      new PutCommand({
        TableName: this.cfg.table,
        Item: { pk: `CASE#${c.id}`, sk: "CASE", type: "case", createdAt: c.createdAt, body: c },
      }),
    );
  }

  async listCases(limit: number) {
    // Small staff-facing list; a GSI on (type, createdAt) is used when present.
    const out = await this.doc.send(
      new ScanCommand({
        TableName: this.cfg.table,
        FilterExpression: "#t = :c",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: { ":c": "case" },
      }),
    );
    return ((out.Items ?? []).map((i) => i.body) as Case[])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async putRun(r: Run) {
    await this.blobs.putJson(`runs/${r.caseId}/${r.id}.json`, r);
    await this.doc.send(
      new PutCommand({
        TableName: this.cfg.table,
        Item: { pk: `RUN#${r.id}`, sk: "RUN", type: "run", caseId: r.caseId, status: r.status },
      }),
    );
  }

  async getRun(id: string) {
    const out = await this.doc.send(new GetCommand({ TableName: this.cfg.table, Key: { pk: `RUN#${id}`, sk: "RUN" } }));
    if (!out.Item) return undefined;
    return this.blobs.getJson<Run>(`runs/${out.Item.caseId}/${id}.json`);
  }

  async findByPerceptualHash(hash: string) {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.cfg.table,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": `PHASH#${hash}` },
      }),
    );
    return (out.Items ?? []).map((i) => ({ caseId: i.caseId as string, docId: i.docId as string }));
  }

  async indexPerceptualHash(hash: string, caseId: string, docId: string) {
    await this.doc.send(
      new PutCommand({ TableName: this.cfg.table, Item: { pk: `PHASH#${hash}`, sk: `${caseId}#${docId}`, caseId, docId } }),
    );
  }
}

/** Append-only audit table: the service role may only PutItem (with condition) and Query. */
export class DynamoAuditStore implements AuditStorePort {
  private doc: DynamoDBDocumentClient;
  constructor(
    private cfg: { region: string; table: string },
    client?: DynamoDBClient,
  ) {
    this.doc = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({ region: cfg.region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async append(e: AuditEntry) {
    try {
      await this.doc.send(
        new PutCommand({ TableName: this.cfg.table, Item: e, ConditionExpression: "attribute_not_exists(seq)" }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new AuditConflictError(`seq ${e.seq} exists for ${e.caseId}`);
      throw err;
    }
  }

  async list(caseId: string) {
    const items: AuditEntry[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.cfg.table,
          KeyConditionExpression: "caseId = :c",
          ExpressionAttributeValues: { ":c": caseId },
          ExclusiveStartKey: start,
        }),
      );
      items.push(...((out.Items ?? []) as AuditEntry[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  async head(caseId: string) {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.cfg.table,
        KeyConditionExpression: "caseId = :c",
        ExpressionAttributeValues: { ":c": caseId },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    return out.Items?.[0] as AuditEntry | undefined;
  }
}
