import { NotificationsPanel } from "@/features/profile-settings/components/NotificationsPanel";

/**
 * Notifications sub-route — per-event email + in-app delivery
 * preferences. Surfaces the option set today; the actual delivery
 * pipeline lights up alongside the persistence backend.
 */
export default function NotificationsSettingsPage() {
  return <NotificationsPanel />;
}
