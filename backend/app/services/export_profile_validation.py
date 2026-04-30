"""
Phase 3I — Backend Export Profile validation service.

Pure deterministic validator that walks an ``ExportPreviewInput``
against an ``ExportProfile`` and emits an ``ExportProfileValidationResult``.

What this module IS:
  * The canonical backend export profile validation contract —
    intended to become the source of truth in front of the future
    production export phase.
  * Pure / synchronous — no DB, no I/O, no side effects.
  * Mirror of the Phase 3F frontend validator (same issue codes,
    same severity rules, same status verdicts) so frontend +
    backend can converge later without contract drift.

What this module is NOT:
  * NOT an export file generator.
  * NOT a profile persistence layer.
  * NOT a side-effecting export pipeline.

Hard contract:
  * Never weakens an upstream cell verdict — a ``blocked`` /
    ``conflict`` cell on a required column always emits a blocking
    issue.
  * Treats ``None`` / undefined / empty trimmed string as missing.
    NEVER treats ``0`` or ``False`` as missing — they are valid
    domain values for amount / boolean columns.
  * Unknown cell statuses degrade to ``warning`` (forward-compat).
  * Empty preview is ``blocked`` with code
    ``PROFILE_PREVIEW_HAS_NO_ROWS``.

Status verdict (overall):
  * ``conflict`` if any ``PROFILE_CELL_CONFLICT`` issue exists.
  * ``blocked`` if any ``blocked``-severity issue exists otherwise.
  * ``needs_review`` if any ``warning``-severity issue exists.
  * ``clear`` otherwise.

This split lets the response distinguish "the resolver flagged a
conflict that has to be resolved manually" from "a required column
is simply missing", even though both surface as blocking severity.
"""

from __future__ import annotations

import re
from datetime import datetime

from app.schemas.export_profile import (
    ExportPreviewCellInput,
    ExportPreviewColumnInput,
    ExportPreviewInput,
    ExportPreviewRowInput,
    ExportProfile,
    ExportProfileColumn,
    ExportProfileColumnResult,
    ExportProfileIssue,
    ExportProfileIssueSeverity,
    ExportProfileRowResult,
    ExportProfileValidationResult,
    ExportProfileValidationStatus,
    ExportProfileValidationSummary,
)


__all__ = [
    "validate_export_preview_against_profile",
    "find_preview_column_for_profile_column",
    "normalize_column_label",
    "normalize_profile_issue_severity",
    "get_profile_severity_rank",
]


# ---------------------------------------------------------------------------
# Public — column matcher
# ---------------------------------------------------------------------------


def normalize_column_label(value: str | None) -> str:
    """Case-fold, replace ``_-`` with spaces, collapse whitespace, trim."""
    if not value:
        return ""
    s = str(value).lower()
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def find_preview_column_for_profile_column(
    profile_column: ExportProfileColumn,
    preview_columns: list[ExportPreviewColumnInput],
) -> ExportPreviewColumnInput | None:
    """Three-tier match: exact key → normalised label → alias.

    Returns ``None`` when nothing matches. No fuzzy matching, no AI.
    """
    # Tier 1 — exact key match.
    if profile_column.source_column_key:
        for c in preview_columns:
            if c.key == profile_column.source_column_key:
                return c

    # Tier 2 + 3 — normalised label / alias match.
    targets: set[str] = set()
    if profile_column.source_column_label:
        targets.add(normalize_column_label(profile_column.source_column_label))
    targets.add(normalize_column_label(profile_column.label))
    for alias in profile_column.match_aliases:
        targets.add(normalize_column_label(alias))
    targets.discard("")
    if not targets:
        return None
    for c in preview_columns:
        n = normalize_column_label(c.label)
        if n and n in targets:
            return c
    return None


# ---------------------------------------------------------------------------
# Public — severity helpers
# ---------------------------------------------------------------------------


def normalize_profile_issue_severity(raw: str | None) -> ExportProfileIssueSeverity:
    """Coerce arbitrary severity string into the four-band vocabulary.

    Unknown values degrade to ``warning`` — the validator never
    crashes on a forward-compat extension.
    """
    if raw in ("blocked", "warning", "info", "clear"):
        return raw  # type: ignore[return-value]
    return "warning"


