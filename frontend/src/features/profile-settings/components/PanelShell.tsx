"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Common chrome shared by every settings sub-panel: a heading +
 * optional subtitle + a card body that hosts the panel's form fields.
 *
 * Centralised so the four panel files (Profile / Preferences /
 * Notifications / Security) don't repeat the typography hierarchy and
 * spacing scaffold. Concrete panels supply only their inner field
 * controls.
 */
interface PanelShellProps {
  title: string;
  subtitle?: string;
  /** Right-aligned slot for header-level controls (e.g. Save). */
  headerAction?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function PanelShell({
  title,
  subtitle,
  headerAction,
  children,
  className,
}: PanelShellProps) {
  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-ink">
            {title}
          </h1>
          {subtitle && (
            <p className="text-[12.5px] text-gray-600 dark:text-ink-muted mt-0.5 max-w-prose">
              {subtitle}
            </p>
          )}
        </div>
        {headerAction && <div className="shrink-0">{headerAction}</div>}
      </div>
      <div className="rounded-lg border border-gray-200 bg-white dark:border-line dark:bg-surface-subtle">
        {children}
      </div>
    </div>
  );
}

/**
 * One labelled row inside a PanelShell card body — label on top, the
 * input element beneath, with optional helper copy. Mirrors the field
 * shape used by the Invoice Builder right-rail inspector so the form
 * vocabulary feels familiar across the app.
 */
export function FieldRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-3 border-b border-gray-100 last:border-b-0 dark:border-line/60">
      <label
        htmlFor={htmlFor}
        className="block text-[12px] font-semibold text-gray-700 dark:text-ink-muted"
      >
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint && (
        <p className="text-[11px] text-gray-500 dark:text-ink-subtle mt-1 leading-snug">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Paired-row variant — left label/description, right control. Used
 * for boolean toggles where the label needs more breathing room than
 * a stacked layout gives.
 */
export function ToggleRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <div className="px-4 py-3 border-b border-gray-100 last:border-b-0 dark:border-line/60 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[12.5px] font-semibold text-gray-800 dark:text-ink">
          {label}
        </p>
        {description && (
          <p className="text-[11.5px] text-gray-600 dark:text-ink-muted mt-0.5 leading-snug">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0 mt-0.5">{control}</div>
    </div>
  );
}
