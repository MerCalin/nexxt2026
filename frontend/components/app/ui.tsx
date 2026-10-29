/** App-level building blocks on top of Untitled UI: cards, status badges and alerts. */
import type { FC, ReactNode } from "react";
import { AlertCircle, AlertTriangle, CheckCircle, InfoCircle } from "@untitledui/icons";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { LANE_LABEL, SEVERITY_LABEL } from "@/lib/labels";
import type { Lane, Severity } from "@/lib/types";
import { cx } from "@/utils/cx";

export function Card({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl bg-primary shadow-xs ring-1 ring-secondary", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-secondary px-5 py-4">
          <div className="min-w-0">
            {title && <h3 className="text-md font-semibold text-primary">{title}</h3>}
            {description && <p className="mt-0.5 text-sm text-tertiary">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const LANE_COLOR: Record<Lane, "success" | "warning" | "error"> = { ready_for_officer: "success", needs_info: "warning", human_review: "error" };
export const LaneBadge = ({ lane, size = "md" }: { lane: Lane; size?: "sm" | "md" | "lg" }) => (
  <BadgeWithDot type="pill-color" color={LANE_COLOR[lane]} size={size}>
    {LANE_LABEL[lane]}
  </BadgeWithDot>
);

const SEVERITY_COLOR: Record<Severity, "gray" | "blue" | "warning" | "error"> = { info: "gray", low: "blue", medium: "warning", high: "error" };
export const SeverityBadge = ({ severity }: { severity: Severity }) => (
  <Badge type="color" color={SEVERITY_COLOR[severity]} size="sm">
    {SEVERITY_LABEL[severity]}
  </Badge>
);

const STATUS: Record<string, { label: string; color: "success" | "error" | "gray" | "warning" }> = {
  ok: { label: "finalizat", color: "success" },
  blocked: { label: "blocat", color: "error" },
  error: { label: "eroare", color: "error" },
  timeout: { label: "timp depășit", color: "error" },
  skipped: { label: "omis", color: "gray" },
};
export const AgentStatusBadge = ({ name, status, title }: { name: string; status: string; title?: string }) => {
  const s = STATUS[status] ?? { label: status, color: "warning" as const };
  return (
    <span title={title}>
      <BadgeWithDot type="modern" color={s.color} size="sm">
        {name} · {s.label}
      </BadgeWithDot>
    </span>
  );
};

export const SimulatedBadge = () => (
  <Badge type="color" color="purple" size="sm">
    SIMULAT
  </Badge>
);

export const ConfidentialBadge = () => (
  <Badge type="color" color="gray" size="sm">
    Confidențial — Conformitate
  </Badge>
);

const ALERT: Record<"error" | "warning" | "success" | "info", { icon: FC<{ className?: string }>; color: "error" | "warning" | "success" | "gray"; box: string }> = {
  error: { icon: AlertCircle, color: "error", box: "bg-error-primary ring-utility-red-200" },
  warning: { icon: AlertTriangle, color: "warning", box: "bg-warning-primary ring-utility-yellow-200" },
  success: { icon: CheckCircle, color: "success", box: "bg-success-primary ring-utility-green-200" },
  info: { icon: InfoCircle, color: "gray", box: "bg-secondary ring-secondary" },
};
export function Alert({ kind, title, children }: { kind: keyof typeof ALERT; title: ReactNode; children?: ReactNode }) {
  const a = ALERT[kind];
  return (
    <div className={cx("flex gap-3 rounded-xl p-4 ring-1", a.box)}>
      <FeaturedIcon icon={a.icon} color={a.color} theme="outline" size="sm" />
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-primary">{title}</p>
        {children && <div className="mt-1 text-secondary">{children}</div>}
      </div>
    </div>
  );
}

export const PageHeader = ({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div className="min-w-0">
      <h1 className="text-display-xs font-semibold text-primary">{title}</h1>
      {description && <div className="mt-1 text-md text-tertiary">{description}</div>}
    </div>
    {actions && <div className="flex items-center gap-3">{actions}</div>}
  </div>
);
