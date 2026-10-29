/**
 * Staff sign-in. In AWS: Cognito Hosted UI, authorization code flow with PKCE.
 * Locally (VITE_AUTH_MODE=dev): a dev token "dev:<user>:<roles>" accepted only by a non-production staff API.
 */
const env = import.meta.env;
export const AUTH_MODE: "cognito" | "dev" = env.VITE_AUTH_MODE === "dev" ? "dev" : "cognito";

const KEY = "dc.session";
type Session = { accessToken: string; expiresAt: number; role?: string };

const storage = () => (typeof window === "undefined" ? undefined : window.sessionStorage);

export function getSession(): Session | undefined {
  try {
    const s = JSON.parse(storage()?.getItem(KEY) ?? "null") as Session | null;
    return s && s.expiresAt > Date.now() ? s : undefined;
  } catch {
    return undefined;
  }
}

export function setSession(s: Session) {
  storage()?.setItem(KEY, JSON.stringify(s));
}

export function setActiveRole(role: string) {
  const s = getSession();
  if (s) setSession({ ...s, role });
}

export function signOut() {
  storage()?.removeItem(KEY);
  if (AUTH_MODE === "cognito") {
    const url = new URL(`${env.VITE_COGNITO_DOMAIN}/logout`);
    url.searchParams.set("client_id", env.VITE_COGNITO_CLIENT_ID);
    url.searchParams.set("logout_uri", window.location.origin);
    window.location.assign(url);
  } else window.location.assign("/");
}

export function devSignIn(user: string, roles: string[]) {
  setSession({ accessToken: `dev:${user}:${roles.join(",")}`, expiresAt: Date.now() + 8 * 3600_000, role: roles[0] });
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function startCognitoSignIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  storage()?.setItem("dc.pkce", JSON.stringify({ verifier, state }));
  const url = new URL(`${env.VITE_COGNITO_DOMAIN}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.VITE_COGNITO_CLIENT_ID,
    redirect_uri: `${window.location.origin}/auth/callback`,
    scope: "openid profile",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  }).toString();
  window.location.assign(url);
}

export async function completeCognitoSignIn(code: string, state: string) {
  const pkce = JSON.parse(storage()?.getItem("dc.pkce") ?? "null") as { verifier: string; state: string } | null;
  storage()?.removeItem("dc.pkce");
  if (!pkce || pkce.state !== state) throw new Error("Sesiune de autentificare invalidă");
  const res = await fetch(`${env.VITE_COGNITO_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.VITE_COGNITO_CLIENT_ID,
      code,
      redirect_uri: `${window.location.origin}/auth/callback`,
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) throw new Error(`Autentificare eșuată (${res.status})`);
  const t = (await res.json()) as { access_token: string; expires_in: number };
  setSession({ accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
}
