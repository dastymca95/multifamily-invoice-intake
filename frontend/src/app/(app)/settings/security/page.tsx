import { SecurityPanel } from "@/features/profile-settings/components/SecurityPanel";

/**
 * Security sub-route — sign-in protections + sessions + API tokens.
 * All controls render disabled until the accounts/auth backend
 * lands; this page exists primarily so the security roadmap is
 * discoverable.
 */
export default function SecuritySettingsPage() {
  return <SecurityPanel />;
}
