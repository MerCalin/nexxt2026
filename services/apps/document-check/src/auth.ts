import { createHmac, timingSafeEqual } from "node:crypto";
import { Role } from "@dc/contracts";

export type Caller = { actor: string; role: Role };

const MAX_SKEW_MS = 5 * 60_000;

/**
 * The staff API forwards the signed-in officer as headers signed with HMAC-SHA256:
 *   x-dc-actor, x-dc-role, x-dc-timestamp, x-dc-signature = HMAC(key, `${actor}\n${role}\n${ts}\n${METHOD}\n${path}`)
 * Network access is already restricted to the staff API by the VPC Lattice auth policy; the
 * signature additionally binds identity and role to each request.
 */
export function signCaller(key: string, c: Caller, method: string, path: string, ts = Date.now()): Record<string, string> {
  const sig = createHmac("sha256", key).update(`${c.actor}\n${c.role}\n${ts}\n${method.toUpperCase()}\n${path}`).digest("hex");
  return { "x-dc-actor": c.actor, "x-dc-role": c.role, "x-dc-timestamp": String(ts), "x-dc-signature": sig };
}

export function verifyCaller(key: string, headers: Headers, method: string, path: string, now = Date.now()): Caller | undefined {
  const actor = headers.get("x-dc-actor");
  const role = Role.safeParse(headers.get("x-dc-role"));
  const ts = Number(headers.get("x-dc-timestamp"));
  const sig = headers.get("x-dc-signature") ?? "";
  if (!actor || !role.success || !Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return undefined;
  const expected = signCaller(key, { actor, role: role.data }, method, path, ts)["x-dc-signature"]!;
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return { actor, role: role.data };
}
