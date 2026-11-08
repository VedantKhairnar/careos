"use client";

import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api";

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Thin wrapper over React Query: polling, stale data kept visible while refreshing (no layout jump),
 * and no retries, so a 401/403 surfaces immediately instead of after a delay.
 */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}): ApiState<T> {
  const q = useQuery<T, ApiError>({
    queryKey: ["api", path],
    queryFn: () => api<T>(path as string),
    enabled: path !== null,
    refetchInterval: opts.pollMs,
    retry: false,
  });
  return {
    data: q.data ?? null,
    error: q.error ?? null,
    loading: path !== null && q.isPending,
    reload: async () => {
      await q.refetch();
    },
  };
}
