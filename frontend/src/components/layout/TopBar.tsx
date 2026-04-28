"use client";

import { LifeBuoy, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

interface TopBarProps {
  title: string;
}

/**
 * Top bar — page title + a small set of "always available" controls.
 *
 * Order of controls (left → right): Help, Theme, Settings, Sign out.
 * Theme sits between Help and Settings because operators reach for
 * it most often in the same flow — "open settings, also flip dark
 * mode" — and grouping the three account-style controls keeps the
 * destructive Sign-out visually separated from them.
 *
 * Theme styling: the bar is white in light mode and the slightly-
 * lifted slate-800 in dark mode; the bottom border swaps from
 * gray-200 to the slate `line` token. Each link/button picks up
 * `dark:*` overrides locally so the overall affordance density is
 * preserved.
 */
export function TopBar({ title }: TopBarProps) {
  const router = useRouter();

  const handleLogout = () => {
    localStorage.removeItem("access_token");
    router.push("/login");
  };

  return (
    <header className="h-14 border-b border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 dark:bg-surface-subtle/95 dark:border-line px-6 flex items-center justify-between shrink-0">
      <h1 className="text-base font-semibold tracking-tight text-gray-900 dark:text-ink">
        {title}
      </h1>
      <div className="flex items-center gap-1">
        <Link
          href="/help"
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100 dark:text-ink-muted dark:hover:bg-surface-muted"
          title="Help center"
          aria-label="Open help center"
        >
          <LifeBuoy className="h-4 w-4" />
          <span className="hidden sm:inline">Help</span>
        </Link>
        <ThemeToggle />
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100 dark:text-ink-muted dark:hover:bg-surface-muted"
          title="Account settings"
          aria-label="Open account settings"
        >
          <Settings className="h-4 w-4" />
          <span className="hidden sm:inline">Settings</span>
        </Link>
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </header>
  );
}
