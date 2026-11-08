"use client";

import { Activity, AlertTriangle, BarChart3, ClipboardList, LayoutDashboard, LogOut, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SessionGate, useMe, useSignOut } from "@/components/session";
import { BRAND } from "@/lib/brand";

const NAV = [
  { href: "/doctor", label: "Overview", icon: LayoutDashboard },
  { href: "/doctor/patients", label: "Patients", icon: Users },
  { href: "/doctor/prescriptions", label: "Prescriptions", icon: ClipboardList },
  { href: "/doctor/gaps", label: "Care gaps", icon: AlertTriangle },
  { href: "/doctor/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/doctor/agents", label: "Agent activity", icon: Activity },
];

export function DoctorShell({ children }: { children: ReactNode }) {
  return (
    <SessionGate role="clinician">
      <Shell>{children}</Shell>
    </SessionGate>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const path = usePathname();
  const signOut = useSignOut();
  const active = (href: string) => (href === "/doctor" ? path === href : path.startsWith(href));
  const link = (n: (typeof NAV)[number], extra = "") => (
    <Link
      key={n.href}
      href={n.href}
      aria-current={active(n.href) ? "page" : undefined}
      className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium ${active(n.href) ? "bg-accent text-accent-ink" : "hover:bg-surface-2"} ${extra}`}
    >
      <n.icon aria-hidden className="h-4 w-4" />
      {n.label}
    </Link>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r border-line bg-surface p-4 md:flex md:flex-col">
        <p className="text-lg font-bold text-accent">{BRAND.name}</p>
        <p className="text-xs text-muted">Doctor portal · demo</p>
        <nav aria-label="Primary" className="mt-6 flex flex-col gap-1">
          {NAV.map((n) => link(n))}
        </nav>
        <div className="mt-auto space-y-2 pt-6 text-sm">
          <p className="font-medium">{me.displayName ?? "Clinician"}</p>
          <button onClick={signOut} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 hover:bg-surface-2">
            <LogOut aria-hidden className="h-4 w-4" /> Switch role
          </button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur md:hidden">
          <div className="flex items-center justify-between">
            <p className="font-bold text-accent">{BRAND.name}</p>
            <button onClick={signOut} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm hover:bg-surface-2">
              <LogOut aria-hidden className="h-4 w-4" /> Switch role
            </button>
          </div>
          <nav aria-label="Primary" className="-mx-1 mt-1 flex gap-1 overflow-x-auto pb-1">
            {NAV.map((n) => link(n, "shrink-0"))}
          </nav>
        </header>
        <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-6 text-xs text-muted sm:px-6">{BRAND.demoNotice}</footer>
      </div>
    </div>
  );
}
