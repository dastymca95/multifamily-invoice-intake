"use client";

import { cn } from "@/lib/utils";

/**
 * Where a catalog (GL / Properties / Templates) was originally seeded.
 * Mirrored from `app.schemas.*.<Catalog>Source` Pydantic enums — kept
 * as a string union here so this component stays decoupled from any
 * one feature's type module.
 */
export type CatalogSourceKind = "default" | "blank" | "from_upload" | "custom";

const BADGES: Record<
  CatalogSourceKind,
  { label: string; tone: string }
> = {
  default: { label: "Default", tone: "bg-blue-50 text-blue-700" },
  blank: { label: "Blank", tone: "bg-gray-100 text-gray-700" },
  from_upload: { label: "From upload", tone: "bg-purple-50 text-purple-700" },
  custom: { label: "Custom", tone: "bg-brand-50 text-brand-700" },
};

/**
 * Compact source-of-origin pill used in catalog editor title bars.
 * Same labels + tones across every catalog editor in the app so users
 * recognize "this came from a default" at a glance regardless of which
 * Reference Data sub-page they're on.
 */
export function SourceBadge({ source }: { source: CatalogSourceKind }) {
  const meta = BADGES[source];
  return (
    <span
      className={cn(
        "shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5",
        meta.tone,
      )}
      title={`Source: ${meta.label}`}
    >
      {meta.label}
    </span>
  );
}
