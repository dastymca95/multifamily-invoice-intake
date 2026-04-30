/**
 * Phase 3N — Frontend ↔ backend export readiness boundary adapter.
 *
 * Bridges the Phase 3L local boundary types and the Phase 3M
 * backend contract:
 *
 *   * ``buildBackendExportReadinessBoundaryRequest`` — projects the
 *     panel's current diagnostic state (result + preview + active
 *     profile validation + parity + source) into the small backend
 *     ``ExportReadinessBoundaryInput`` snapshot. NEVER sends raw
 *     resolver output, raw profile, or raw rows — boundary
 *     evaluation only needs status / source labels.
 *   * ``backendBoundaryToLocalShape`` — projects the backend
 *     response back into the local ``ExportReadinessBoundary`` so
 *     the existing Phase 3L UI components + Markdown report
 *     helpers keep rendering without rewrites.
 *   * ``BACKEND_BOUNDARY_SOURCE_COPY`` + ``backendBoundarySourceMarker``
 *     — operator-facing copy for the Backend boundary verified /
 *     Local boundary estimate banner + report markers.
 *
 * Design rules:
 *   * Pure / synchronous — no React, no DOM, no fetch.
 *   * Never mutates the inputs.
 *   * Diagnostic only — ``production_export_ready`` is hard-pinned
 *     to ``false`` regardless of what the backend returns.
 *     ``production_export_status`` is hard-pinned to ``"unavailable"``
 *     in the local-shape conversion if the backend ever sent a
 *     forward-compat value the local Literal can't represent.
 *   * Never weakens backend reasons — unknown reason codes from a
 *     forward-compat backend are FILTERED OUT of the closed local
 *     Literal set so the UI can't crash on render. The backend
 *     Markdown reports still see the full backend message text.
 */

import type { OperationalResolutionResult } from "@/types/operational-resolution";
import type {
  BackendExportReadinessBoundaryInput,
  BackendExportReadinessBoundaryRequest,
  BackendExportReadinessBoundaryResult,
} from "@/types/export-readiness-boundary";

import type { ExportProfile } from "./export-profile-contract";
import type { OperationalExportPreview } from "./operational-export-preview";
import type { ExportProfileValidationResult } from "./export-profile-validation";
import type { ExportProfileValidationSource } from "./export-profile-backend-adapter";
import type { ExportValidationParityResult } from "./export-validation-parity";
import type {
  ExportDiagnosticStatus,
  ExportReadinessBoundary,
  ExportReadinessBoundaryReason,
  ProductionExportStatus,
} from "./export-readiness-boundary";

// ---------------------------------------------------------------------------
// Public — request builder
// ---------------------------------------------------------------------------

export interface BuildBackendExportReadinessBoundaryRequestArgs {
  result: OperationalResolutionResult | null;
  exportPreview: OperationalExportPreview | null;
  /** The validation result the panel is currently DISPLAYING (the
   *  active source — backend-adapted when verified, otherwise
   *  local). The boundary classifier respects the displayed verdict. */
  activeProfileValidation: ExportProfileValidationResult | null;
  parityResult: ExportValidationParityResult | null;
  /** Phase 3J source label — gates ``clear`` on the backend
   *  boundary classifier (must be ``backend`` for clear). */
  validationSource: ExportProfileValidationSource;
  /** Kept for caller ergonomics (the panel passes the same
   *  inputs to the validation hook). Persistence accounting is
   *  driven by ``hasPersistedProfile`` below, NOT by inspecting
   *  the profile object — a built-in starter looks identical to a
   *  saved profile contract once it's been resolved. */
  selectedProfile?: ExportProfile | null;
  /** Phase 4B — true when the operator's selected profile came
   *  from the Phase 4A backend catalog. Drives the
   *  ``has_persisted_profile`` field on the backend boundary
   *  request so the backend can drop
   *  ``no_export_profile_persistence`` from its reasons list.
   *  Defaults to ``false`` for built-in starters. */
  hasPersistedProfile?: boolean;
}

