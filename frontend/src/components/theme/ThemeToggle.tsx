"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

import { useTheme } from "./ThemeProvider";
import type { ThemeMode } from "./theme-types";

/**
 * Theme picker — TopBar dropdown variant.
 *
 * Three options: Light / Dark / System default. The trigger shows
 * the current selection's icon (Sun / Moon / Monitor); the menu
 * surfaces all three with the active one ticked.
 *
 * Why a dropdown (not a segmented control): the topbar is already
 * wide on small screens with Help / Settings / Sign out side by
 * side; a single icon button preserves space and matches the
 * affordance density of the surrounding controls.
 *
 * Accessibility:
 *   * Trigger has `aria-haspopup="menu"` + `aria-expanded` and is
 *     reachable by keyboard.
 *   * Menu uses `role="menu"` with `role="menuitemradio"` items
 *     (one of three is checked).
 *   * Escape + outside-click both close the menu.
 *   * Focus does NOT auto-jump into the menu so a Tab from the
 *     trigger walks naturally to Settings.
 */
const OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System default", icon: Monitor },
];

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme, mounted } = useTheme();
  const [open, setOpen] = useState(false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape close. Listener attached only while open
  // so we don't pay a global click cost when the menu is dormant.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handlePick = useCallback(
    (next: ThemeMode) => {
      setTheme(next);
      setOpen(false);
    },
    [setTheme],
  );

  // Trigger icon mirrors the user's SELECTION (not the resolved
  // value) so the affordance reflects what they last clicked. Until
  // hydration completes we render a neutral icon to avoid an
  // SSR/CSR mismatch that would log a warning.
  const triggerIcon = !mounted
    ? Monitor
    : theme === "light"
      ? Sun
      : theme === "dark"
        ? Moon
        : Monitor;
  const TriggerIcon = triggerIcon;

  // Keyboard handler on the trigger — Enter/Space opens, ArrowDown
  // opens AND focuses the first menu item (standard menubutton
  // behaviour). We hand-roll instead of pulling a heavier menu
  // primitive — this is the only menu in the topbar.
  const handleTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKey}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${optionLabel(theme)} (current: ${resolvedTheme})`}
        title={`Theme: ${optionLabel(theme)}`}
        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-ink-muted dark:hover:bg-surface-muted"
      >
        <TriggerIcon className="h-4 w-4" />
        <span className="hidden sm:inline">Theme</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Theme options"
          className={cn(
            "absolute right-0 mt-1 w-44 rounded-md border shadow-lg z-50 py-1",
            "bg-white border-gray-200",
            "dark:bg-surface-subtle dark:border-line",
          )}
        >
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const checked = theme === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => handlePick(opt.value)}
                className={cn(
                  "w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px]",
                  "text-gray-700 hover:bg-gray-50",
                  "dark:text-ink-muted dark:hover:bg-surface-muted",
                  checked && "font-semibold text-gray-900 dark:text-ink",
                )}
              >
                <Icon className="h-3.5 w-3.5 text-gray-500 dark:text-ink-subtle" />
                <span className="flex-1 text-left">{opt.label}</span>
                {checked && (
                  <Check className="h-3.5 w-3.5 text-brand-600" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Inline-rendered, label-only variant. Used inside the Settings
 * Appearance panel where the dropdown affordance feels heavy and a
 * three-up segmented control reads better.
 */
export function ThemeSegmentedControl() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        "inline-flex rounded-md border overflow-hidden",
        "border-gray-300 bg-white",
        "dark:border-line dark:bg-surface-subtle",
      )}
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium",
              "border-r border-gray-200 last:border-r-0",
              "dark:border-line",
              active
                ? "bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-50"
                : "text-gray-700 hover:bg-gray-50 dark:text-ink-muted dark:hover:bg-surface-muted",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function optionLabel(value: ThemeMode): string {
  return OPTIONS.find((o) => o.value === value)?.label ?? value;
}
