/**
 * Phase 4B — Export Profile selection model.
 *
 * Bridges the Phase 3F built-in profile factories and the Phase 4A
 * persisted profile catalog into a single picker option model the
 * panel can render + validate against.
 *
 * Design rules:
 *
 *   * Pure / synchronous — no React, no fetch.
 *   * Never mutates inputs.
 *   * Stable option ids: ``saved:<uuid>`` for persisted profiles,
 *     ``builtin:<profile_id>`` for built-ins. The panel persists the
 *     prefixed id so saved + built-in selections can't collide and
 *     a previous selection survives profile-list refreshes.
 *   * Diagnostic only — selecting any option still flows through
 *     the existing diagnostic validation pipeline; no production
 *     export side effects.
 */

import type {
  PersistedExportProfileContractResponse,
  PersistedExportProfileSummary,
} from "@/types/export-profile-persistence";

import type { ExportProfile } from "./export-profile-contract";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExportProfileSelectionSource = "saved" | "built_in";

export interface ExportProfileSelectionOptionBase {
  /** Stable selector id — namespaced so saved + built-in cannot
   *  collide. ``saved:<uuid>`` or ``builtin:<id>``. */
  option_id: string;
  source: ExportProfileSelectionSource;
  label: string;
  target_system: string;
  description: string | null;
  /** Indicates the option is the recommended default to pre-select
   *  when the operator hasn't picked one yet. Only saved profiles
   *  flagged ``is_default`` carry this today. */
  is_default: boolean;
}

export interface ExportProfileSelectionSavedOption
  extends ExportProfileSelectionOptionBase {
  source: "saved";
  persisted_profile_id: string;
  version: number;
  /** Inactive saved profiles are excluded from the picker by the
   *  list hook today, but the field is kept for forward-compat. */
  is_active: boolean;
}

export interface ExportProfileSelectionBuiltInOption
  extends ExportProfileSelectionOptionBase {
  source: "built_in";
  /** The Phase 3F factory's profile id (``builtin:custom-csv-mirror``
   *  etc.). Captured separately from ``option_id`` so a future
   *  rename of the built-in factory id leaves the selector stable. */
  builtin_profile_id: string;
  /** Eager contract — built-ins are pure code, no fetch needed. */
  contract: ExportProfile;
}

export type ExportProfileSelectionOption =
  | ExportProfileSelectionSavedOption
  | ExportProfileSelectionBuiltInOption;

