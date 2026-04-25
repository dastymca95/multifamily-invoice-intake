import { ProfilePanel } from "@/features/profile-settings/components/ProfilePanel";

/**
 * Profile sub-route — name / email / role / company / timezone.
 * Matches the spec's "/settings/profile" entry point.
 *
 * Wrapped by the parent `settings/layout.tsx` which provides the
 * TopBar + the left-rail settings nav, so this file stays a
 * one-liner that mounts the panel.
 */
export default function ProfileSettingsPage() {
  return <ProfilePanel />;
}
