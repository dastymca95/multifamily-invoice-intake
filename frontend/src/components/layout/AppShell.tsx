import type { ReactNode } from "react";

import { FloatingHelpChat } from "@/components/help-chat";

import { Sidebar } from "./Sidebar";

interface AppShellProps {
  children: ReactNode;
}

/**
 * App-level frame shared by every authenticated route — sidebar on
 * the left, scrollable content on the right.
 *
 * Background uses the theme-aware `bg-surface` token (resolves to
 * slate-50 in light mode, slate-900 in dark) so the page swaps
 * automatically when `<html>` flips its `dark` class. The legacy
 * `bg-gray-50` is kept as the LIGHT default in case a downstream
 * page renders before the theme provider mounts (it won't paint
 * before the boot script applies the resolved class, but the
 * fallback keeps any future SSR-only render readable).
 *
 * `<FloatingHelpChat />` is mounted ONCE here (not per-page) so its
 * open/closed state and message transcript persist across route
 * changes. The component pins itself to the bottom-right corner
 * with `position: fixed`, so adding it as a sibling of `<main>`
 * doesn't affect the sidebar/content flex layout.
 */
export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-surface text-ink">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">{children}</main>
      <FloatingHelpChat />
    </div>
  );
}
