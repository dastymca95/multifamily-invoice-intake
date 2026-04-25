import { AppearancePanel } from "@/features/profile-settings/components/AppearancePanel";

/**
 * Appearance sub-route — theme selection (Light / Dark / System).
 * Wrapped by the parent `settings/layout.tsx` which provides the
 * TopBar + the left-rail settings nav. The panel itself is the only
 * "real" setting today: theme persistence works end-to-end via
 * localStorage, no backend dependency.
 */
export default function AppearanceSettingsPage() {
  return <AppearancePanel />;
}
