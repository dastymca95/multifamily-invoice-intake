"use client";

import { cn } from "@/lib/utils";
import { type KeyboardEvent, type ReactNode, useId } from "react";

/**
 * Polished pill-style toggle switch.
 *
 * Used everywhere the editor surfaces a binary state that the user can
 * flip without leaving the row — column "required" in the inspector,
 * rule "active" in each row's left toolbar. Both surfaces share this
 * component so the visual + interaction language is identical: same
 * pill geometry, same colors, same focus ring, same disabled affordance.
 *
 * Accessibility:
 *
 *   * `role="switch"` + `aria-checked` — proper switch semantics for
 *     screen readers, distinct from a checkbox (a checkbox is for
 *     selection inside a set; a switch is for toggling a setting).
 *   * Keyboard: Space and Enter both toggle when focused. Tabbable
 *     unless `disabled`.
 *   * Focus ring uses `focus-visible:` so mouse clicks don't show a
 *     ring but keyboard focus does.
 *
 * Why not a native `<input type="checkbox">` styled to look like a
 * pill? Two reasons:
 *
 *   * Native checkboxes carry checkbox semantics in assistive tech
 *     (different verb than a switch).
 *   * Styling a checkbox to a pill is fragile across browsers; a
 *     button with role="switch" is the WAI-ARIA-recommended pattern
 *     and renders consistently.
 *
 * The `label` and `description` props let callers attach inline copy
 * that's properly associated via `aria-labelledby` / `aria-describedby`
 * — both are visually rendered next to the switch and click-targeted
 * to the same toggle handler so labels behave like the toggle itself.
 */

interface SwitchProps {
  /** Current on/off state. */
  checked: boolean;
  /** Called with the new value on toggle. */
  onChange: (next: boolean) => void;
  /**
   * Inline label rendered to the right of the switch. Click-targets
   * the toggle so the label feels native. Optional — callers that
   * provide their own external label via `aria-labelledby` can omit.
   */
  label?: ReactNode;
  /**
   * Secondary helper copy under the label. Only rendered when `label`
   * is also provided. Wired to `aria-describedby` for screen readers.
   */
  description?: ReactNode;
  /**
   * Greyed-out, non-interactive. We still render the pill in its
   * checked/unchecked color so the user can see the saved state.
   */
  disabled?: boolean;
  /**
   * Visual size. Default `md` matches inspector buttons. `sm` is the
   * compact form used in the rule-row toolbar where vertical real
   * estate is tight.
   */
  size?: "sm" | "md";
  /**
   * Direct aria-label override for cases where there's no inline
   * `label` (e.g. the switch is the only thing in a tight cell and
   * the surrounding row provides the context).
   */
  "aria-label"?: string;
  /** Direct aria-labelledby for an external label element. */
  "aria-labelledby"?: string;
  className?: string;
}

const SIZE_STYLES = {
  sm: {
    track: "h-4 w-7",
    knob: "h-3 w-3",
    knobOn: "translate-x-3",
    label: "text-[12px]",
    description: "text-[11px]",
  },
  md: {
    track: "h-5 w-9",
    knob: "h-4 w-4",
    knobOn: "translate-x-4",
    label: "text-sm",
    description: "text-xs",
  },
} as const;

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  size = "md",
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SwitchProps) {
  // Stable ids for label/description association. `useId` is React 18+
  // and SSR-safe; we don't manually generate to avoid hydration mismatch.
  const reactId = useId();
  const labelId = label ? `${reactId}-label` : undefined;
  const descriptionId = description ? `${reactId}-desc` : undefined;
  const sizes = SIZE_STYLES[size];

  const toggle = () => {
    if (disabled) return;
    onChange(!checked);
  };

  // Mirror native button keyboard behavior — Space/Enter activate.
  // The browser handles Enter for buttons natively; Space is also
  // native for buttons, but we add explicit handlers for switches
  // because some assistive tech expects role="switch" to handle
  // Space directly.
  const handleKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onChange(!checked);
    }
  };

  // Bare-pill case — no inline copy; render just the toggle.
  if (!label) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={handleKey}
        className={cn(
          "relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
          checked ? "bg-brand-600" : "bg-gray-300",
          disabled && "cursor-not-allowed opacity-50",
          sizes.track,
          className,
        )}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none inline-block transform rounded-full bg-white shadow-sm transition-transform",
            sizes.knob,
            // 0.5 is the resting offset that keeps the knob inside
            // the pill (track is wider than knob by 1 unit on each side).
            checked ? sizes.knobOn : "translate-x-0.5",
          )}
        />
      </button>
    );
  }

  // Labelled form — pill on the left, label + description stacked
  // on the right. The whole row is the click target.
  return (
    <label
      className={cn(
        "inline-flex items-start gap-3",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        className,
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={handleKey}
        className={cn(
          "relative mt-0.5 inline-flex shrink-0 items-center rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
          checked ? "bg-brand-600" : "bg-gray-300",
          disabled && "opacity-50",
          sizes.track,
        )}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none inline-block transform rounded-full bg-white shadow-sm transition-transform",
            sizes.knob,
            checked ? sizes.knobOn : "translate-x-0.5",
          )}
        />
      </button>
      <span className="flex flex-col leading-tight">
        <span
          id={labelId}
          className={cn("font-medium text-gray-800", sizes.label)}
        >
          {label}
        </span>
        {description && (
          <span
            id={descriptionId}
            className={cn("text-gray-500", sizes.description)}
          >
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
