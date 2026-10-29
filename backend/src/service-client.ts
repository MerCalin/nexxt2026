import { createHmac } from "node:crypto";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { Role } from "./auth";

export type Caller = { actor: string; role: Role };

/** Same scheme as the service's verifyCaller: HMAC over actor, role, timestamp, method and path. */
export function signCaller(key: string, c: Caller, method: string, path: string, ts = Date.now()): Record<string, string> {
  const sig = createHmac("sha256", key).update(`${c.actor}\n${c.role}\n${ts}\n${method.toUpperCase()}\n${path}`).digest("hex");
  return { "x-dc-actor": c.actor, "x-dc-role": c.role, "x-dc-timestamp": String(ts), "x-dc-signature": sig };
}

export type ServiceClientConfig = {
  baseUrl: string; // VPC Lattice service DNS name, or http://localhost:8080 in dev
  signingKey: string;
  /** "sigv4" in AWS (VPC Lattice IAM auth policy), "none" for local development. */
  latticeAuth: "sigv4" | "none";
  region: string;
};

/**
 * The staff API is the ONLY caller of the document-check service. Each request carries the
 * officer's identity (HMAC-signed) and, in AWS, a SigV4 signature for VPC Lattice
 * (service "vpc-lattice-svcs"); the backend task role may only invoke that service.
 */
export function createServiceClient(cfg: ServiceClientConfig) {
  const signer =
    cfg.latticeAuth === "sigv4"
      ? new SignatureV4({ service: "vpc-lattice-svcs", region: cfg.region, credentials: defaultProvider(), sha256: Sha256 })
      : undefined;

  return async function call(caller: Caller, method: string, pathAndQuery: string, body?: { bytes: Uint8Array; contentType: string }): Promise<Response> {
    const url = new URL(pathAndQuery, cfg.baseUrl);
    const headers: Record<string, string> = {
      host: url.host,
      ...signCaller(cfg.signingKey, caller, method, url.pathname + url.search),
      ...(body ? { "content-type": body.contentType } : {}),
    };
    if (signer) {
      // Lattice accepts unsigned payloads, which lets multipart uploads stream through unchanged
      headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
      const signed = await signer.sign({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
      });
      Object.assign(headers, signed.headers);
    }
    return fetch(url, { method, headers, body: body ? new Blob([body.bytes as Uint8Array<ArrayBuffer>]) : undefined });
  };
}

export type ServiceCall = ReturnType<typeof createServiceClient>;
