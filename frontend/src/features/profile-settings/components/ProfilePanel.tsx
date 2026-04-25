"use client";

import { Save } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";

import { ComingSoonNotice } from "./ComingSoonNotice";
import { FieldRow, PanelShell } from "./PanelShell";

/**
 * Profile panel — name / email / role / company / timezone. Pure UI
 * shell: form state is local-only and the Save button is disabled
 * until the backend persistence story lands. The placeholder values
 * below are illustrative only — they're NOT pulled from the auth
 * payload because there is no profile fetch endpoint yet.
 *
 * When persistence ships, this panel:
 *   1. Replaces the local-state defaults with values from a
 *      `useCurrentUser()` hook.
 *   2. Wires Save to a `PATCH /me/profile` round-trip.
 *   3. Drops the ComingSoonNotice above the form.
 *
 * The Save button stays in the JSX during this transition so the
 * layout doesn't shift between preview and live modes.
 */
const PLACEHOLDER_TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

export function ProfilePanel() {
  // Locally-stored preview values. Reset on reload — that's the
  // intended behaviour while persistence is unavailable; surfacing
  // stale fake-saved data would be more confusing than transient
  // input.
  const [fullName, setFullName] = useState("");
  const [emailReadOnly] = useState("you@yourcompany.example");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");

  return (
    <PanelShell
      title="Profile"
      subtitle="How you appear in audit trails, invoice review notes, and exported metadata."
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
        <ComingSoonNotice />
      </div>

      <FieldRow
        label="Full name"
        htmlFor="profile-name"
        hint="Shown next to actions you take in Review Queue + Exports."
      >
        <input
          id="profile-name"
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="e.g. Jamie Rivera"
          maxLength={120}
          className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle"
        />
      </FieldRow>

      <FieldRow
        label="Email"
        htmlFor="profile-email"
        hint="Email is managed by your sign-in identity provider — change it there to update it here."
      >
        <input
          id="profile-email"
          type="email"
          value={emailReadOnly}
          readOnly
          className="w-full rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[13px] text-gray-600 cursor-not-allowed dark:border-line dark:bg-surface-muted dark:text-ink-muted"
        />
      </FieldRow>

      <FieldRow
        label="Role"
        htmlFor="profile-role"
        hint="Free text for now (e.g. Controller, AP Specialist). Will become a structured RBAC role once permissions ship."
      >
        <input
          id="profile-role"
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. AP Specialist"
          maxLength={80}
          className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle"
        />
      </FieldRow>

      <FieldRow label="Company" htmlFor="profile-company">
        <input
          id="profile-company"
          type="text"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="e.g. Greenwood Property Management"
          maxLength={120}
          className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle"
        />
      </FieldRow>

      <FieldRow
        label="Timezone"
        htmlFor="profile-timezone"
        hint="Used to render due dates and processing timestamps in your local time."
      >
        <select
          id="profile-timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          {PLACEHOLDER_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </FieldRow>
    </PanelShell>
  );
}
