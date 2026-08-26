import type { ProposalStatus, RequirementStatus, RiskLevel } from "@veleiro/shared";
import type { ReactNode } from "react";

/**
 * The small shared pieces. Deliberately plain: CLAUDE.md puts anything
 * cosmetic beyond legible and usable out of scope, so these earn their place by
 * making state visible, not by decoration.
 */

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-neutral-200 bg-white ${className}`}>
      {children}
    </div>
  );
}

const BUTTON_TONES = {
  primary: "bg-neutral-900 text-white hover:bg-neutral-700 disabled:bg-neutral-300",
  danger: "bg-red-700 text-white hover:bg-red-600 disabled:bg-red-200",
  quiet:
    "border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100 disabled:text-neutral-400",
} as const;

export function Button({
  children,
  onClick,
  tone = "quiet",
  disabled = false,
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: keyof typeof BUTTON_TONES;
  disabled?: boolean;
  type?: "button" | "submit";
  // Explicitly `| undefined`: with exactOptionalPropertyTypes on, a caller that
  // computes "a tooltip, or none" has to be able to pass the none.
  title?: string | undefined;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${BUTTON_TONES[tone]}`}
    >
      {children}
    </button>
  );
}

const REQUIREMENT_TONES: Record<RequirementStatus, string> = {
  extracted: "border-green-300 bg-green-50 text-green-900",
  // Loud on purpose: this is the one a human has to look at.
  needs_review: "border-amber-400 bg-amber-100 text-amber-950",
  proposed: "border-blue-300 bg-blue-50 text-blue-900",
  discarded: "border-neutral-300 bg-neutral-100 text-neutral-600",
};

const PROPOSAL_TONES: Record<ProposalStatus, string> = {
  pending: "border-blue-300 bg-blue-50 text-blue-900",
  approved: "border-blue-300 bg-blue-50 text-blue-900",
  applied: "border-green-300 bg-green-50 text-green-900",
  rejected: "border-neutral-300 bg-neutral-100 text-neutral-600",
  failed: "border-red-300 bg-red-50 text-red-900",
};

const RISK_TONES: Record<RiskLevel, string> = {
  low: "border-neutral-300 bg-neutral-100 text-neutral-700",
  medium: "border-amber-300 bg-amber-50 text-amber-900",
  high: "border-red-300 bg-red-50 text-red-900",
};

function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}
    >
      {children}
    </span>
  );
}

export function RequirementBadge({ status }: { status: RequirementStatus }) {
  return <Pill tone={REQUIREMENT_TONES[status]}>{status.replace("_", " ")}</Pill>;
}

export function ProposalBadge({ status }: { status: ProposalStatus }) {
  return <Pill tone={PROPOSAL_TONES[status]}>{status}</Pill>;
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  return <Pill tone={RISK_TONES[level]}>{level} risk</Pill>;
}

/**
 * Honest states, as SPEC requires. "Loading" says what it is waiting for, and
 * an error says what actually went wrong rather than "something went wrong".
 */
export function Loading({ what }: { what: string }) {
  return (
    <p className="py-6 text-sm text-neutral-500" aria-live="polite">
      Loading {what}…
    </p>
  );
}

export function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex items-start justify-between gap-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900"
      role="alert"
    >
      <p className="whitespace-pre-wrap">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded border border-red-300 px-2 py-1 text-xs hover:bg-red-100"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-sm text-neutral-500">{children}</p>;
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
