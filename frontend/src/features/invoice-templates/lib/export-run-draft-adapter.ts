/**
 * Phase 4G — Frontend ↔ backend Export Run Draft adapter.
 *
 * Bridges the panel's diagnostic state into the small Phase 4F
 * backend snapshot, plus the operator-facing source-marker copy
 * for the new Export Run Draft section + the full report.
 *
 * Design rules:
 *
 *   * Pure / synchronous — no React, no fetch, no DOM.
 *   * Never mutates the inputs.
 *   * Diagnostic only — the request body is intentionally tiny
 *     (status labels, IDs, row counts). NEVER sends raw resolver
 *     output, raw rows, raw documents, raw extracted facts, or
 *     anything PII-sized.
 *   * Phase 3O regression — the response is hard-pinned away from
 *     forbidden export handles. The adapter additionally never
 *     populates ``selected_profile_id`` from a non-profile id, so
 *     ``profile_id`` semantics stay sharp.
 */

import type { OperationalResolutionResult } from "@/types/operational-resolution";
import type {
  BackendExportRunDraftInput,
  BackendExportRunDraftRequest,
} from "@/types/export-run-draft";

import type { OperationalExportPreview } from "./operational-export-preview";
import type { ExportProfile } from "./export-profile-contract";
import type { ExportProfileValidationResult } from "./export-profile-validation";
import type { ExportProfileValidationSource } from "./export-profile-backend-adapter";
import type { ExportReadinessBoundary } from "./export-readiness-boundary";
import type { ExportProfileSelectionOption } from "./export-profile-selection";

// ---------------------------------------------------------------------------
// Public — request builder
// ---------------------------------------------------------------------------

export interface BuildBackendExportRunDraftRequestArgs {
  result: OperationalResolutionResult | null;
  exportPreview: OperationalExportPreview | null;
  /** The selector option the operator picked (Phase 4B). Drives
   *  ``selected_profile_source`` + ``selected_profile_id`` on the
   *  wire. */
  selectedExportOption: ExportProfileSelectionOption | null;
  /** The active profile contract (Phase 4B). Used for
   *  ``context.profile_label`` only — the wire payload doesn't
   *  ship the full contract. */
  selectedExportProfile: ExportProfile | null;
  /** Active profile validation verdict (Phase 3J). */
  activeProfileValidation: ExportProfileValidationResult | null;
  /** Active readiness boundary (Phase 3L/3N). */
  activeReadinessBoundary: ExportReadinessBoundary | null;
  /** Phase 3J source label. Echoed inside ``context``. */
  activeValidationSource: ExportProfileValidationSource;
  /** Phase 3N boundary source label. Echoed inside ``context``. */
  activeBoundarySource: string;
  /** Phase 3K parity audit status. Echoed inside ``context`` when
   *  available. */
  parityStatus?: string | null;
}

/**
 * Build the backend ``evaluate`` request payload from the panel's
 * current diagnostic state. Pure — never mutates the inputs.
 *
 * Sends ONLY status labels + IDs + row counts. NEVER sends raw
 * resolver result, raw profile, raw rows, raw documents, raw
 * extracted facts, raw catalog hints, or any PII-sized payload.
 * The backend re-classifies from these signals; it does NOT load
 * any persisted record from the IDs.
 */
