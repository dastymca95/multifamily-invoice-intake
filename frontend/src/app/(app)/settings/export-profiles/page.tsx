import { ExportProfilesPage } from "@/features/export-profiles/components/ExportProfilesPage";

/**
 * Phase 4C — Settings → Export Profiles route shell.
 *
 * Settings layout wraps this page with the standard left-rail nav
 * + content well; the actual catalog UI lives in the feature
 * folder so the route file stays a thin import.
 *
 * Diagnostic only — managing profiles here NEVER triggers an
 * export run, file generation, or external posting.
 */
export default function ExportProfilesSettingsPage() {
  return <ExportProfilesPage />;
}
