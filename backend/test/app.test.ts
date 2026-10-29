import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app";
import { activeRole, devVerifier, rolesFromClaims } from "../src/auth";
import { type Caller, signCaller } from "../src/service-client";

type Call = { caller: Caller; method: string; path: string; body?: string };

function setup() {
  const calls: Call[] = [];
  const app = createApp({
    verify: devVerifier(),
    service: async (caller, method, path, body) => {
      calls.push({ caller, method, path, body: body && new TextDecoder().decode(body.bytes) });
      return Response.json({ ok: true, path }, { status: 200 });
    },
  });
  return { app, calls };
}

const auth = (t: string, role?: string) => ({ authorization: `Bearer ${t}`, ...(role ? { "x-act-as-role": role } : {}) });

describe("role mapping", () => {
  test("cognito groups map to service roles; unknown groups are ignored", () => {
    expect(rolesFromClaims({ "cognito:groups": ["credit-officers", "admins", "compliance"] })).toEqual(["credit_officer", "compliance"]);
  });
  test("active role must be one the user holds", () => {
    const u = { sub: "1", username: "a", roles: ["credit_officer", "compliance"] as const };
    expect(activeRole({ ...u, roles: [...u.roles] }, "compliance")).toBe("compliance");
    expect(activeRole({ ...u, roles: [...u.roles] }, "kyc_officer")).toBeUndefined();
    expect(activeRole({ ...u, roles: [...u.roles] }, undefined)).toBeUndefined();
    expect(activeRole({ ...u, roles: ["kyc_officer"] }, undefined)).toBe("kyc_officer");
  });
});

describe("staff API proxy", () => {
  test("requires a valid token", async () => {
    const { app, calls } = setup();
    expect((await app.request("/api/cases")).status).toBe(401);
    expect((await app.request("/api/cases", { headers: auth("garbage") })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("forwards the officer identity and active role to the service", async () => {
    const { app, calls } = setup();
    const res = await app.request("/api/cases?limit=5", { headers: auth("dev:ana:credit_officer") });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ caller: { actor: "ana", role: "credit_officer" }, method: "GET", path: "/v1/cases?limit=5" });
  });

  test("multi-role users must choose, and cannot escalate", async () => {
    const { app, calls } = setup();
    expect((await app.request("/api/cases", { headers: auth("dev:radu:credit_officer,compliance") })).status).toBe(403);
    expect((await app.request("/api/cases", { headers: auth("dev:ana:credit_officer", "compliance") })).status).toBe(403);
    await app.request("/api/cases", { headers: auth("dev:radu:credit_officer,compliance", "compliance") });
    expect(calls[0]!.caller.role).toBe("compliance");
  });

  test("only allow-listed routes reach the service", async () => {
    const { app, calls } = setup();
    expect((await app.request("/api/cases/abc/audit", { method: "DELETE", headers: auth("dev:ana:credit_officer") })).status).toBe(404);
    expect((await app.request("/api/admin", { headers: auth("dev:ana:credit_officer") })).status).toBe(404);
    expect(calls).toHaveLength(0);
    const r = await app.request("/api/cases/abc/decision", { method: "POST", headers: { ...auth("dev:ana:credit_officer"), "content-type": "application/json" }, body: JSON.stringify({ outcome: "approved", reason: "ok ok ok ok" }) });
    expect(r.status).toBe(200);
    expect(calls[0]!.body).toContain("approved");
  });

  test("HMAC scheme matches the service's verifier", () => {
    // mirror of services/apps/document-check/src/auth.ts — both sides must agree byte-for-byte
    const key = "k";
    const expected = createHmac("sha256", key).update("ana\ncredit_officer\n1000\nGET\n/v1/cases").digest("hex");
    expect(signCaller(key, { actor: "ana", role: "credit_officer" }, "get", "/v1/cases", 1000)["x-dc-signature"]).toBe(expected);
  });
});
