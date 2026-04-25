"use client";

import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Reusable "this surface isn't wired to the backend yet" banner for
 * the Settings shells. Sits at the top of every settings panel so the
 * operator never wonders why the Save button shows a toast and then
 * the values revert on reload — settings persistence ships with the
 * accounts/auth backend update, the UI is here in advance.
 *
 * Kept as a small standalone component (not inlined in each panel) so
 * a copy tweak — or a future "preview banner" upgrade — lands in one
 * place.
 */
interface ComingSoonNoticeProps {
  /**
   * Optional override of the default copy. Use when one panel has a
   * sharper "what specifically isn't saved" detail to surface (e.g.
   * "Notification routing currently mocks SMS + email delivery.").
   */
  message?: string;
  className?: string;
}

export function ComingSoonNotice({ message, className }: ComingSoonNoticeProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-amber-200 bg-amber-50 px-3 py-2",
        "flex items-start gap-2 text-[12px] text-amber-900",
        className,
      )}
      role="status"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600" />
      <div>
        <p className="font-semibold">Preview surface</p>
        <p className="mt-0.5 text-amber-800/90 leading-snug">
          {message ??
            "Settings persistence is coming soon — values entered here are not saved to your account yet."}
        </p>
      </div>
    </div>
  );
}