/** Operator-facing source-marker for reports. */
export interface ExportProfileSourceMarkerArgs {
  option: ExportProfileSelectionOption | null;
  /** When true and the source is ``"saved"``, the host is showing
   *  the contract loaded from the backend ``getContract`` call.
   *  When false, the host is rendering with a fallback (e.g. the
   *  contract fetch failed); the report should say so. */
  contractAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Public — option builders
// ---------------------------------------------------------------------------

const SAVED_OPTION_PREFIX = "saved:";
const BUILTIN_OPTION_PREFIX = "builtin:";

export function buildSavedOptionId(profileId: string): string {
  return `${SAVED_OPTION_PREFIX}${profileId}`;
}

export function buildBuiltInOptionId(builtinProfileId: string): string {
  return `${BUILTIN_OPTION_PREFIX}${builtinProfileId}`;
}

export function isSavedOptionId(optionId: string | null): boolean {
  return !!optionId && optionId.startsWith(SAVED_OPTION_PREFIX);
}

export function isBuiltInOptionId(optionId: string | null): boolean {
  return !!optionId && optionId.startsWith(BUILTIN_OPTION_PREFIX);
}

/** Strip the ``saved:`` / ``builtin:`` namespace and return the raw
 *  underlying id. Returns ``null`` for unrecognised inputs so a
 *  caller can detect a stale selection cleanly. */
export function unwrapOptionId(optionId: string | null): string | null {
  if (!optionId) return null;
  if (optionId.startsWith(SAVED_OPTION_PREFIX)) {
    return optionId.slice(SAVED_OPTION_PREFIX.length);
  }
  if (optionId.startsWith(BUILTIN_OPTION_PREFIX)) {
    return optionId.slice(BUILTIN_OPTION_PREFIX.length);
  }
  return null;
}

/**
 * Project a backend ``ExportProfileSummary`` into a saved selector
 * option. Pure — no API calls; the contract is loaded separately
 * by ``usePersistedExportProfileContract`` on selection.
 */
export function buildSavedOption(
  summary: PersistedExportProfileSummary,
): ExportProfileSelectionSavedOption {
  return {
    option_id: buildSavedOptionId(summary.id),
    source: "saved",
    label: summary.name,
    target_system: summary.target_system,
    description: summary.description,
    is_default: summary.is_default,
    persisted_profile_id: summary.id,
    version: summary.version,
    is_active: summary.is_active,
  };
}

/**
 * Project a Phase 3F built-in ``ExportProfile`` into a built-in
 * selector option. The contract is captured eagerly — built-ins
 * are pure code so no fetch is needed.
 */
export function buildBuiltInOption(
  profile: ExportProfile,
): ExportProfileSelectionBuiltInOption {
  return {
    option_id: buildBuiltInOptionId(profile.id),
    source: "built_in",
    label: profile.name,
    target_system: profile.target_system,
    description: profile.description ?? null,
    is_default: false,
    builtin_profile_id: profile.id,
    contract: profile,
  };
}

// ---------------------------------------------------------------------------
// Public — combine + select default
// ---------------------------------------------------------------------------

export interface BuildExportProfileSelectionOptionsArgs {
  savedSummaries: PersistedExportProfileSummary[];
  builtInProfiles: ExportProfile[];
}

export interface ExportProfileSelectionOptions {
  /** All saved options (from the backend list). May be empty. */
  saved: ExportProfileSelectionSavedOption[];
  /** All built-in options (from the Phase 3F factories). */
  builtIn: ExportProfileSelectionBuiltInOption[];
  /** Saved followed by built-in — the order the picker renders. */
  combined: ExportProfileSelectionOption[];
}

/**
 * Build the full option model. Saved profiles render first (the
 * picker groups them visibly); built-ins follow as fallback /
 * starter options.
 *
 * Filters inactive saved profiles defensively even though the list
 * hook already passes ``is_active=true`` — keeps the selector
 * resilient to a future backend change that returns inactive rows.
 */
export function buildExportProfileSelectionOptions(
  args: BuildExportProfileSelectionOptionsArgs,
): ExportProfileSelectionOptions {
  const saved = args.savedSummaries
    .filter((s) => s.is_active)
    .map(buildSavedOption);
  const builtIn = args.builtInProfiles.map(buildBuiltInOption);
  return {
    saved,
    builtIn,
    combined: [...saved, ...builtIn],
  };
}

/**
 * Default selector id. Picks (in order):
 *
 *   1. The saved profile flagged ``is_default``, if any.
 *   2. The first saved profile, if any.
 *   3. The Custom CSV mirror built-in (``builtin:custom-csv-mirror``)
 *      if present in the built-in list.
 *   4. The first built-in option, if any.
 *   5. ``null`` when both lists are empty.
 *
 * Only used as a SUGGESTION when the panel doesn't already have a
 * selection — the operator's prior pick wins via ``resolveSelectedOption``.
 */
export function defaultExportProfileOptionId(
  options: ExportProfileSelectionOptions,
): string | null {
  const savedDefault = options.saved.find((o) => o.is_default);
  if (savedDefault) return savedDefault.option_id;
  if (options.saved.length > 0) return options.saved[0]!.option_id;
  const customMirror = options.builtIn.find(
    (o) => o.builtin_profile_id === "builtin:custom-csv-mirror",
  );
  if (customMirror) return customMirror.option_id;
  if (options.builtIn.length > 0) return options.builtIn[0]!.option_id;
  return null;
}

/**
 * Resolve the operator-supplied selector id against the combined
 * options. Falls back to the default option id when the selection
 * is missing OR no longer present (e.g. a saved profile was
 * soft-deleted between renders).
 *
 * Returns ``null`` only when both lists are empty.
 */
export function resolveSelectedOption(
  options: ExportProfileSelectionOptions,
  selectedOptionId: string | null,
): ExportProfileSelectionOption | null {
  if (selectedOptionId) {
    const match = options.combined.find(
      (o) => o.option_id === selectedOptionId,
    );
    if (match) return match;
  }
  const fallbackId = defaultExportProfileOptionId(options);
  if (!fallbackId) return null;
  return (
    options.combined.find((o) => o.option_id === fallbackId) ?? null
  );
}

/**
 * Phase 4E — Detect when the operator-requested SAVED selection
 * is no longer present in the catalog (e.g. the profile was
 * deactivated in another tab and a refresh just dropped it from
 * the list). The Operational Preview picker uses this to surface
 * a one-line warning + auto-fall-back to the resolved option.
 *
 * Returns ``true`` when:
 *   * ``requestedOptionId`` looks like a saved option id
 *     (``saved:<uuid>``), AND
 *   * the resolver substituted a different option (or returned
 *     ``null`` because both lists are empty).
 *
 * Returns ``false`` when:
 *   * the requested id is null,
 *   * the requested id is a built-in starter id (those can't go
 *     stale; the factories are code-shipped),
 *   * the resolver returned the EXACT same id the operator
 *     requested.
 *
 * Pure / synchronous. No DOM, no fetch, no React.
 */
export function isStaleSavedSelection(
  requestedOptionId: string | null,
  resolved: ExportProfileSelectionOption | null,
): boolean {
  if (!requestedOptionId) return false;
  if (!isSavedOptionId(requestedOptionId)) return false;
  if (!resolved) return true;
  return resolved.option_id !== requestedOptionId;
}

// ---------------------------------------------------------------------------
// Public — contract resolution
// ---------------------------------------------------------------------------

/**
 * Return the active ``ExportProfile`` contract for the selected
 * option:
 *
 *   * Built-in option → its eager ``contract`` field.
 *   * Saved option + ``savedContract`` provided → ``savedContract``.
 *   * Saved option WITHOUT ``savedContract`` → ``null`` (the panel
 *     should render a "Loading saved profile contract…" state OR
 *     fall back to a built-in option's contract).
 */
export function resolveSelectedExportProfileContract(
  selected: ExportProfileSelectionOption | null,
  savedContract: ExportProfile | null,
): ExportProfile | null {
  if (!selected) return null;
  if (selected.source === "built_in") return selected.contract;
  return savedContract ?? null;
}

// ---------------------------------------------------------------------------
// Public — source marker for Markdown reports
// ---------------------------------------------------------------------------

/**
 * Single-line operator-facing marker for the Copy profile check /
 * Copy full report sections. Honest about whether the selected
 * profile is a saved catalog row or a built-in starter, AND about
 * a loading-state fallback (the saved contract hasn't arrived yet).
 */
export function exportProfileSourceMarker(
  args: ExportProfileSourceMarkerArgs,
): string {
  const { option, contractAvailable } = args;
  if (!option) {
    return "Profile source: none selected.";
  }
  if (option.source === "built_in") {
    return `Profile source: Built-in starter (${option.builtin_profile_id}).`;
  }
  // Saved.
  const versionTag = `v${option.version}`;
  const defaultTag = option.is_default ? " · default" : "";
  if (!contractAvailable) {
    return (
      `Profile source: Saved profile (id=${option.persisted_profile_id}, ${versionTag}${defaultTag}) ` +
      "— contract not yet loaded; report rendered against fallback."
    );
  }
  return `Profile source: Saved profile (id=${option.persisted_profile_id}, ${versionTag}${defaultTag}).`;
}
