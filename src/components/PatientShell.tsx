"use client";

import { Bell, ClipboardList, History, Home, LogOut, MessageCircle, Pill, Type } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SessionGate, useLargeText, useMe, useSignOut } from "@/components/session";
import { BRAND } from "@/lib/brand";
import { useApi } from "@/lib/useApi";

const NAV = [
  { href: "/patient", label: "Home", icon: Home },
  { href: "/patient/plan", label: "Care plan", icon: ClipboardList },
  { href: "/patient/medications", label: "Medications", icon: Pill },
  { href: "/patient/timeline", label: "Timeline", icon: History },
  { href: "/patient/ask", label: "Ask", icon: MessageCircle },
  { href: "/patient/notifications", label: "Updates", icon: Bell },
];

export function PatientShell({ children }: { children: ReactNode }) {
  return (
    <SessionGate role="patient">
      <Shell>{children}</Shell>
    </SessionGate>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const path = usePathname();
  const signOut = useSignOut();
  const text = useLargeText();
  const { data } = useApi<{ unread: number }>("/api/notifications", { pollMs: 10000 });
  const unread = data?.unread ?? 0;
  const active = (href: string) => (href === "/patient" ? path === href : path.startsWith(href));

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-accent">{BRAND.name}</p>
            <p className="text-xs text-muted">{me.displayName ?? "Patient"} · demo</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={text.toggle}
              aria-pressed={text.on}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-medium hover:bg-surface-2"
            >
              <Type aria-hidden className="h-4 w-4" />
              {text.on ? "Normal text" : "Larger text"}
            </button>
            <button onClick={signOut} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-medium hover:bg-surface-2">
              <LogOut aria-hidden className="h-4 w-4" />
              <span className="hidden sm:inline">Switch role</span>
              <span className="sr-only sm:hidden">Switch role</span>
            </button>
          </div>
        </div>
        <nav aria-label="Primary" className="mt-2 hidden gap-1 sm:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium ${active(n.href) ? "bg-accent text-accent-ink" : "hover:bg-surface-2"}`}
            >
              <n.icon aria-hidden className="h-4 w-4" />
              {n.label}
              {n.href.endsWith("notifications") && unread > 0 && <span className="rounded-full bg-danger px-1.5 text-xs text-accent-ink">{unread}</span>}
            </Link>
          ))}
        </nav>
      </header>

      <main className="flex-1 space-y-4 px-4 pb-28 pt-4 sm:pb-10">{children}</main>

      <footer className="px-4 pb-24 text-xs text-muted sm:pb-6">{BRAND.demoNotice}</footer>

      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface sm:hidden">
        <ul className="mx-auto grid max-w-3xl grid-cols-6">
          {NAV.map((n) => (
            <li key={n.href}>
              <Link
                href={n.href}
                aria-current={active(n.href) ? "page" : undefined}
                className={`relative flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${active(n.href) ? "text-accent" : "text-muted"}`}
              >
                <n.icon aria-hidden className="h-5 w-5" />
                {n.label}
                {n.href.endsWith("notifications") && unread > 0 && (
                  <span className="absolute right-4 top-2 rounded-full bg-danger px-1.5 text-[10px] text-accent-ink">{unread}</span>
                )}
                {active(n.href) && <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-accent" />}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
