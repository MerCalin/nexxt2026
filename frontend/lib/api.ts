import { useCallback, useEffect, useState } from "react";
import { getSession } from "./auth";

/** The web app talks ONLY to the staff API. Same origin by default (/api routed by the load balancer). */
const BASE = (import.meta.env.VITE_STAFF_API_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const s = getSession();
  return {
    ...(s ? { authorization: `Bearer ${s.accessToken}` } : {}),
    ...(s?.role ? { "x-act-as-role": s.role } : {}),
    ...extra,
  };
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    const msg = (body as { error?: unknown })?.error;
    throw new ApiError(res.status, typeof msg === "string" ? msg : `HTTP ${res.status}`, body);
  }
  return (res.status === 204 ? undefined : res.headers.get("content-type")?.includes("json") ? res.json() : res.blob()) as Promise<T>;
}

export const api = {
  get: <T>(path: string) => fetch(`${BASE}/api${path}`, { headers: headers() }).then(handle<T>),
  post: <T>(path: string, body?: unknown) =>
    fetch(`${BASE}/api${path}`, { method: "POST", headers: headers({ "content-type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) }).then(handle<T>),
  del: (path: string) => fetch(`${BASE}/api${path}`, { method: "DELETE", headers: headers() }).then(handle<void>),
  upload: <T>(path: string, file: File) => {
    const fd = new FormData();
    fd.set("file", file);
    return fetch(`${BASE}/api${path}`, { method: "POST", headers: headers(), body: fd }).then(handle<T>);
  },
  blob: (path: string) => fetch(`${BASE}/api${path}`, { headers: headers() }).then(handle<Blob>),
};

/** Minimal client-side query hook (tokens live in sessionStorage, so data is fetched in the browser). */
export function useQuery<T>(path: string | undefined, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async (background = false) => {
    if (!path) return;
    try {
      // background refreshes are marked so the service does not log them as views
      setData(await api.get<T>(background ? `${path}${path.includes("?") ? "&" : "?"}poll=1` : path));
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
    if (!opts.pollMs) return;
    const t = setInterval(() => reload(true), opts.pollMs);
    return () => clearInterval(t);
  }, [reload, opts.pollMs]);
  return { data, error, loading, reload };
}
