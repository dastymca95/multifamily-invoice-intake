"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import type { ReferenceKind, ReferenceSlot } from "@/types/reference";

import { getSlotState, useReferenceData } from "../hooks/useReferenceData";
import { ReferenceCard } from "./ReferenceCard";
import { ReferenceSourcePreviewPanel } from "./ReferenceSourcePreviewPanel";

interface ReferenceSourceWorkspaceProps {
  /**
   * The reference kinds this subpage owns, in display order. The first
   * kind is treated as the primary one (controls the "loading" / "no
   * slot" empty states); the rest stack underneath as related sources.
   *
   * One kind: side-by-side card + preview, fills available height.
   * Multiple kinds: vertical stack of (card | preview) sections, page
   * scrolls naturally — used when a subpage owns more than one closely
   * related source (e.g. Properties owns both `properties` and `units`).
   */
  kinds: ReferenceKind[];
  /**
   * Optional intro paragraph rendered above the first source. Each
   * subpage explains its own role in the pipeline so it reads as a
   * self-contained workspace, not a deep link into a shared overview.
   */
  intro?: ReactNode;
}

/**
 * Per-subpage Reference Data workspace.
 *
 * Replaces the previous shared "all four sources on one page" workspace
 * with a per-subpage shape — each subpage under Reference Data owns its
 * own kinds and renders only those, so the user feels like Properties /
 * Vendors / Invoice Template Builder are independent sections rather
 * than tabs over a single combined catalog.
 *
 * Reuses the existing `useReferenceData` hook + `ReferenceCard` +
 * `ReferenceSourcePreviewPanel` so the per-card upload / replace /
 * remove affordances and the parsed-source preview rendering stay
 * consistent across every subpage that uses this workspace.
 *
 * Layout decisions:
 *   * One source — fixed-width card on the left, full-height preview on
 *     the right; columns stack on narrow viewports.
 *   * Multiple sources — each gets a labelled section with its own
 *     card + preview row. Sections stack vertically and the page scrolls.
 */
export function ReferenceSourceWorkspace({
  kinds,
  intro,
}: ReferenceSourceWorkspaceProps) {
  const { slots, loading, loadError, slotStates, upload, remove, refresh } =
    useReferenceData();

  // Resolve kinds → slots in the requested order. Filter to only kinds
  // the backend actually surfaced; defensive against backend/frontend
  // drift on `REFERENCE_KINDS`.
  const sourcesInOrder = kinds
    .map((k) => slots.find((s) => s.kind === k) ?? null)
    .filter((s): s is ReferenceSlot => s != null);

  const isMulti = kinds.length > 1;

  if (loading && slots.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <p className="inline-flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </p>
      </div>
    );
  }

  return (
    <div
      className={
        isMulti
          ? "flex flex-col gap-6"
          : "flex flex-col gap-4 lg:h-full"
      }
    >
      {intro && <div className="max-w-4xl shrink-0">{intro}</div>}

      {loadError && (
        <div className="shrink-0">
          <InlineAlert
            tone="error"
            title="Couldn't load reference data"
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void refresh()}
              >
                Retry
              </Button>
            }
          >
            {loadError}
          </InlineAlert>
        </div>
      )}

      {/* Render one section per requested kind. Single-kind callers get
          the full-height layout; multi-kind callers get stacked sections
          with section headers so the user can tell the sources apart. */}
      {sourcesInOrder.map((slot, idx) => (
        <SourceSection
          key={slot.kind}
          slot={slot}
          state={getSlotState(slotStates, slot.kind)}
          onUpload={(f) => void upload(slot.kind, f)}
          onRemove={() => void remove(slot.kind)}
          /* Only show section headers in multi-kind layouts — a single
             source already gets its label from the card header. */
          showHeader={isMulti}
          /* Only the lone single-kind variant fills available height;
             stacked multi-kind sections size to their content. */
          fillHeight={!isMulti && idx === 0}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One source's card + preview row
// ---------------------------------------------------------------------------

function SourceSection({
  slot,
  state,
  onUpload,
  onRemove,
  showHeader,
  fillHeight,
}: {
  slot: ReferenceSlot;
  state: ReturnType<typeof getSlotState>;
  onUpload: (file: File) => void;
  onRemove: () => void;
  showHeader: boolean;
  fillHeight: boolean;
}) {
  const hasUpload = slot.current != null;

  return (
    <section
      className={
        fillHeight
          ? "flex flex-col gap-2 lg:flex-1 lg:min-h-0"
          : "flex flex-col gap-2"
      }
    >
      {showHeader && (
        <header className="shrink-0">
          <h2 className="text-sm font-semibold text-gray-800">{slot.label}</h2>
          <p className="text-[11.5px] text-gray-500 mt-0.5">
            {slot.description}
          </p>
        </header>
      )}

      <div
        className={
          fillHeight
            ? "grid gap-4 lg:flex-1 lg:min-h-0 lg:grid-cols-[20rem_1fr]"
            : "grid gap-4 lg:grid-cols-[20rem_1fr]"
        }
      >
        {/* Card — fixed-ish width on desktop, full width when stacked.
            Scrolls inside its own pane on the fill-height variant so a
            long parse-failure alert doesn't blow out the row height. */}
        <div className={fillHeight ? "lg:overflow-auto lg:min-h-0 lg:pr-1" : ""}>
          <ReferenceCard
            slot={slot}
            state={state}
            onUpload={onUpload}
            onRemove={onRemove}
            compact
          />
        </div>

        {/* Preview — fills remaining width on desktop. */}
        <div
          className={
            fillHeight ? "lg:min-h-0 min-h-[28rem]" : "min-h-[24rem]"
          }
        >
          <ReferenceSourcePreviewPanel
            selected={slot}
            hasAnyUploaded={hasUpload}
          />
        </div>
      </div>
    </section>
  );
}