/**
 * Build the backend ``evaluate`` request payload from the panel's
 * current diagnostic state. Pure — never mutates the inputs.
 *
 * Sends ONLY the small status snapshot the boundary classifier
 * needs. NEVER sends raw resolver result, raw profile, raw rows,
 * raw documents, or raw extracted facts.
 */
export function buildBackendExportReadinessBoundaryRequest(
  args: BuildBackendExportReadinessBoundaryRequestArgs,
): BackendExportReadinessBoundaryRequest {
  const {
    result,
    exportPreview,
    activeProfileValidation,
    parityResult,
    validationSource,
  } = args;

  const operational_status =
    typeof result?.operational_summary?.status === "string"
      ? result.operational_summary.status
      : null;

  const profile_validation_status = activeProfileValidation?.status ?? null;

  // Parity is forward-compat already on the backend; pass the raw
  // status string verbatim. ``not_checked`` is a valid backend
  // value — the backend treats it as "aligned-or-absent" so a
  // local-only run still flows through cleanly.
  const parity_status = parityResult?.status ?? null;

  // Phase 4B — driven by the picker. ``true`` only when the
  // operator selected a profile from the Phase 4A backend
  // catalog; built-in starters keep this ``false`` so the
  // backend boundary correctly retains the
  // ``no_export_profile_persistence`` reason for those.
  const has_persisted_profile = args.hasPersistedProfile ?? false;

  const input: BackendExportReadinessBoundaryInput = {
    operational_status,
    profile_validation_status,
    parity_status,
    validation_source: validationSource,
    has_result: !!result,
    has_preview_rows: !!exportPreview && exportPreview.row_count > 0,
    has_persisted_profile,
  };
  return { input };
}

// ---------------------------------------------------------------------------
// Public — response adapter (backend → local UI shape)
// ---------------------------------------------------------------------------

/**
 * Project the backend response into the existing local
 * ``ExportReadinessBoundary`` shape so the Phase 3L UI panel +
 * Markdown report helpers stay untouched.
 *
 * Hard-pins ``production_export_ready`` to ``false`` and
 * ``production_export_status`` to ``"unavailable"`` if the backend
 * ever sends a forward-compat value the local Literal can't
 * represent. The backend Pydantic ``Literal`` types guarantee these
 * today — this is defence in depth.
 */
export function backendBoundaryToLocalShape(
  backend: BackendExportReadinessBoundaryResult,
): ExportReadinessBoundary {
  return {
    diagnostic_status: _toLocalDiagnosticStatus(backend.diagnostic_status),
    production_export_status: _toLocalProductionExportStatus(
      backend.production_export_status,
    ),
    // Hard pin — even if the backend somehow returned ``true``
    // (Pydantic Literal makes that impossible today, but defence
    // in depth is cheap), the local shape stays ``false``.
    production_export_ready: false,
    diagnostic_only: true,
    reasons: _filterKnownReasons(backend.reasons),
    operator_title: backend.operator_title,
    operator_message: backend.operator_message,
    developer_message: backend.developer_message,
    next_steps: [...backend.next_steps],
    disclaimers: [...backend.disclaimers],
  };
}

// ---------------------------------------------------------------------------
// Public — UI source labels
// ---------------------------------------------------------------------------

export type ExportReadinessBoundarySource =
  | "backend"
  | "local"
  | "loading"
  | "unavailable";

export interface ExportReadinessBoundarySourceCopy {
  title: string;
  detail: string;
  /** Tone bucket — drives the small banner colour. */
  tone: "success" | "info" | "warning" | "neutral";
}

/**
 * Operator-facing copy for the boundary source banner. Plain
 * phrasing — never claims production export readiness regardless
 * of source. The detail lines always reaffirm "production export
 * remains unavailable" so the operator can never misread a
 * "Backend boundary verified" green pill as "ready to export".
 */
