"use client";

import { AlertTriangle, CheckCircle2, Clock, Info, Loader2, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink",
  info: "bg-info-bg text-info",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
};
const TONE_ICON = { neutral: Info, info: Info, success: CheckCircle2, warning: Clock, danger: AlertTriangle } as const;

/** Status is always icon + text, never color alone. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[tone]}`}>
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {children}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; loading?: boolean };
const BTN = {
  primary: "bg-accent text-accent-ink hover:opacity-90",
  secondary: "bg-surface border border-line text-ink hover:bg-surface-2",
  ghost: "text-ink hover:bg-surface-2",
  danger: "bg-danger-bg text-danger border border-danger/30 hover:opacity-90",
};
export function Button({ variant = "primary", loading, children, disabled, className = "", ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${BTN[variant]} ${className}`}
    >
      {loading && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export const Skeleton = ({ className = "h-5 w-full" }: { className?: string }) => <div aria-hidden className={`skeleton ${className}`} />;

export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="rounded-2xl border border-line bg-surface p-5">
      <Skeleton className="mb-4 h-5 w-1/3" />
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl bg-danger-bg p-4 text-danger">
      <XCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">{message}</p>
        {onRetry && (
          <button onClick={onRetry} className="mt-2 text-sm font-semibold underline">
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

/** Where a piece of information came from. Collapsed by default, available on request. */
export function SourceDetails({ source }: { source: { actorRole: string; sourceSystem: string; recordedAt: string; verification: string; simulated: boolean } | null }) {
  if (!source) return null;
  const when = new Date(source.recordedAt).toLocaleString();
  return (
    <details className="mt-2 text-xs text-muted">
      <summary className="cursor-pointer select-none font-medium">Where does this come from?</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt>Recorded by</dt>
        <dd>{source.actorRole.replace("_", " ")} via {source.sourceSystem}</dd>
        <dt>When</dt>
        <dd>{when}</dd>
        <dt>Status</dt>
        <dd>{source.verification.replace("_", " ")}</dd>
        {source.simulated && (
          <>
            <dt>Note</dt>
            <dd>Simulated for this demonstration</dd>
          </>
        )}
      </dl>
    </details>
  );
}

export function SimulatedBadge() {
  return <Badge tone="info">Simulated</Badge>;
}

/* ---- Toasts ---- */
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}
const ToastCtx = createContext<(message: string, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Tone = "success") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`pointer-events-auto max-w-md rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${TONE[t.tone]}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
