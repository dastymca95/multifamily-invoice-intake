"use client";

import {
  Bell,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  UserCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Settings shell — left-rail nav + right content well, scoped under
 * `/settings/*`. Mirrors the visual rhythm of Reference Data's
 * sub-navs (a column of categorical links + a single working pane on
 * the right) so operators don't have to learn a new layout.
 *
 * Each section gets its own route so the URL is deep-linkable / back-
 * button-friendly. The shell is a thin component (no business logic)
 * — the per-section panels under `profile-settings/components/*Panel`
 * own their own state.
 *
 * Important: this component lives in the feature folder rather than
 * `components/layout/` because it's specific to the Settings
 * workspace. Placing it next to the panels it wraps keeps the feature
 * self-contained and avoids coupling the global layout shell to
 * Settings-specific concerns.
 */
interface SettingsNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * Optional subtitle copy under the label. Used on items where the
   * link's purpose isn't obvious from the noun alone (e.g. "Security"
   * → what's behind that?).
   */
  hint?: string;
}

const NAV_ITEMS: SettingsNavItem[] = [
  {
    href: "/settings/profile",
    label: "Profile",
    icon: UserCircle,
    hint: "Name, email, and timezone",
  },
  {
    href: "/settings/preferences",
    label: "Preferences",
    icon: SlidersHorizontal,
    hint: "App-wide defaults",
  },
  {
    href: "/settings/appearance",
    label: "Appearance",
    icon: Palette,
    hint: "Theme + visual density",
  },
  {
    href: "/settings/notifications",
    label: "Notifications",
    icon: Bell,
    hint: "Email + in-app delivery",
  },
  {
    href: "/settings/security",
    label: "Security",
    icon: ShieldCheck,
    hint: "Sign-in + session controls",
  },
];

interface SettingsLayoutProps {
  children: ReactNode;
}

export function SettingsLayout({ children }: SettingsLayoutProps) {
  const pathname = usePathname();
  return (
    <div className="flex flex-1 min-h-0">
      {/* Left rail */}
      <aside
        className="w-60 shrink-0 border-r border-gray-200 bg-white dark:bg-surface-subtle dark:border-line px-3 py-4 overflow-y-auto"
        aria-label="Settings navigation"
      >
        <p className="px-3 pb-2 text-[10.5px] uppercase tracking-wide text-gray-500 dark:text-ink-subtle font-semibold">
          Account
        </p>
        <nav className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-start gap-2.5 px-3 py-2 rounded-md text-sm transition-colors duration-150",
                  active
                    ? "bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-50"
                    : "text-gray-700 hover:bg-gray-50 dark:text-ink-muted dark:hover:bg-surface-muted",
                )}
                aria-current={active ? "page" : undefined}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0 mt-[1px]",
                    active
                      ? "text-brand-600 dark:text-brand-50"
                      : "text-gray-400 dark:text-ink-subtle",
                  )}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{item.label}</div>
                  {item.hint && (
                    <div
                      className={cn(
                        "text-[11px] mt-0.5",
                        active
                          ? "text-brand-700/80 dark:text-brand-50/80"
                          : "text-gray-500 dark:text-ink-subtle",
                      )}
                    >
                      {item.hint}
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Content well */}
      <section className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 lg:py-8">{children}</div>
      </section>
    </div>
  );
}
