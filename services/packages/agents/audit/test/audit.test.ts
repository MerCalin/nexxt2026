import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "@dc/contracts";
import { AuditConflictError, type AuditStorePort } from "@dc/ports";
import { createAuditLog } from "../src";

/** Test-only store with the same conditional-write semantics as the DynamoDB table. */
class MemoryAuditStore implements AuditStorePort {
  rows: AuditEntry[] = [];
  async append(e: AuditEntry) {
    if (this.rows.some((r) => r.caseId === e.caseId && r.seq === e.seq)) throw new AuditConflictError("exists");
    this.rows.push(structuredClone(e));
  }
  async list(caseId: string) {
    return this.rows.filter((r) => r.caseId === caseId).map((r) => structuredClone(r));
  }
  async head(caseId: string) {
    return (await this.list(caseId)).sort((a, b) => b.seq - a.seq)[0];
  }
}

const clock = { now: () => new Date("2026-10-28T10:00:00Z") };

describe("audit chain", () => {
  test("concurrent appends produce a valid chain", async () => {
    const store = new MemoryAuditStore();
    const log = createAuditLog(store, clock);
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append("c1", "agent", "step", { i })));
    const v = await log.verify("c1");
    expect(v).toMatchObject({ valid: true, entries: 20 });
  });

  test("tampering with an entry is detected at its seq", async () => {
    const store = new MemoryAuditStore();
    const log = createAuditLog(store, clock);
    for (let i = 0; i < 5; i++) await log.append("c1", "agent", "step", { i });
    store.rows[2]!.detail = { i: 999 };
    expect(await log.verify("c1")).toMatchObject({ valid: false, brokenAtSeq: 2, reason: "content hash mismatch" });
  });

  test("deleting an entry is detected", async () => {
    const store = new MemoryAuditStore();
    const log = createAuditLog(store, clock);
    for (let i = 0; i < 4; i++) await log.append("c1", "agent", "step", { i });
    store.rows.splice(1, 1);
    expect(await log.verify("c1")).toMatchObject({ valid: false, brokenAtSeq: 1 });
  });
});