export function buildBackendExportRunDraftRequest(
  args: BuildBackendExportRunDraftRequestArgs,
): BackendExportRunDraftRequest {
  const {
    result,
    exportPreview,
    selectedExportOption,
    selectedExportProfile,
    activeProfileValidation,
    activeReadinessBoundary,
    activeValidationSource,
    activeBoundarySource,
    parityStatus,
  } = args;

  // ---- IDs (pure echo, no synthesis) -----------------------------------
  // The OperationalResolutionResult shape has top-level template /
  // pattern / document / batch ids. Anything missing falls through
  // as null — the backend treats null as "not provided" and never
  // attempts a lookup.
  const operational_result_id =
    typeof (result as { id?: unknown } | null)?.id === "string"
      ? ((result as { id?: string }).id as string)
      : null;
  const template_id = result?.template_id ?? null;
  const document_id = result?.document_id ?? null;
  const batch_id = result?.batch_id ?? null;

  // ---- Profile selection ----------------------------------------------
  let selected_profile_id: string | null = null;
  let selected_profile_source: string | null = null;
  if (selectedExportOption) {
    selected_profile_source = selectedExportOption.source;
    if (selectedExportOption.source === "saved") {
      selected_profile_id = selectedExportOption.persisted_profile_id;
    } else if (selectedExportOption.source === "built_in") {
      // Built-in id is informational only — labelled as built_in
      // so the backend marks the draft "profile_not_persisted".
      selected_profile_id = selectedExportOption.builtin_profile_id;
    }
  }

  const profile_validation_status =
    activeProfileValidation?.status ?? null;
  const readiness_diagnostic_status =
    activeReadinessBoundary?.diagnostic_status ?? null;

  // ---- Row + issue counts ---------------------------------------------
  // Phase 4H — every count is coerced through ``_normalizeCount`` so
  // NaN / Infinity / negative inputs land at 0 on the wire. Backend
  // accepts any int and won't crash, but normalising here keeps the
  // request body honest and the audit logs sane.
  const export_preview_row_count = _normalizeCount(exportPreview?.row_count);
  const blocked_row_count = _normalizeCount(exportPreview?.blocked_row_count);
  const warning_row_count = _normalizeCount(exportPreview?.warning_row_count);
  const export_preview_issue_count = _normalizeCount(
    exportPreview?.summary?.cells_with_issues,
  );

  // ---- production_export_ready ----------------------------------------
  // The Phase 3L/3N boundary is hard-pinned to ``false``. The
  // backend ignores the value anyway; we forward what the panel
  // shows.
  const production_export_ready =
    activeReadinessBoundary?.production_export_ready ?? false;

  // ---- Context echo (small + diagnostic only) -------------------------
  // Phase 3O regression: only safe diagnostic metadata. NO raw
  // PDFs, NO row payload, NO file IDs, NO download URLs.
  // Phase 4H — context is built fresh AND then routed through
  // ``sanitizeExportRunDraftContext`` so any future addition that
  // accidentally introduces a forbidden key is silently dropped
  // before the wire.
  const rawContext: Record<string, unknown> = {
    validation_source: activeValidationSource,
    boundary_source: activeBoundarySource,
  };
  if (selectedExportOption) {
    rawContext.profile_option_id = selectedExportOption.option_id;
    rawContext.profile_label = selectedExportOption.label;
    if (selectedExportOption.source === "saved") {
      rawContext.profile_version = selectedExportOption.version;
    }
  }
  if (selectedExportProfile) {
    rawContext.profile_target_system = selectedExportProfile.target_system;
  }
  if (exportPreview) {
    rawContext.export_preview_status = exportPreview.status;
    rawContext.export_preview_columns = _normalizeCount(
      exportPreview.summary?.column_count,
    );
  }
  if (parityStatus) {
    rawContext.parity_status = parityStatus;
  }
  const context = sanitizeExportRunDraftContext(rawContext);

  const input: BackendExportRunDraftInput = {
    operational_result_id,
    template_id,
    document_id,
    batch_id,
    selected_profile_id,
    selected_profile_source,
    profile_validation_status,
    readiness_diagnostic_status,
    production_export_ready,
    export_preview_row_count,
    export_preview_issue_count,
    blocked_row_count,
    warning_row_count,
    context,
  };
  return { input };
}

// ---------------------------------------------------------------------------
// Phase 4H — Public — context whitelist + count normalization
// ---------------------------------------------------------------------------

/**
 * The closed whitelist of context keys the draft endpoint is
 * allowed to receive. Anything else is silently dropped by
 * ``sanitizeExportRunDraftContext``.
 *
 * Forbidden keys (Phase 3O regression) — ``download_url`` /
 * ``file_url`` / ``file_id`` / ``export_id`` / ``export_run_id`` /
 * ``export_batch_id`` / ``posted_at`` / ``external_posting_id`` /
 * ``run_id`` / ``file`` / ``download`` — are never on this list,
 * so they cannot escape onto the wire even if a future caller
 * accidentally adds them to ``rawContext``.
 */
export const EXPORT_RUN_DRAFT_CONTEXT_ALLOWLIST: ReadonlySet<string> = new Set([
  "validation_source",
  "boundary_source",
  "profile_option_id",
  "profile_label",
  "profile_version",
  "profile_target_system",
  "export_preview_status",
  "export_preview_columns",
  "parity_status",
]);

/**
 * Drop every key from ``input`` that isn't in
 * ``EXPORT_RUN_DRAFT_CONTEXT_ALLOWLIST``. Pure — never mutates
 * the input. Used by the request builder so the wire payload is
 * provably safe against forbidden export / file / posting handles
 * leaking from the panel state.
 */
