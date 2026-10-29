/**
 * Bank branding shown next to the product name. Configured per deployment:
 *   VITE_BRAND_NAME       — bank name; used as the logo's alt text and when no logo loads
 *   VITE_BRAND_LOGO       — full logo (symbol + wordmark) for light backgrounds
 *   VITE_BRAND_LOGO_DARK  — same logo with a light wordmark, for the black header
 * Logo files live in /public/brand. Use only the bank's official, approved assets.
 */
export const PRODUCT_NAME = "Verificare documente";
export const BRAND_NAME: string = import.meta.env.VITE_BRAND_NAME ?? "Raiffeisen Bank";
export const BRAND_LOGO: string = import.meta.env.VITE_BRAND_LOGO ?? "/brand/raiffeisen-bank.svg";
export const BRAND_LOGO_DARK: string = import.meta.env.VITE_BRAND_LOGO_DARK ?? "/brand/raiffeisen-bank-on-dark.svg";
