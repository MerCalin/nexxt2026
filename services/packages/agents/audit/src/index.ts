import { type AuditEntry, GENESIS_HASH } from "@dc/contracts";
import { AuditConflictError, type AuditLog, type AuditStorePort, type Clock } from "@dc/ports";
import { canonicalJson, sha256Hex } from "@dc/rules";

export const hashEntry = (e: Omit<AuditEntry, "hash">): string =>
  sha256Hex(
    e.prevHash + canonicalJson({ caseId: e.caseId, seq: e.seq, at: e.at, actor: e.actor, action: e.action, detail: e.detail }),
  );

/**
 * Audit agent: hash-chained, append-only log of every step and decision.
 * hash(n) = sha256(hash(n-1) ‖ canonicalJson(entry n)). Details must contain hashes and ids only.
 */
export function createAuditLog(store: AuditStorePort, clock: Clock): AuditLog {
  // serialise appends per case within this process; the store's conditional write protects across processes
  const queues = new Map<string, Promise<unknown>>();

  async function appendOnce(caseId: string, actor: string, action: string, detail: Record<string, unknown>) {
    const head = await store.head(caseId);
    const base = {
      caseId,
      seq: head ? head.seq + 1 : 0,
      at: clock.now().toISOString(),
      actor,
      action,
      detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown>,
      prevHash: head?.hash ?? GENESIS_HASH,
    };
    const entry: AuditEntry = { ...base, hash: hashEntry(base) };
    await store.append(entry);
    return entry;
  }

  return {
    append(caseId, actor, action, detail) {
      const prev = queues.get(caseId) ?? Promise.resolve();
      const next = prev.then(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await appendOnce(caseId, actor, action, detail);
          } catch (e) {
            if (!(e instanceof AuditConflictError) || attempt >= 5) throw e;
          }
        }
      });
      queues.set(
        caseId,
        next.catch(() => undefined),
      );
      return next;
    },

    list: (caseId) => store.list(caseId).then((l) => l.sort((a, b) => a.seq - b.seq)),

    async verify(caseId) {
      const entries = (await store.list(caseId)).sort((a, b) => a.seq - b.seq);
      let prev = GENESIS_HASH;
      for (const [i, e] of entries.entries()) {
        if (e.seq !== i) return { valid: false, entries: entries.length, brokenAtSeq: i, reason: "sequence gap" };
        if (e.prevHash !== prev) return { valid: false, entries: entries.length, brokenAtSeq: e.seq, reason: "prevHash mismatch" };
        const { hash, ...rest } = e;
        if (hashEntry(rest) !== hash) return { valid: false, entries: entries.length, brokenAtSeq: e.seq, reason: "content hash mismatch" };
        prev = hash;
      }
      return { valid: true, entries: entries.length, headHash: prev };
    },
  };
}
