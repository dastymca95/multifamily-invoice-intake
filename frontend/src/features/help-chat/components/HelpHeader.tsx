"use client";

import { LifeBuoy, Mail } from "lucide-react";

/**
 * Help center header — page title + a tagline making the
 * preview-mode nature of the chat surface explicit, plus a single
 * "email support" fallback link so operators with a real urgent
 * issue have a non-placeholder escape hatch.
 *
 * The mailto target is a placeholder constant; swap for the real
 * support address when one's published. Keeping it as a `mailto:`
 * (rather than a webform) avoids spinning up another form-handler
 * surface for what should be a low-traffic fallback.
 */
const SUPPORT_EMAIL = "support@billsiq.example";

export function HelpHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="inline-flex items-center gap-2">
          <LifeBuoy className="h-5 w-5 text-brand-600" aria-hidden />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-ink">
            Help center
          </h1>
        </div>
        <p className="text-[13px] text-gray-600 dark:text-ink-muted mt-1 max-w-prose leading-relaxed">
          Browse the FAQ cards below for an orientation to each
          workspace, or chat with the in-app assistant. The assistant
          is a local-only preview today — no messages are sent to a
          server.
        </p>
      </div>
      <a
        href={`mailto:${SUPPORT_EMAIL}?subject=BillsIQ%20support%20request`}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-[12.5px] text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-line dark:bg-surface-subtle dark:text-ink-muted dark:hover:bg-surface-muted"
        title={`Email ${SUPPORT_EMAIL}`}
      >
        <Mail className="h-3.5 w-3.5" aria-hidden />
        Email support
      </a>
    </div>
  );
}
