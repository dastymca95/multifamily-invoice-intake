"use client";

import { Save } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";

import { ComingSoonNotice } from "./ComingSoonNotice";
import { PanelShell, ToggleRow } from "./PanelShell";

/**
 * Notification routing — what events ping the operator, where, and
 * how loudly. Today the panel surfaces the option SHAPE only; the
 * actual delivery pipeline (email + in-app toasts + future SMS)
 * lights up alongside the persistence rollout. The toggle vocabulary
 * here is the contract that pipeline will subscribe to — adding a
 * new event means adding it here first so it's visible to the
 * operator the same release it ships.
 */
interface NotificationGroup {
  /** Stable id used as the React key + the future settings field name. */
  id: string;
  title: string;
  description: string;
  /** Default state — what the operator sees on a fresh account. */
  initialEmail: boolean;
  initialInApp: boolean;
}

const NOTIFICATION_GROUPS: NotificationGroup[] = [
  {
    id: "batch_completed",
    title: "Batch processed",
    description:
      "An uploaded batch finishes its OCR + extraction pipeline and is ready for review.",
    initialEmail: true,
    initialInApp: true,
  },
  {
    id: "review_assigned",
    title: "Documents assigned to me",
    description:
      "A teammate routes a document to you in the Review Queue.",
    initialEmail: true,
    initialInApp: true,
  },
  {
    id: "extraction_failed",
    title: "Extraction failures",
    description:
      "A document couldn't be parsed and needs manual entry. Helpful for AP leads watching pipeline health.",
    initialEmail: false,
    initialInApp: true,
  },
  {
    id: "export_ready",
    title: "Export ready",
    description:
      "A scheduled or manually-triggered export has finished and is downloadable.",
    initialEmail: true,
    initialInApp: false,
  },
  {
    id: "weekly_digest",
    title: "Weekly digest",
    description:
      "A Monday-morning summary of last week's volume, top vendors, and any unresolved errors.",
    initialEmail: false,
    initialInApp: false,
  },
];

export function NotificationsPanel() {
  // Keep two flat records keyed by group id so checkbox lookups are
  // O(1) and the JSX stays readable. Initialised once from the
  // group config above.
  const [emailPrefs, setEmailPrefs] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      NOTIFICATION_GROUPS.map((g) => [g.id, g.initialEmail]),
    ),
  );
  const [inAppPrefs, setInAppPrefs] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      NOTIFICATION_GROUPS.map((g) => [g.id, g.initialInApp]),
    ),
  );

  return (
    <PanelShell
      title="Notifications"
      subtitle="Choose which events show up in your inbox and which ones surface in-app only."
      headerAction={
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled
          title="Settings persistence is coming soon"
        >
          <Save className="h-3.5 w-3.5" />
          Save changes
        </Button>
      }
    >
      <div className="px-4 pt-4">
        <ComingSoonNotice message="Notification routing currently shows the option set only — no delivery pipeline is wired in yet." />
      </div>

      {/* Header row — labels the two channel columns once. */}
      <div className="px-4 py-2 grid grid-cols-[1fr_4rem_4rem] gap-2 text-[10.5px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle font-semibold border-b border-gray-100 dark:border-line/60">
        <span>Event</span>
        <span className="text-center">Email</span>
        <span className="text-center">In-app</span>
      </div>

      {NOTIFICATION_GROUPS.map((g) => (
        <ToggleRow
          key={g.id}
          label={g.title}
          description={g.description}
          control={
            <div className="flex items-center gap-3">
              <Checkbox
                checked={emailPrefs[g.id]}
                onChange={(next) =>
                  setEmailPrefs((p) => ({ ...p, [g.id]: next }))
                }
                ariaLabel={`Email me when ${g.title.toLowerCase()}`}
              />
              <Checkbox
                checked={inAppPrefs[g.id]}
                onChange={(next) =>
                  setInAppPrefs((p) => ({ ...p, [g.id]: next }))
                }
                ariaLabel={`Show an in-app toast when ${g.title.toLowerCase()}`}
              />
            </div>
          }
        />
      ))}
    </PanelShell>
  );
}

function Checkbox({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={ariaLabel}
      className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-line dark:bg-surface"
    />
  );
}