export const BACKEND_BOUNDARY_SOURCE_COPY: Record<
  ExportReadinessBoundarySource,
  ExportReadinessBoundarySourceCopy
> = {
  backend: {
    title: "Backend boundary verified",
    detail:
      "Rivera backend confirmed this is diagnostic-only and production " +
      "export remains unavailable.",
    tone: "success",
  },
  loading: {
    title: "Checking backend export boundary…",
    detail: "Showing local boundary estimate while backend verifies.",
    tone: "info",
  },
  local: {
    title: "Local boundary estimate only",
    detail:
      "Backend boundary check failed. Showing local boundary estimate. " +
      "Production export remains unavailable.",
    tone: "warning",
  },
  unavailable: {
    title: "Local boundary estimate only",
    detail:
      "This boundary has not been verified by the backend. Production " +
      "export remains unavailable.",
    tone: "neutral",
  },
};

/**
 * Single-line source marker for Markdown reports. Keeps the
 * boundary section honest about whether the verdict is backend-
 * verified or the frontend's local estimate.
 */
export function backendBoundarySourceMarker(
  source: ExportReadinessBoundarySource,
): string {
  switch (source) {
    case "backend":
      return "Boundary source: Backend verified (Rivera diagnostic boundary endpoint).";
    case "loading":
      return "Boundary source: Local estimate (backend verification in flight).";
    case "local":
      return "Boundary source: Local estimate (backend boundary check failed).";
    case "unavailable":
      return "Boundary source: Local estimate (backend not consulted).";
  }
}

// ---------------------------------------------------------------------------
// Internals — narrowing helpers
// ---------------------------------------------------------------------------

const _LOCAL_DIAGNOSTIC_STATUSES: ReadonlySet<ExportDiagnosticStatus> = new Set<
  ExportDiagnosticStatus
>(["blocked", "needs_review", "clear", "not_available"]);

function _toLocalDiagnosticStatus(value: string): ExportDiagnosticStatus {
  if (_LOCAL_DIAGNOSTIC_STATUSES.has(value as ExportDiagnosticStatus)) {
    return value as ExportDiagnosticStatus;
  }
  // Forward-compat — anything novel maps to ``needs_review`` so the
  // operator sees a conservative pill rather than a crash.
  return "needs_review";
}

const _LOCAL_PRODUCTION_EXPORT_STATUSES: ReadonlySet<ProductionExportStatus> =
  new Set<ProductionExportStatus>([
    "unavailable",
    "not_configured",
    "not_authorized",
  ]);

function _toLocalProductionExportStatus(
  value: string,
): ProductionExportStatus {
  if (
    _LOCAL_PRODUCTION_EXPORT_STATUSES.has(value as ProductionExportStatus)
  ) {
    return value as ProductionExportStatus;
  }
  // Hard pin — anything outside the local Literal set (including
  // a hypothetical forward-compat ``"ready"``) collapses to
  // ``unavailable``. The boundary contract is still that production
  // export is not available.
  return "unavailable";
}

const _LOCAL_REASONS: ReadonlySet<ExportReadinessBoundaryReason> = new Set<
  ExportReadinessBoundaryReason
>([
  "diagnostic_only_pipeline",
  "no_export_engine",
  "no_export_profile_persistence",
  "no_export_batch_model",
  "no_file_generation",
  "no_final_approval_workflow",
  "no_export_audit_trail",
  "no_external_posting",
]);

function _filterKnownReasons(
  reasons: readonly string[],
): ExportReadinessBoundaryReason[] {
  // Filter to the closed local Literal set — drop forward-compat
  // unknowns silently rather than throwing or rendering garbage.
  // The backend Markdown report still surfaces the full reason
  // list verbatim via the source marker if needed.
  const out: ExportReadinessBoundaryReason[] = [];
  for (const r of reasons) {
    if (_LOCAL_REASONS.has(r as ExportReadinessBoundaryReason)) {
      out.push(r as ExportReadinessBoundaryReason);
    }
  }
  return out;
}
