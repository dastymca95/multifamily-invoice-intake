"use client";

import { Save } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";

import { ComingSoonNotice } from "./ComingSoonNotice";
import { FieldRow, PanelShell, ToggleRow } from "./PanelShell";

/**
 * App-wide preference toggles + defaults. Same preview pattern as the
 * other settings panels — controlled local state, disabled Save, and
 * the persistence-coming-soon banner up top.
 *
 * Why these specific defaults: each one was a "where should the
 * editor land?" question that came up across product surfaces. By
 * giving the operator one place to set them — instead of hard-coding
 * a per-surface default — we keep workspace-level affordances
 * consistent with each user's working style. They have no effect
 * today (preview surface) but the option set is the contract for the
 * persistence rollout.
 */
const DATE_FORMATS = [
  { value: "iso", label: "ISO (2026-04-24)" },
  { value: "us", label: "US (04/24/2026)" },
  { value: "eu", label: "European (24/04/2026)" },
  { value: "long", label: "Long (April 24, 2026)" },
];

const NUMBER_FORMATS = [
  { value: "us", label: "1,234.56 (US)" },
  { value: "eu", label: "1.234,56 (European)" },
  { value: "compact", label: "1.2K / 1.2M (compact)" },
];

const HOMEPAGES = [
  { value: "/dashboard", label: "Dashboard" },
  { value: "/upload", label: "Upload" },
  { value: "/review", label: "Review Queue" },
  { value: "/exports", label: "Exports" },
];

export function PreferencesPanel() {
  const [dateFormat, setDateFormat] = useState("us");
  const [numberFormat, setNumberFormat] = useState("us");
  const [homepage, setHomepage] = useState("/dashboard");
  const [denseTables, setDenseTables] = useState(false);
  const [autoOpenReview, setAutoOpenReview] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);

  return (
    <PanelShell
      title="Preferences"
      subtitle="App-wide defaults for date / number formatting and where you want to land after sign-in."
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
        label="Default date format"
        htmlFor="pref-date-format"
        hint="Applies to invoice due dates, processing timestamps, and exported metadata."
      >
        <select
          id="pref-date-format"
          value={dateFormat}
          onChange={(e) => setDateFormat(e.target.value)}
          className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink"
        >
          {DATE_FORMATS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </FieldRow>

      <FieldRow
        label="Default number format"
        htmlFor="pref-number-format"
        hint="Applies to amounts in Review Queue and exported reports."
      >
        <select
          id="pref-number-format"
          value={numberFormat}
          onChange={(e) => setNumberFormat(e.target.value)}
          className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink"
        >
          {NUMBER_FORMATS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </FieldRow>

      <FieldRow
        label="Sign-in landing page"
        htmlFor="pref-homepage"
        hint="Where you'll go after signing in. Pick the page you visit most."
      >
        <select
          id="pref-homepage"
          value={homepage}
          onChange={(e) => setHomepage(e.target.value)}
          className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-line dark:bg-surface dark:text-ink"
        >
          {HOMEPAGES.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </FieldRow>

      <ToggleRow
        label="Dense table rows"
        description="Tighter row padding in Review Queue and Exports — fits more onto the screen at a glance."
        control={
          <PreviewToggle
            checked={denseTables}
            onChange={setDenseTables}
            label="Dense table rows"
          />
        }
      />

      <ToggleRow
        label="Auto-open the next document"
        description="When you finish reviewing one document, automatically open the next one in the queue."
        control={
          <PreviewToggle
            checked={autoOpenReview}
            onChange={setAutoOpenReview}
            label="Auto-open the next document"
          />
        }
      />

      <ToggleRow
        label="Reduce motion"
        description="Skip non-essential animations like sidebar transitions and toast slide-ins."
        control={
          <PreviewToggle
            checked={reduceMotion}
            onChange={setReduceMotion}
            label="Reduce motion"
          />
        }
      />
    </PanelShell>
  );
}

/**
 * Inline accessible toggle. Avoids pulling in a heavier toggle
 * primitive — settings panels use it in three places and the rest of
 * the app already uses native form controls. Keep parity by sticking
 * with a button + visual track approach. Stateless: parent owns the
 * value.
 */
function PreviewToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-brand-600" : "bg-gray-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