def get_profile_severity_rank(severity: ExportProfileIssueSeverity) -> int:
    """Lower = worse. Used by ``_max_severity``."""
    return {"blocked": 0, "warning": 1, "info": 2, "clear": 3}[severity]


def _max_severity(
    a: ExportProfileIssueSeverity,
    b: ExportProfileIssueSeverity,
) -> ExportProfileIssueSeverity:
    return a if get_profile_severity_rank(a) <= get_profile_severity_rank(b) else b


# ---------------------------------------------------------------------------
# Public — top-level validator
# ---------------------------------------------------------------------------


def validate_export_preview_against_profile(
    profile: ExportProfile,
    preview: ExportPreviewInput,
) -> ExportProfileValidationResult:
    """Walk the preview and emit a deterministic validation result."""
    issues: list[ExportProfileIssue] = []
    column_results: list[ExportProfileColumnResult] = []

    # Per-row + per-column issue rollup. Tuple is (count, worst).
    row_rollup: dict[int, tuple[int, ExportProfileIssueSeverity]] = {}
    col_rollup: dict[str, tuple[int, ExportProfileIssueSeverity]] = {}

    def push(issue: ExportProfileIssue) -> None:
        issues.append(issue)
        if issue.row_index is not None:
            cur_c, cur_w = row_rollup.get(issue.row_index, (0, "clear"))
            row_rollup[issue.row_index] = (
                cur_c + 1,
                _max_severity(cur_w, issue.severity),
            )
        if issue.profile_column_key:
            cur_c, cur_w = col_rollup.get(issue.profile_column_key, (0, "clear"))
            col_rollup[issue.profile_column_key] = (
                cur_c + 1,
                _max_severity(cur_w, issue.severity),
            )

    # -- Empty preview short-circuit -----------------------------------------
    # Either no rows OR no columns means there's nothing to validate
    # against. Per spec this is BLOCKED with PROFILE_PREVIEW_HAS_NO_ROWS.
    # We still walk the profile columns below so column_results is
    # populated for the report, but every required column will also
    # surface as PROFILE_REQUIRED_COLUMN_MISSING — the caller can
    # distinguish via the issue codes.
    if len(preview.rows) == 0 or len(preview.columns) == 0:
        push(
            ExportProfileIssue(
                severity="blocked",
                code="PROFILE_PREVIEW_HAS_NO_ROWS",
                message="The preview has no rows to validate.",
                recommendation=(
                    "Run a preview with enough invoice facts and template "
                    "rules to produce export-style rows."
                ),
            )
        )

    # -- Per-column walk -----------------------------------------------------
    for profile_column in profile.columns:
        matched = find_preview_column_for_profile_column(
            profile_column, preview.columns
        )
        column_results.append(
            ExportProfileColumnResult(
                profile_column_key=profile_column.key,
                profile_column_label=profile_column.label,
                matched=matched is not None,
                matched_preview_column_key=matched.key if matched else None,
                matched_preview_column_label=matched.label if matched else None,
                required=profile_column.required,
                # filled in below from col_rollup
                issue_count=0,
                worst_severity="clear",
            )
        )

        if not matched:
            if profile_column.required:
                push(
                    ExportProfileIssue(
                        severity="blocked",
                        code="PROFILE_REQUIRED_COLUMN_MISSING",
                        message=(
                            f'Required column "{profile_column.label}" is '
                            f"not in the preview."
                        ),
                        recommendation=(
                            "Add the column to the Import Template, or change "
                            "the export profile to not require it."
                        ),
                        profile_column_key=profile_column.key,
                    )
                )
            else:
                push(
                    ExportProfileIssue(
                        severity="info",
                        code="PROFILE_COLUMN_UNMAPPED",
                        message=(
                            f'Optional column "{profile_column.label}" is '
                            f"not in the preview."
                        ),
                        recommendation=(
                            "Add the column to the Import Template, or accept "
                            "the gap if your downstream system doesn't need it."
                        ),
                        profile_column_key=profile_column.key,
                    )
                )
            continue

        # Walk every preview row's cell for this matched column.
        for row in preview.rows:
            cell = _find_cell(row, matched.key)
            _validate_cell(
                row=row,
                cell=cell,
                profile_column=profile_column,
                matched_key=matched.key,
                profile_date_format=(
                    profile_column.format or profile.settings.date_format
                ),
                push=push,
            )

    # -- Roll up per-column issue counts onto column_results ------------------
    for cr in column_results:
        rollup = col_rollup.get(cr.profile_column_key)
        if rollup:
            cr.issue_count, cr.worst_severity = rollup

    # -- Build per-row results -----------------------------------------------
    row_results: list[ExportProfileRowResult] = []
    for row in preview.rows:
        rollup = row_rollup.get(row.row_index)
        row_results.append(
            ExportProfileRowResult(
                row_index=row.row_index,
                issue_count=rollup[0] if rollup else 0,
                worst_severity=rollup[1] if rollup else "clear",
            )
        )

    # -- Summary counts ------------------------------------------------------
    blocked_count = sum(1 for i in issues if i.severity == "blocked")
    warning_count = sum(1 for i in issues if i.severity == "warning")
    info_count = sum(1 for i in issues if i.severity == "info")
    matched_columns = sum(1 for c in column_results if c.matched)
    unmatched_columns = len(column_results) - matched_columns
    rows_with_issues = sum(1 for r in row_results if r.issue_count > 0)
    blocked_rows = sum(1 for r in row_results if r.worst_severity == "blocked")

    summary = ExportProfileValidationSummary(
        total_issues=len(issues),
        blocked_count=blocked_count,
        warning_count=warning_count,
        info_count=info_count,
        row_count=len(preview.rows),
        column_count=len(preview.columns),
        matched_column_count=matched_columns,
        unmatched_column_count=unmatched_columns,
        rows_with_issues=rows_with_issues,
        blocked_rows=blocked_rows,
    )

    # -- Overall status ------------------------------------------------------
    # Per spec:
    #   conflict     — any PROFILE_CELL_CONFLICT issue exists
    #   blocked      — any other blocked-severity issue exists
    #   needs_review — any warning-severity issue exists
    #   clear        — otherwise
    has_conflict = any(i.code == "PROFILE_CELL_CONFLICT" for i in issues)
    status: ExportProfileValidationStatus
    if has_conflict:
        status = "conflict"
    elif blocked_count > 0:
        status = "blocked"
    elif warning_count > 0:
        status = "needs_review"
    else:
        status = "clear"

    return ExportProfileValidationResult(
        diagnostic_only=True,
        profile_id=profile.id,
        profile_name=profile.name,
        target_system=profile.target_system,
        status=status,
        summary=summary,
        issues=issues,
        column_results=column_results,
        row_results=row_results,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _find_cell(
    row: ExportPreviewRowInput, column_key: str
) -> ExportPreviewCellInput | None:
    for c in row.cells:
        if c.column_key == column_key:
            return c
    return None


def _is_missing_value(cell: ExportPreviewCellInput) -> bool:
    """Treat ``None`` / undefined / empty-trimmed string as missing.

    NEVER treats ``0`` or ``False`` as missing — those are valid
    domain values for amount / boolean columns.
    """
    # Cell-status hint takes precedence — explicit ``missing`` always
    # wins regardless of value (resolver may have synthesized the
    # cell with a placeholder display_value).
    if cell.status == "missing":
        return True
    v = cell.value
    if v is None:
        # Fall back to display_value — caller may have only sent the
        # display text without a typed value.
        if cell.display_value is None:
            return True
        return cell.display_value.strip() == ""
    if isinstance(v, str):
        return v.strip() == ""
    # 0, False, [] — explicitly NOT missing.
    return False


def _cell_text(cell: ExportPreviewCellInput) -> str:
    """Best-effort textual form for format / length / allowed-value checks."""
    if cell.display_value is not None:
        return str(cell.display_value)
    if cell.value is None:
        return ""
    return str(cell.value)


def _validate_cell(
    *,
    row: ExportPreviewRowInput,
    cell: ExportPreviewCellInput | None,
    profile_column: ExportProfileColumn,
    matched_key: str,
    profile_date_format: str,
    push,
) -> None:
    base_ref = dict(
        row_index=row.row_index,
        column_key=matched_key,
        profile_column_key=profile_column.key,
        source_column_key=matched_key,
    )

    # ---- No cell at all ----------------------------------------------------
    # Resolver omitted this column for this row. Required → blocked,
    # optional → quiet (we already note the column is mapped).
    if cell is None:
        if profile_column.required:
            push(
                ExportProfileIssue(
                    severity="blocked",
                    code="PROFILE_REQUIRED_VALUE_MISSING",
                    message=(
                        f'Required column "{profile_column.label}" has no '
                        f"cell on row {row.row_index + 1}."
                    ),
                    recommendation=(
                        "Provide a default value, fix the rule, or supply "
                        "the missing extracted fact / catalog hint."
                    ),
                    **base_ref,
                )
            )
        return

    # ---- Resolver-side hard verdicts (never weakened) ----------------------
    status = cell.status
    if status == "blocked":
        push(
            ExportProfileIssue(
                severity="blocked",
                code="PROFILE_CELL_BLOCKED",
                message=(
                    f'"{profile_column.label}" is blocked on row '
                    f"{row.row_index + 1}."
                ),
                recommendation=(
                    "Fix the underlying resolver issue (see the Review "
                    "Diagnostics)."
                ),
                **base_ref,
            )
        )
        return
    if status == "conflict":
        push(
            ExportProfileIssue(
                severity="blocked",
                code="PROFILE_CELL_CONFLICT",
                message=(
                    f'"{profile_column.label}" has a conflict on row '
                    f"{row.row_index + 1}."
                ),
                recommendation=(
                    "Resolve the conflicting source values before exporting."
                ),
                **base_ref,
            )
        )
        return
    if status in ("warning", "needs_review"):
        push(
            ExportProfileIssue(
                severity="warning",
                code="PROFILE_CELL_NEEDS_REVIEW",
                message=(
                    f'"{profile_column.label}" needs review on row '
                    f"{row.row_index + 1}."
                ),
                recommendation=(
                    "Confirm the value before exporting — see the Review "
                    "Diagnostics."
                ),
                **base_ref,
            )
        )
        # Don't return — still run optional format checks below.
    elif status not in (
        "clear",
        "ready",
        "missing",
        "ignored",
    ):
        # Forward-compat — unknown statuses degrade to warning rather
        # than crash. Keeps the validator resilient to future
        # additions to ``ExportPreviewCellStatus``.
        push(
            ExportProfileIssue(
                severity="warning",
                code="PROFILE_CELL_NEEDS_REVIEW",
                message=(
                    f'"{profile_column.label}" on row {row.row_index + 1} '
                    f"has unknown status \"{status}\"."
                ),
                recommendation=(
                    "Confirm the resolver output is using a recognised "
                    "cell status."
                ),
                **base_ref,
            )
        )

    # ---- Required + missing -----------------------------------------------
    is_missing = _is_missing_value(cell)
    if profile_column.required and is_missing:
        push(
            ExportProfileIssue(
                severity="blocked",
                code="PROFILE_REQUIRED_VALUE_MISSING",
                message=(
                    f'Required column "{profile_column.label}" is missing '
                    f"on row {row.row_index + 1}."
                ),
                recommendation=(
                    "Provide a default value, fix the rule, or supply the "
                    "missing extracted fact / catalog hint."
                ),
                **base_ref,
            )
        )
        return

    # Optional + missing — nothing more to validate.
    if is_missing:
        return

    value_text = _cell_text(cell)

    # ---- Data-type checks (best-effort) -----------------------------------
    if profile_column.data_type == "date":
        if not _looks_like_date(value_text, profile_date_format):
            push(
                ExportProfileIssue(
                    severity="warning",
                    code="PROFILE_DATE_FORMAT_CHECK_FAILED",
                    message=(
                        f'"{profile_column.label}" on row '
                        f"{row.row_index + 1} doesn't look like a date."
                    ),
                    recommendation=(
                        "Confirm the value is a valid date in the profile's "
                        "date format, or update the column's data type."
                    ),
                    **base_ref,
                )
            )
    elif profile_column.data_type in ("amount", "decimal", "integer"):
        if not _looks_like_number(value_text, profile_column.data_type):
            push(
                ExportProfileIssue(
                    severity="warning",
                    code="PROFILE_AMOUNT_FORMAT_CHECK_FAILED",
                    message=(
                        f'"{profile_column.label}" on row '
                        f"{row.row_index + 1} doesn't look numeric."
                    ),
                    recommendation=(
                        "Confirm the value is a number, or update the "
                        "column's data type / format rule."
                    ),
                    **base_ref,
                )
            )

    # ---- Allowed values check ---------------------------------------------
    if profile_column.allowed_values:
        lowered = value_text.lower()
        matches = any(a.lower() == lowered for a in profile_column.allowed_values)
        if not matches:
            push(
                ExportProfileIssue(
                    severity=("blocked" if profile_column.required else "warning"),
                    code="PROFILE_ALLOWED_VALUE_FAILED",
                    message=(
                        f'"{profile_column.label}" on row '
                        f"{row.row_index + 1} is not one of the allowed values."
                    ),
                    recommendation=(
                        "Use one of: " + ", ".join(profile_column.allowed_values) + "."
                    ),
                    **base_ref,
                )
            )

    # ---- Max length check -------------------------------------------------
    if (
        profile_column.max_length is not None
        and len(value_text) > profile_column.max_length
    ):
        push(
            ExportProfileIssue(
                severity="warning",
                code="PROFILE_MAX_LENGTH_EXCEEDED",
                message=(
                    f'"{profile_column.label}" on row {row.row_index + 1} '
                    f"exceeds the profile's max length ({profile_column.max_length})."
                ),
                recommendation=(
                    "Trim the value, increase the profile's max length, or "
                    "change the source mapping."
                ),
                **base_ref,
            )
        )


# ---------------------------------------------------------------------------
# Format heuristics
# ---------------------------------------------------------------------------


_DATE_FORMAT_FALLBACKS: tuple[str, ...] = (
    "%Y-%m-%d",
    "%m/%d/%Y",
    "%m/%d/%y",
    "%-m/%-d/%Y",  # accepted by strptime on POSIX; harmless on Windows fallback
    "%d/%m/%Y",
    "%d-%m-%Y",
    "%Y/%m/%d",
)

_DATE_FORMAT_HINT_MAP: dict[str, str] = {
    "MM/DD/YYYY": "%m/%d/%Y",
    "M/D/YYYY": "%m/%d/%Y",
    "YYYY-MM-DD": "%Y-%m-%d",
    "DD/MM/YYYY": "%d/%m/%Y",
}


def _looks_like_date(value: str, format_hint: str) -> bool:
    """Best-effort. Accepts the profile's hint format OR a small set
    of common American/ISO digit-grouped fallbacks. Profile date_format
    is a HINT, not a hard parser — the future production exporter is
    responsible for strict parsing.
    """
    s = value.strip()
    if not s:
        return False
    # Quick digit-pattern shortcut so common forms (3/14/2026, 2026-03-14)
    # don't have to round-trip strptime.
    if re.match(r"^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$", s):
        return True
    hint = _DATE_FORMAT_HINT_MAP.get(format_hint)
    if hint:
        try:
            datetime.strptime(s, hint)
            return True
        except ValueError:
            pass
    for fmt in _DATE_FORMAT_FALLBACKS:
        try:
            datetime.strptime(s, fmt)
            return True
        except ValueError:
            continue
    return False


def _looks_like_number(value: str, kind: str) -> bool:
    """Best-effort. Accepts ``$1,234.56``, ``(99.50)`` (negative
    parens), and bare numerics. ``integer`` rejects fractional values.
    """
    cleaned = value.strip()
    if not cleaned:
        return False
    # Parens → negative.
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = "-" + cleaned[1:-1]
    cleaned = re.sub(r"[$,\s]", "", cleaned)
    if cleaned in ("", "-"):
        return False
    try:
        n = float(cleaned)
    except ValueError:
        return False
    if kind == "integer" and not float(n).is_integer():
        return False
    return True
