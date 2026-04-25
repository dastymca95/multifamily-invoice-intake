"use client";

import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/Button";

import { ComingSoonNotice } from "./ComingSoonNotice";
import { PanelShell, ToggleRow } from "./PanelShell";

/**
 * Security panel — mostly placeholders pointing forward at the
 * accounts/auth backend rollout. Each row describes a future control
 * (password rotation, MFA, active sessions, API tokens) so operators
 * can see the security roadmap at a glance even before any of it
 * goes live. Disabled buttons + "coming soon" hints keep the wiring
 * obviously preview without hiding the affordances entirely.
 *
 * Why these specific surfaces:
 *   * Change password / sign out everywhere — table-stakes for a
 *     B2B SaaS account page; even when SSO is the primary path the
 *     "kill all my sessions" affordance is reassuring to operators.
 *   * Two-factor auth — invariably the first compliance ask.
 *   * Active sessions / API tokens — visibility into who/what holds
 *     credentials. Listed empty for now.
 *
 * Crucially this panel does NOT touch real auth state — it doesn't
 * read the JWT, doesn't issue any sign-out requests, doesn't render
 * device fingerprints. That all lands with the auth backend.
 */
export function SecurityPanel() {
  return (
    <PanelShell
      title="Security"
      subtitle="Sign-in protections, active sessions, and API tokens. Most controls light up alongside the accounts backend."
    >
      <div className="px-4 pt-4">
        <ComingSoonNotice message="Account security controls land with the accounts/auth backend — these placeholders preview the surface area." />
      </div>

      <ToggleRow
        label="Two-factor authentication"
        description="Require a one-time code on each new sign-in. Recommended for accounts that can approve exports."
        control={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled
            title="Two-factor enrolment is coming soon"
          >
            Enable
          </Button>
        }
      />

      <ToggleRow
        label="Change password"
        description="Rotate the password used to sign into BillsIQ directly. SSO sign-ins are managed by your identity provider."
        control={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled
            title="Password rotation is coming soon"
          >
            Change…
          </Button>
        }
      />

      <ToggleRow
        label="Sign out everywhere"
        description="Invalidate every active session on every device. You'll be signed back in here automatically."
        control={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled
            title="Global sign-out is coming soon"
          >
            Revoke
          </Button>
        }
      />

      <div className="px-4 py-3 border-b border-gray-100 last:border-b-0 dark:border-line/60">
        <p className="text-[12.5px] font-semibold text-gray-800 dark:text-ink">
          Active sessions
        </p>
        <p className="text-[11.5px] text-gray-600 dark:text-ink-muted mt-0.5 leading-snug">
          Each device or browser you&rsquo;re signed in on. Revoke any
          you don&rsquo;t recognise.
        </p>
        <div className="mt-2 rounded-md border border-dashed border-gray-200 bg-gray-50 px-3 py-4 text-center text-[11.5px] text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-subtle">
          <ShieldCheck
            className="h-4 w-4 mx-auto text-gray-400 dark:text-ink-subtle mb-1"
            aria-hidden
          />
          Session listing will appear here once the accounts backend is live.
        </div>
      </div>

      <div className="px-4 py-3 border-b border-gray-100 last:border-b-0 dark:border-line/60">
        <p className="text-[12.5px] font-semibold text-gray-800 dark:text-ink">
          API tokens
        </p>
        <p className="text-[11.5px] text-gray-600 dark:text-ink-muted mt-0.5 leading-snug">
          Long-lived tokens for scripted exports, scheduled imports,
          or third-party integrations.
        </p>
        <div className="mt-2 rounded-md border border-dashed border-gray-200 bg-gray-50 px-3 py-4 text-center text-[11.5px] text-gray-500 dark:border-line dark:bg-surface-muted dark:text-ink-subtle">
          No tokens issued yet. Token issuance ships with the accounts
          backend.
        </div>
      </div>
    </PanelShell>
  );
}
