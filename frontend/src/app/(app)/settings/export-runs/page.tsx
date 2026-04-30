import { ExportRunsPage } from "@/features/export-runs/components/ExportRunsPage";

/**
 * Phase 5C — Settings → Export Runs route shell.
 *
 * Settings layout wraps this page with the standard left-rail nav
 * + content well; the actual audit list UI lives in the feature
 * folder so the route file stays a thin import.
 *
 * Diagnostic only — listing / opening / saving notes here NEVER
 * triggers an export run, file generation, finalization, or
 * external posting. Phase 5A locks every persisted row to
 * ``phase="draft"``.
 */
export default function ExportRunsSettingsPage() {
  return <ExportRunsPage />;
}
