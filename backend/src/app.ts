import { Hono } from "hono";
import { activeRole, type Role, type StaffUser, type Verifier } from "./auth";
import type { ServiceCall } from "./service-client";

type Env = { Variables: { user: StaffUser; role: Role } };

/** Routes the staff web app may call, mapped 1:1 onto the service's /v1 API. Anything else is 404. */
const ALLOWED: [method: string, pattern: RegExp][] = [
  ["GET", /^\/cases$/],
  ["POST", /^\/cases$/],
  ["GET", /^\/requirements\/(onboarding|loan|mortgage)$/],
  ["GET", /^\/cases\/[\w-]+$/],
  ["POST", /^\/cases\/[\w-]+\/documents$/],
  ["GET", /^\/cases\/[\w-]+\/documents\/[\w-]+\/file$/],
  ["POST", /^\/cases\/[\w-]+\/consents$/],
  ["DELETE", /^\/cases\/[\w-]+\/consents\/[\w-]+$/],
  ["POST", /^\/cases\/[\w-]+\/runs$/],
  ["GET", /^\/cases\/[\w-]+\/runs\/[\w-]+$/],
  ["POST", /^\/cases\/[\w-]+\/decision$/],
  ["GET", /^\/cases\/[\w-]+\/audit$/],
  ["GET", /^\/cases\/[\w-]+\/audit\/verify$/],
];

const MAX_BODY = 11 * 1024 * 1024;

export function createApp(deps: { verify: Verifier; service: ServiceCall }) {
  const app = new Hono<Env>().basePath("/api");

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/api/healthz") return next();
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const user = token ? await deps.verify(token) : undefined;
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!user.roles.length) return c.json({ error: "no staff role assigned" }, 403);
    c.set("user", user);
    if (c.req.path !== "/api/me") {
      const role = activeRole(user, c.req.header("x-act-as-role"));
      if (!role) return c.json({ error: "choose a role with x-act-as-role", roles: user.roles }, 403);
      c.set("role", role);
    }
    await next();
  });

  app.get("/me", (c) => {
    const u = c.get("user");
    return c.json({ username: u.username, roles: u.roles });
  });

  app.all("/*", async (c) => {
    const url = new URL(c.req.url);
    const sub = url.pathname.replace(/^\/api/, "");
    if (!ALLOWED.some(([m, re]) => m === c.req.method && re.test(sub))) return c.json({ error: "not found" }, 404);
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_BODY) return c.json({ error: "payload too large" }, 413);
    const hasBody = c.req.method === "POST";
    const body = hasBody ? { bytes: new Uint8Array(await c.req.arrayBuffer()), contentType: c.req.header("content-type") ?? "application/json" } : undefined;
    if (body && body.bytes.length > MAX_BODY) return c.json({ error: "payload too large" }, 413);

    let res: Response;
    try {
      res = await deps.service({ actor: c.get("user").username, role: c.get("role") }, c.req.method, `/v1${sub}${url.search}`, body);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "document-check service unreachable", error: String(e) }));
      return c.json({ error: "Serviciul de verificare a documentelor nu este disponibil" }, 502);
    }
    const headers = new Headers({ "cache-control": "private, no-store" });
    const ct = res.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    return new Response(res.body, { status: res.status, headers });
  });

  return app;
}
