import type { ReactNode } from "react";

import { TopBar } from "@/components/layout/TopBar";
import { SettingsLayout } from "@/features/profile-settings/components/SettingsLayout";

/**
 * Route shell for the Settings workspace.
 *
 * The TopBar carries a stable "Settings" title across every sub-page
 * — operators reading the breadcrumb-equivalent shouldn't see it
 * change as they hop between Profile / Preferences / Notifications /
 * Security; the active sub-section is already spelled out in the
 * left rail nav.
 *
 * Stays a thin wrapper: the actual two-column layout lives in
 * `SettingsLayout` so the feature folder owns its own visual
 * scaffolding.
 */
export default function SettingsRouteLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Settings" />
      <SettingsLayout>{children}</SettingsLayout>
    </div>
  );
}
