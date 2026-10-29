import { useState } from "react";
import { BRAND_LOGO, BRAND_LOGO_DARK, BRAND_NAME, PRODUCT_NAME } from "@/lib/brand";
import { cx } from "@/utils/cx";

/** The bank's full logo (symbol + wordmark); falls back to the bank name as text if the file is missing. */
export function BrandLogo({ height, onDark = false, className }: { height: number; onDark?: boolean; className?: string }) {
  const src = onDark ? BRAND_LOGO_DARK : BRAND_LOGO;
  const [failed, setFailed] = useState(!src);
  if (failed) return <span className={cx("font-bold", onDark ? "text-white" : "text-primary", className)}>{BRAND_NAME}</span>;
  return <img src={src} alt={BRAND_NAME} onError={() => setFailed(true)} className={cx("w-auto shrink-0", className)} style={{ height }} />;
}

/** "[bank logo] | Verificare documente" — for the black header. */
export function HeaderBrand() {
  return (
    <span className="flex items-center gap-3">
      <BrandLogo height={30} onDark />
      <span aria-hidden className="h-6 w-px bg-white/25" />
      <span className="text-md font-medium text-white/85">{PRODUCT_NAME}</span>
    </span>
  );
}
