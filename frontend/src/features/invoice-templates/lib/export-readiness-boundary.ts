/**
 * Phase 3L — Export Readiness Boundary contract.
 *
 * Single source of truth for the explicit gap between Rivera's
 * current diagnostic surfaces and a future production export
 * pipeline. Every diagnostic surface (Operational Preview, Review
 * Diagnostics, Export-style Rows Preview, Export Profile Check,
 * backend validation, parity audit, full report) routes through
 * this helper before claiming anything close to "ready".
 *
 * Hard contract:
 *
 *   * ``production_export_ready`` is **always false** in Phase 3L.
 *     There is no override. There is no "force ready" flag. The
 *     production export engine does not exist.
 *   * ``diagnostic_only`` is hard-True throughout.
 *   * ``production_export_status`` may be ``unavailable`` /
 *     ``not_configured`` / ``not_authorized`` — never ``ready``.
 *   * The helper NEVER mutates inputs, NEVER calls APIs, NEVER
 *     touches the DOM.
 *
 * Naming convention: every public type starts with
 * ``ExportReadiness*`` so a future production export contract can
 * mirror these shapes without renames.
 */

import type { OperationalResolutionResult } from "@/types/operational-resolution";

import type { ExportProfile } from "./export-profile-contract";
import type { OperationalExportPreview } from "./operational-export-preview";
import type { ExportProfileValidationResult } from "./export-profile-validation";
import type { ExportProfileValidationSource } from "./export-profile-backend-adapter";
import type { ExportValidationParityResult } from "./export-validation-parity";

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

/**
 * Coarse diagnostic verdict for the operator — answers "what does
 * the diagnostic stack think of this preview?" without ever
 * implying the preview can be exported in production.
 */
export type ExportDiagnosticStatus =
  | "blocked"
  | "needs_review"
  | "clear"
  | "not_available";

/**
 * Coarse production-export verdict. Phase 3L hard-pins this away
 * from anything that resembles "ready" because there is no
 * production engine to be ready for.
 */
export type ProductionExportStatus =
  | "unavailable"
  | "not_configured"
  | "not_authorized";

export type ExportReadinessBoundaryReason =
  | "diagnostic_only_pipeline"
  | "no_export_engine"
  | "no_export_profile_persistence"
  | "no_export_batch_model"
  | "no_file_generation"
  | "no_final_approval_workflow"
  | "no_export_audit_trail"
  | "no_external_posting";

export interface ExportReadinessBoundary {
  diagnostic_status: ExportDiagnosticStatus;
  production_export_status: ProductionExportStatus;
  /** Hard-coded false in Phase 3L. */
  production_export_ready: false;
  /** Hard-coded true in Phase 3L. */
  diagnostic_only: true;
  reasons: ExportReadinessBoundaryReason[];
  /** Operator-facing one-line title for the panel banner. */
  operator_title: string;
  /** Operator-facing detail line. */
  operator_message: string;
  /** Engineer-facing message — used in Markdown reports + console.debug. */
  developer_message: string;
  /** Plain-language follow-up steps the operator / engineer can act on. */
  next_steps: string[];
  /** Disclaimers — always present. Used by reports + the panel
   *  small-print line. */
  disclaimers: string[];
}

// ---------------------------------------------------------------------------
// Public — main builder
// ---------------------------------------------------------------------------

export interface BuildExportReadinessBoundaryArgs {
  operationalResult: OperationalResolutionResult | null;
  exportPreview: OperationalExportPreview | null;
  /** The validation result the panel is currently DISPLAYING (the
   *  active source — backend-adapted when verified, otherwise
   *  local). The boundary respects the displayed verdict because
   *  that's what the operator is reading from. */
  activeProfileValidation: ExportProfileValidationResult | null;
  /** Optional parity audit. ``major_drift`` nudges the diagnostic
   *  status toward ``needs_review`` even when both validators
   *  individually say clear, because we don't trust either side
   *  enough to call it green. */
  parityResult: ExportValidationParityResult | null;
  /** The Phase 3J source label. Helps decide between
   *  ``not_available`` (no result at all) vs ``needs_review``
   *  (we have a result but only a local estimate). */
  validationSource: ExportProfileValidationSource;
  /** Optional active profile — kept in the contract for caller
   *  ergonomics (so the panel can pass the same inputs as it does
   *  to the validation hook). Profile-persistence accounting is
   *  driven by ``hasPersistedProfile`` below, NOT by inspecting
   *  the profile object. */
  selectedProfile?: ExportProfile | null;
  /** Phase 4B — true when the operator selected a SAVED profile
   *  from the Phase 4A backend catalog. Drops
   *  ``no_export_profile_persistence`` from the reasons list when
   *  set; defaults to ``false`` so the local helper agrees with
   *  the previous Phase 3L behaviour for built-in starters. */
  hasPersistedProfile?: boolean;
}

/**
 * Build the boundary contract from the current diagnostic state.
 * Always returns a valid result — never throws.
 */
