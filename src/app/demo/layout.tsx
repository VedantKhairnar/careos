import type { ReactNode } from "react";
import { AgentDock } from "@/components/AgentDock";

// The portals sit behind a sign-in check that runs in the browser, so their pages cannot be part of an instant,
// prerendered navigation by design. Opting out here silences Next's instant-navigation advisory for them.
export const instant = false;

export default function DemoLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <AgentDock />
    </>
  );
}
