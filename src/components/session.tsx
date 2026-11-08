"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { CardSkeleton } from "./ui";

export interface Me {
  userId: string;
  role: "patient" | "clinician" | "demo_operator";
  patientId: string | null;
  displayName: string | null;
  demo: boolean;
}

const MeCtx = createContext<Me | null>(null);
export function useMe(): Me {
  const m = useContext(MeCtx);
  if (!m) throw new Error("useMe must be used inside a SessionGate");
  return m;
}

/** Client-side guard for UX. The API enforces the same rules server-side regardless of what this does. */
export function SessionGate({ role, children }: { role: Me["role"]; children: ReactNode }) {
  const router = useRouter();
  const { data, error } = useApi<Me>("/api/auth/me");
  const allowed = data?.role === role;

  useEffect(() => {
    if (error?.status === 401 || (data && !allowed)) router.replace("/");
  }, [error, data, allowed, router]);

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <CardSkeleton rows={4} />
      </div>
    );
  }
  return <MeCtx.Provider value={data}>{children}</MeCtx.Provider>;
}

export function useSignOut() {
  const router = useRouter();
  const qc = useQueryClient();
  return async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      qc.clear(); // never show the next role the previous person's cached data
      router.push("/");
    }
  };
}

const STORAGE_KEY = "careos-large-text";
function readLargeText(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // storage unavailable: default size
  }
}

/** Larger-text option for readability. Remembered per browser when storage is available. */
export function useLargeText() {
  const [on, setOn] = useState(readLargeText);
  useEffect(() => {
    document.documentElement.classList.toggle("large-text", on);
  }, [on]);
  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  return { on, toggle };
}
