/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Staff API base URL; empty = same origin (/api routed to the staff API by the load balancer). */
  readonly VITE_STAFF_API_URL?: string;
  readonly VITE_AUTH_MODE?: "dev" | "cognito";
  /** Bank name shown next to the product name (default "Raiffeisen Bank"). */
  readonly VITE_BRAND_NAME?: string;
  /** Full bank logo for light backgrounds (default /brand/raiffeisen-bank.svg, served from public/). */
  readonly VITE_BRAND_LOGO?: string;
  /** Same logo with a light wordmark, for the black header (default /brand/raiffeisen-bank-on-dark.svg). */
  readonly VITE_BRAND_LOGO_DARK?: string;
  readonly VITE_COGNITO_DOMAIN: string;
  readonly VITE_COGNITO_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