export function buildExportReadinessBoundary(
  args: BuildExportReadinessBoundaryArgs,
): ExportReadinessBoundary {
  const {
    operationalResult,
    exportPreview,
    activeProfileValidation,
    parityResult,
    validationSource,
  } = args;

  // ---- Diagnostic status -------------------------------------------------
  // ``not_available`` — operator hasn't run the preview yet, or the
  // run produced nothing the validator can read.
  let diagnostic_status: ExportDiagnosticStatus;
  if (
    !operationalResult ||
    !exportPreview ||
    !exportPreview.can_preview_export
  ) {
    diagnostic_status = "not_available";
  } else if (!activeProfileValidation) {
    // Have a preview but no profile validation yet (e.g. backend
    // call still in flight on first render and no local fallback
    // produced — defensive). Defaults to needs_review so we don't
    // accidentally tell the operator everything's fine.
    diagnostic_status = "needs_review";
  } else if (
    activeProfileValidation.status === "blocked" ||
    activeProfileValidation.status === "conflict"
  ) {
    diagnostic_status = "blocked";
  } else if (activeProfileValidation.status === "needs_review") {
    diagnostic_status = "needs_review";
  } else {
    // ``clear`` from the active validator — but we still nudge to
    // ``needs_review`` if parity major-drifted, OR if we're on a
    // local fallback (Phase 3J source = "local" / "loading").
    if (parityResult?.status === "major_drift") {
      diagnostic_status = "needs_review";
    } else if (validationSource === "local" || validationSource === "loading") {
      // Local-only verdict on a "clear" report doesn't earn a
      // green check — backend hasn't verified.
      diagnostic_status = "needs_review";
    } else {
      diagnostic_status = "clear";
    }
  }

  // ---- Reasons -----------------------------------------------------------
  // Always-on reasons reflect the current architectural reality:
  // there is no production export engine, no file generation, no
  // export run record, no audit trail. The ALWAYS list is stable —
  // a future phase that adds (say) an audit trail will remove the
  // ``no_export_audit_trail`` entry, not flip any boolean here.
  const reasons: ExportReadinessBoundaryReason[] = [
    "diagnostic_only_pipeline",
    "no_export_engine",
    "no_file_generation",
    "no_export_audit_trail",
    "no_export_batch_model",
    "no_final_approval_workflow",
    "no_external_posting",
  ];
  // Profile persistence — Phase 4B exposes a saved-profile
  // catalog. When the operator selected a saved profile we drop
  // this reason so the boundary verdict reflects the catalog
  // existence; built-in starters still trigger it.
  if (!args.hasPersistedProfile) {
    reasons.push("no_export_profile_persistence");
  }

  // ---- Production export status -----------------------------------------
  // Phase 3L: every diagnostic state lands on ``unavailable``.
  // We model the type so a future phase that adds (e.g.) a not-yet-
  // configured-but-buildable engine can graduate to ``not_configured``
  // without churning the contract. ``ready`` is intentionally not
  // representable as an output here.
  const production_export_status: ProductionExportStatus = "unavailable";

  // ---- Operator + developer messaging -----------------------------------
  let operator_title: string;
  let operator_message: string;
  switch (diagnostic_status) {
    case "blocked":
      operator_title = "Diagnostic blocked · Production export unavailable";
      operator_message =
        "The diagnostic checks above flagged blocking issues. Resolve them before any future production export, but note that production export is not available in this build either way.";
      break;
    case "needs_review":
      operator_title = "Needs review · Production export unavailable";
      operator_message =
        "The diagnostic checks above flagged items that need review. Production export is not available in this build either way.";
      break;
    case "clear":
      operator_title = "Diagnostic clear · Production export unavailable";
      operator_message =
        "Diagnostic checks above are clear. Production export is intentionally not available — Rivera has not generated an export file or created an export run.";
      break;
    case "not_available":
    default:
      operator_title = "No diagnostic data · Production export unavailable";
      operator_message =
        "Run the operational preview to inspect diagnostic readiness. Production export is not available in this build.";
      break;
  }

  const developer_message =
    "Production export readiness is intentionally unavailable until the export engine, persisted profiles, export runs, and final approval workflow exist.";

  // ---- Next steps + disclaimers -----------------------------------------
  const next_steps: string[] = [
    "Configure persisted export profiles backed by a profile catalog model.",
    "Add an export run / batch model with an audit trail.",
    "Add a final approval workflow before any external posting.",
    "Add controlled file generation behind explicit operator approval.",
  ];
  if (diagnostic_status === "blocked") {
    next_steps.unshift(
      "Resolve the blocked diagnostic issues surfaced above before retrying.",
    );
  } else if (diagnostic_status === "needs_review") {
    next_steps.unshift(
      "Confirm the needs-review items above before relying on this preview.",
    );
  }

  const disclaimers: string[] = [
    "Diagnostic clear does not mean production export ready.",
    "No export file was generated.",
    "No Review Queue records were created.",
    "No document, batch, template, or reference data was modified.",
  ];

  return {
    diagnostic_status,
    production_export_status,
    production_export_ready: false,
    diagnostic_only: true,
    reasons,
    operator_title,
    operator_message,
    developer_message,
    next_steps,
    disclaimers,
  };
}

// ---------------------------------------------------------------------------
// Public — operator-facing labels (panel + reports)
// ---------------------------------------------------------------------------

export const EXPORT_DIAGNOSTIC_STATUS_LABEL: Record<
  ExportDiagnosticStatus,
  string
> = {
  blocked: "Diagnostic blocked",
  needs_review: "Needs review",
  clear: "Diagnostic clear",
  not_available: "No diagnostic data",
};

export const PRODUCTION_EXPORT_STATUS_LABEL: Record<
  ProductionExportStatus,
  string
> = {
  unavailable: "Not available",
  not_configured: "Not configured",
  not_authorized: "Not authorized",
};

export const EXPORT_READINESS_BOUNDARY_REASON_LABEL: Record<
  ExportReadinessBoundaryReason,
  string
> = {
  diagnostic_only_pipeline: "Diagnostic-only pipeline",
  no_export_engine: "No export engine",
  no_export_profile_persistence: "No persisted export profiles",
  no_export_batch_model: "No export run / batch model",
  no_file_generation: "No export file generation",
  no_final_approval_workflow: "No final approval workflow",
  no_export_audit_trail: "No export run / audit trail",
  no_external_posting: "No external posting (ResMan / Yardi / AppFolio)",
};
