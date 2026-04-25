"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { ThemeSegmentedControl } from "@/components/theme/ThemeToggle";
import { useTheme } from "@/components/theme/ThemeProvider";

import { PanelShell, ToggleRow } from "./PanelShell";

/**
 * Appearance panel — currently only theme. Lives next to the other
 * Settings sub-panels so a future "density / accent color / font
 * size" rollout has an obvious home.
 *
 * Theme is the ONE setting on this page that's actually persisted +
 * effective today (via localStorage + ThemeProvider) — there's no
 * "coming soon" banner because the wiring is real. The segmented
 * control mirrors the topbar dropdown so an operator who flips the
 * theme here sees the topbar selection update immediately, without
 * a re-render flicker.
 */
export function AppearancePanel() {
  const { theme, resolvedTheme } = useTheme();

  return (
    <PanelShell
      title="Appearance"
      subtitle="Switch between light, dark, or follow your operating system."
    >
      <ToggleRow
        label="Theme"
        description={appearanceDescription(theme, resolvedTheme)}
        control={<ThemeSegmentedControl />}
      />
      <div className="px-4 py-3 text-[11.5px] text-gray-500 dark:text-ink-subtle">
        <p className="leading-snug">
          Tip: pick &ldquo;System default&rdquo; to follow your OS. Many
          operating systems schedule dark mode at sunset.
        </p>
        <div className="mt-2 flex items-center gap-3">
          <Legend Icon={Sun} label="Light" />
          <Legend Icon={Moon} label="Dark" />
          <Legend Icon={Monitor} label="System" />
        </div>
      </div>
    </PanelShell>
  );
}

/**
 * Compose the secondary copy under the Theme row. Surfaces the
 * RESOLVED mode in parentheses when the operator has picked
 * "System default" so they understand what their OS is currently
 * resolving to.
 */
function appearanceDescription(
  theme: ReturnType<typeof useTheme>["theme"],
  resolvedTheme: ReturnType<typeof useTheme>["resolvedTheme"],
): string {
  if (theme === "system") {
    return `Currently following your operating system (${resolvedTheme}).`;
  }
  if (theme === "dark") {
    return "Forces the dark palette regardless of your OS preference.";
  }
  return "Forces the light palette regardless of your OS preference.";
}

function Legend({
  Icon,
  label,
}: {
  Icon: typeof Sun;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