export function sanitizeExportRunDraftContext(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!EXPORT_RUN_DRAFT_CONTEXT_ALLOWLIST.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Coerce a number-ish value to a non-negative finite integer.
 *
 *   * ``null`` / ``undefined`` / non-numeric → 0
 *   * NaN / +Infinity / -Infinity → 0
 *   * negative → 0
 *   * fractional → floored
 *
 * Pure. Used by the request builder for every row / issue / column
 * count so the wire body stays internally consistent even when an
 * upstream memo briefly produced a transient bad value.
 */
export function _normalizeCount(value: unknown): number {
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Public — UI source labels
// ---------------------------------------------------------------------------

export type ExportRunDraftSource =
  | "backend"
  | "loading"
  | "unavailable"
  | "error";

export interface ExportRunDraftSourceCopy {
  /** Headline for the section banner. */
  title: string;
  /** Operator-facing detail line. */
  detail: string;
  tone: "success" | "info" | "warning" | "neutral";
}

/**
 * Operator-facing copy for the draft section banner. Plain
 * phrasing — never claims production-export readiness regardless
 * of source. The detail lines always reaffirm "production export
 * remains unavailable" so an operator can never misread a green
 * "Backend evaluated" pill as "ready to export".
 */
export const EXPORT_RUN_DRAFT_SOURCE_COPY: Record<
  ExportRunDraftSource,
  ExportRunDraftSourceCopy
> = {
  backend: {
    title: "Backend draft evaluated",
    detail:
      "Rivera backend evaluated this draft. Diagnostic only — no " +
      "export file was generated and no export run was finalized.",
    tone: "success",
  },
  loading: {
    title: "Evaluating export draft…",
    detail: "Rivera is asking the backend to evaluate this draft.",
    tone: "info",
  },
  error: {
    title: "Could not evaluate export draft",
    detail:
      "Backend draft evaluation failed. Operational Preview remains " +
      "diagnostic. Production export is unavailable either way.",
    tone: "warning",
  },
  unavailable: {
    title: "Draft evaluation unavailable",
    detail:
      "Run an operational preview with export-style rows and select " +
      "a saved profile before evaluating an export draft.",
    tone: "neutral",
  },
};

/**
 * Phase 4H — Stale-aware source label. The hook flips ``stale=true``
 * when a fresh request is in flight (or just failed) AND the panel
 * is still showing the previously-evaluated data. The marker copy
 * makes that visible to the operator + to paste-into-Slack
 * recipients of the full report.
 */
export interface ExportRunDraftStaleAwareSource {
  source: ExportRunDraftSource;
  stale: boolean;
}

/**
 * Operator-facing copy for the stale-aware source banner. When
 * ``stale=true`` the title / detail explicitly call out that the
 * verdict the operator is reading was evaluated EARLIER, not now.
 */
export const EXPORT_RUN_DRAFT_STALE_SOURCE_COPY: Record<
  ExportRunDraftSource,
  ExportRunDraftSourceCopy
> = {
  backend: EXPORT_RUN_DRAFT_SOURCE_COPY.backend,
  loading: {
    title: "Refreshing export draft…",
    detail:
      "Showing last evaluated draft while Rivera refreshes this " +
      "draft. Production export remains unavailable.",
    tone: "info",
  },
  error: {
    title: "Could not refresh export draft",
    detail:
      "Showing last evaluated draft because the latest draft check " +
      "failed. Production export remains unavailable.",
    tone: "warning",
  },
  unavailable: EXPORT_RUN_DRAFT_SOURCE_COPY.unavailable,
};

/**
 * Pick the right source-copy bucket. When ``stale`` is true AND
 * the source is loading / error, use the stale-aware copy; in
 * every other state the regular copy is correct.
 */
export function pickExportRunDraftSourceCopy(
  source: ExportRunDraftSource,
  stale: boolean,
): ExportRunDraftSourceCopy {
  if (stale && (source === "loading" || source === "error")) {
    return EXPORT_RUN_DRAFT_STALE_SOURCE_COPY[source];
  }
  return EXPORT_RUN_DRAFT_SOURCE_COPY[source];
}

/**
 * Single-line operator-facing marker for Markdown reports. Honest
 * about whether the draft section was backend-evaluated or fell
 * back to a "not evaluated" state.
 *
 * Phase 4H — accepts an optional ``stale`` flag so the report
 * marker can announce "last-known-good while refreshing" / "after
 * failed refresh" cases without changing the source enum.
 */
export function exportRunDraftSourceMarker(
  source: ExportRunDraftSource,
  stale: boolean = false,
): string {
  if (stale && source === "loading") {
    return (
      "Draft source: Backend evaluated, last-known-good while " +
      "refreshing."
    );
  }
  if (stale && source === "error") {
    return (
      "Draft source: Backend evaluated, last-known-good after " +
      "failed refresh."
    );
  }
  switch (source) {
    case "backend":
      return "Draft source: Backend evaluated (Rivera diagnostic draft endpoint).";
    case "loading":
      return "Draft source: Evaluating backend draft.";
    case "error":
      return "Draft source: Draft evaluation failed.";
    case "unavailable":
      return "Draft source: Draft evaluation unavailable.";
  }
}
