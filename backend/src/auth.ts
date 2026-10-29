import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

export const ROLES = ["credit_officer", "kyc_officer", "compliance"] as const;
export type Role = (typeof ROLES)[number];

export type StaffUser = { sub: string; username: string; roles: Role[] };

/** Cognito group → service role. Users without one of these groups cannot use the app. */
export const GROUP_ROLES: Record<string, Role> = {
  "credit-officers": "credit_officer",
  "kyc-officers": "kyc_officer",
  compliance: "compliance",
};

export function rolesFromClaims(claims: JWTPayload): Role[] {
  const groups = (claims["cognito:groups"] as string[] | undefined) ?? [];
  return [...new Set(groups.map((g) => GROUP_ROLES[g]).filter((r): r is Role => !!r))];
}

/**
 * The active role for a request. Staff with several roles pick one per request (x-act-as-role);
 * otherwise their single role is used. Acting as a role the user does not hold is refused.
 */
export function activeRole(user: StaffUser, requested: string | null | undefined): Role | undefined {
  if (requested) return user.roles.find((r) => r === requested);
  return user.roles.length === 1 ? user.roles[0] : undefined;
}

export type Verifier = (token: string) => Promise<StaffUser | undefined>;

/** Verifies Cognito access tokens (signature via JWKS, issuer, client id, token_use). */
export function cognitoVerifier(cfg: { region: string; userPoolId: string; clientId: string }): Verifier {
  const issuer = `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer });
      if (payload.token_use !== "access" || payload.client_id !== cfg.clientId) return undefined;
      return { sub: String(payload.sub), username: String(payload.username ?? payload.sub), roles: rolesFromClaims(payload) };
    } catch {
      return undefined;
    }
  };
}

/**
 * Local development only: "Bearer dev:<username>:<role>[,<role>]". Refused when NODE_ENV=production.
 */
export function devVerifier(): Verifier {
  if (process.env.NODE_ENV === "production") throw new Error("dev authentication is not allowed in production");
  return async (token) => {
    const m = token.match(/^dev:([\w.-]+):([\w,]+)$/);
    if (!m) return undefined;
    const roles = m[2]!.split(",").filter((r): r is Role => (ROLES as readonly string[]).includes(r));
    return roles.length ? { sub: `dev-${m[1]}`, username: m[1]!, roles } : undefined;
  };
}
