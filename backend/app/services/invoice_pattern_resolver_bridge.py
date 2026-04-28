"""
Phase 2A — Invoice Pattern → ResolverInput bridge.

Deterministic, side-effect-free converter from a saved invoice
pattern (Invoice Builder concept) into a ``ResolverInput`` payload
the import-template resolver can consume (Import Builder concept).

Why a dedicated bridge instead of inlining this in the resolver:

  * Patterns describe WHERE on a bill canonical fields LIVE. The
    resolver needs ACTUAL VALUES. Without OCR / AI extraction (none
    of which is in scope for Phase 2A) the bridge cannot invent
    values — it can only forward operator-supplied manual values and
    pattern STRUCTURE (vendor hint, known field keys).
  * Surfacing the bridge as its own service keeps the runtime
    extraction surface (a Phase 3+ concern) clearly separated from
    the configuration surface. When real extraction lands, a thin
    wrapper around it can populate ``manual_fact_values`` with OCR
    output and the rest of the bridge stays unchanged.

What the bridge produces from one pattern:

  * ``ResolverInput.extracted_facts`` — one entry per
    ``manual_fact_values`` row, with ``source_type="manual"``. The
    ``field_key`` is the operator-supplied raw key; the resolver
    normalises through ``normalize_extracted_field_key`` (same
    registry the bridge uses) so legacy aliases flow correctly.
  * ``ResolverInput.catalog_hints`` — a ``vendor``/``property``/``gl``
    keyed dict of ``CatalogHint``. ``manual_catalog_hints`` may
    override / augment the pattern's ``vendor_hint``.
  * ``ResolverInput.pattern_matches`` — exactly one ``PatternMatch``
    entry for the selected pattern (confidence 1.0 because the
    operator picked it explicitly).
  * ``ResolverInput.document_metadata`` — diagnostic context
    (pattern id / name / vendor hint / source file count + names /
    known pattern field keys / bridge_source / bridge_version). Never
    carries PDF bytes or OCR text — strictly metadata.

What the bridge will NEVER do in Phase 2A:

  * No PDF reading, no OCR, no AI extraction.
  * No Review Queue / export / batch side effects.
  * No vendor → GL inference (the spec leaves that for a later phase
    once the vendor catalog tracks default GL hints).
  * No mutation of the pattern, the import template, or any DB row.

Compatibility:

  * ``pattern`` may be the ORM ``InvoicePattern`` model OR any
    duck-typed object with ``id`` / ``name`` / ``vendor_hint`` /
    ``source_files`` / ``regions`` / ``field_definitions``. Tests use
    the ORM model directly (no DB session needed — the bridge only
    READS attributes); production callers use the same.
  * Robust against legacy / partial rows — every helper uses
    ``.get()`` style access with defaults.
"""

from __future__ import annotations

from typing import Any, Iterable
from uuid import UUID

from app.domain.extracted_invoice_fields import (
    EXTRACTED_INVOICE_FIELDS,
    is_known_extracted_field_key,
    normalize_extracted_field_key,
)
from app.schemas.import_resolver import (
    CatalogHint,
    ExtractedFact,
    PatternMatch,
    ResolverInput,
)


BRIDGE_SOURCE = "invoice_pattern_resolver_bridge"
BRIDGE_VERSION = "phase_2a"

# The set of catalog-hint kinds the resolver currently understands.
# The bridge only emits hints for keys in this set (and their well-
# known aliases handled by ``_catalog_hint_for_kind`` in the resolver).
# Any unexpected ``manual_catalog_hints`` key is dropped silently
# rather than smuggled through — keeping the resolver input
# well-shaped.
_SUPPORTED_HINT_KINDS: frozenset[str] = frozenset({"vendor", "property", "gl"})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_resolver_input_from_invoice_pattern(
    pattern: Any,
    *,
    template_id: str | UUID | None = None,
    manual_fact_values: dict[str, Any] | None = None,
    manual_catalog_hints: dict[str, Any] | None = None,
    include_empty_fields: bool = False,
) -> ResolverInput:
    """Map one invoice pattern into a ``ResolverInput``.

    Parameters
    ----------
    pattern:
        The invoice pattern (ORM ``InvoicePattern`` model or a
        duck-typed object exposing the same attributes). The bridge
        reads ``id`` / ``name`` / ``vendor_hint`` / ``source_files`` /
        ``regions`` / ``field_definitions``. Anything missing is
        tolerated — the bridge falls back to safe defaults.
    template_id:
        Optional. Echoed onto ``ResolverInput.template_id`` when
        provided. UUIDs are stringified so the JSON payload is wire-
        safe; strings pass through unchanged.
    manual_fact_values:
        Operator-supplied ``field_key → value`` mapping. Each entry
        becomes one ``ExtractedFact`` with
        ``source_type="manual"`` and ``confidence=1.0``. Field keys
        flow through the shared alias registry, so ``amount`` lands
        as ``normalized_field_key="total_amount"`` — exactly what the
        resolver expects.
    manual_catalog_hints:
        Operator-supplied catalog hints, keyed by ``vendor`` /
        ``property`` / ``gl``. Values may be strings (becomes
        ``CatalogHint(text=str)``) or dicts (passed through as a
        ``CatalogHint`` after key whitelisting). The vendor hint
        OVERRIDES ``pattern.vendor_hint`` when present.
    include_empty_fields:
        When True, the bridge surfaces pattern field keys that have
        no manual value via ``document_metadata.unfilled_pattern_fields``.
        Defaults to False to avoid noisy advisory output. Empty
        fields are NEVER materialised as ``ExtractedFact`` rows
        (that would lie about extraction having happened).

    Returns
    -------
    ResolverInput
        Populated from operator intent + pattern structure. Safe to
        feed straight into ``dry_run_resolve_import_template``.
    """
    extracted_facts = _build_extracted_facts(
        manual_fact_values, pattern_id=_pattern_id_as_str(pattern)
    )
    catalog_hints = _build_catalog_hints(
        pattern_vendor_hint=_safe_str(getattr(pattern, "vendor_hint", None)),
        manual_catalog_hints=manual_catalog_hints,
    )
    document_metadata = _build_document_metadata(
        pattern,
        manual_fact_values=manual_fact_values or {},
        include_empty_fields=include_empty_fields,
    )
    pattern_matches = _build_pattern_matches(pattern)

    return ResolverInput(
        template_id=_normalize_template_id(template_id),
        extracted_facts=extracted_facts,
        catalog_hints=catalog_hints,
        document_metadata=document_metadata,
        pattern_matches=pattern_matches,
    )


# ---------------------------------------------------------------------------
# Extracted facts
# ---------------------------------------------------------------------------


def _build_extracted_facts(
    manual_fact_values: dict[str, Any] | None,
    *,
    pattern_id: str | None,
) -> list[ExtractedFact]:
    """Convert ``manual_fact_values`` into ``ExtractedFact`` rows.

    Empty / blank string values are skipped — the resolver treats a
    blank as "no value" and we don't want to spam the dry-run with
    fake "missing" diagnostics for fields the operator clearly left
    untouched. ``None`` is also skipped for the same reason.

    The raw key is preserved on ``field_key`` (so legacy aliases like
    ``amount`` show up verbatim in the dry-run trace); the resolver's
    own ``ExtractedFact.normalized_field_key`` validator then computes
    the canonical key — there's no need for the bridge to pre-fill it.
    """
    if not manual_fact_values:
        return []
    facts: list[ExtractedFact] = []
    for raw_key, raw_value in manual_fact_values.items():
        if not isinstance(raw_key, str):
            # Skip non-string keys — the resolver expects str field
            # keys. Defensive against accidental tuple/None keys
            # produced by buggy frontends.
            continue
        key = raw_key.strip()
        if not key:
            continue
        if raw_value is None:
            continue
        if isinstance(raw_value, str) and raw_value.strip() == "":
            continue
        facts.append(
            ExtractedFact(
                field_key=key,
                value=raw_value,
                source_type="manual",
                confidence=1.0,
                pattern_id=pattern_id,
                provenance_label="manual override (bridge)",
            )
        )
    return facts


# ---------------------------------------------------------------------------
# Catalog hints
# ---------------------------------------------------------------------------


def _build_catalog_hints(
    *,
    pattern_vendor_hint: str | None,
    manual_catalog_hints: dict[str, Any] | None,
) -> dict[str, CatalogHint]:
    """Assemble the ``catalog_hints`` dict.

    Sources, in precedence order:

      1. ``manual_catalog_hints`` — operator typed it explicitly,
         this wins.
      2. ``pattern.vendor_hint`` — informational free-text label on
         the pattern. Becomes ``catalog_hints["vendor"].text`` when
         no explicit manual vendor hint was supplied.

    Property and GL have no pattern-side fallback in Phase 2A — the
    pattern row doesn't carry property / GL identification fields.
    """
    out: dict[str, CatalogHint] = {}

    # Pattern-derived vendor hint (lowest precedence). Skipped when the
    # pattern didn't carry one.
    if pattern_vendor_hint:
        out["vendor"] = CatalogHint(text=pattern_vendor_hint)

    # Manual hints — override pattern-derived values per kind.
    for raw_kind, raw_value in (manual_catalog_hints or {}).items():
        kind = _normalize_hint_kind(raw_kind)
        if kind is None:
            # Unknown / unsupported kind — silently drop. The resolver
            # itself does fuzzy alias matching for known aliases like
            # "vendors" → "vendor", but the bridge stays strict to
            # keep the wire payload predictable.
            continue
        hint = _normalize_catalog_hint(raw_value)
        if hint is None:
            # Empty / None value — skip rather than emit an empty
            # CatalogHint (the resolver would treat it as
            # "no hint" anyway, but we'd rather not pollute the
            # payload).
            continue
        out[kind] = hint

    return out


def _normalize_hint_kind(raw: Any) -> str | None:
    """Normalize a raw hint key onto a supported kind."""
    if not isinstance(raw, str):
        return None
    kind = raw.strip().lower()
    if not kind:
        return None
    # Map well-known aliases onto canonical kinds. Mirrors the
    # resolver's own alias handling so bridge output looks identical
    # whether the operator typed "vendor" or "vendors".
    aliases = {
        "vendor": "vendor",
        "vendors": "vendor",
        "vendor_catalog": "vendor",
        "property": "property",
        "properties": "property",
        "property_catalog": "property",
        "gl": "gl",
        "gl_code": "gl",
        "gl_codes": "gl",
        "gl_catalog": "gl",
    }
    canonical = aliases.get(kind)
    if canonical is None:
        return None
    if canonical not in _SUPPORTED_HINT_KINDS:
        return None
    return canonical


def _normalize_catalog_hint(raw: Any) -> CatalogHint | None:
    """Coerce a raw hint value into a ``CatalogHint``.

    Accepts:

      * ``str`` — becomes ``CatalogHint(text=str)`` after strip.
      * ``dict`` — whitelisted to ``entry_id`` / ``text`` /
        ``field_values`` and constructed through the Pydantic model
        so the same validation runs as on a wire payload.
      * Everything else returns ``None`` — keep the bridge surface
        narrow.
    """
    if isinstance(raw, CatalogHint):
        return raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        return CatalogHint(text=text)
    if isinstance(raw, dict):
        entry_id = raw.get("entry_id")
        text = raw.get("text")
        field_values = raw.get("field_values") or {}
        # Drop empty strings on text/entry_id so callers can pass {}
        # without producing an empty hint.
        cleaned_entry = (
            entry_id.strip() if isinstance(entry_id, str) else entry_id
        )
        cleaned_text = text.strip() if isinstance(text, str) else text
        if not cleaned_entry and not cleaned_text and not field_values:
            return None
        return CatalogHint(
            entry_id=cleaned_entry or None,
            text=cleaned_text or None,
            field_values=dict(field_values) if field_values else {},
        )
    return None


# ---------------------------------------------------------------------------
# Pattern matches
# ---------------------------------------------------------------------------


def _build_pattern_matches(pattern: Any) -> list[PatternMatch]:
    """Emit a single ``PatternMatch`` representing the chosen pattern.

    Confidence is hard-1.0 because the operator picked it explicitly
    via the bridge. The PatternMatch ``reason`` carries
    ``"manual_selection"`` so downstream surfaces can distinguish
    operator-picked patterns from auto-detected ones in a later
    phase.
    """
    pattern_id = _pattern_id_as_str(pattern)
    if not pattern_id:
        return []
    return [
        PatternMatch(
            pattern_id=pattern_id,
            pattern_label=_safe_str(getattr(pattern, "name", None)),
            confidence=1.0,
            matched=True,
            reason="manual_selection",
        )
    ]


# ---------------------------------------------------------------------------
# Document metadata
# ---------------------------------------------------------------------------


def _build_document_metadata(
    pattern: Any,
    *,
    manual_fact_values: dict[str, Any],
    include_empty_fields: bool,
) -> dict[str, Any]:
    """Assemble the diagnostic context bag.

    Never carries PDF bytes / OCR text / large data URLs — strictly
    lightweight metadata so the resolver dry-run + downstream UI
    surfaces have something to display in the "Source" column without
    paying for the heavy payload.
    """
    pattern_id = _pattern_id_as_str(pattern)
    pattern_name = _safe_str(getattr(pattern, "name", None))
    vendor_hint = _safe_str(getattr(pattern, "vendor_hint", None))
    source_files = list(getattr(pattern, "source_files", []) or [])
    source_file_names = _extract_source_file_names(source_files)
    known_pattern_fields = _iter_pattern_field_keys(pattern)

    metadata: dict[str, Any] = {
        "bridge_source": BRIDGE_SOURCE,
        "bridge_version": BRIDGE_VERSION,
        "invoice_pattern_id": pattern_id,
        "invoice_pattern_name": pattern_name,
        "vendor_hint": vendor_hint,
        "source_file_count": len(source_files),
        "source_file_names": source_file_names,
        "known_pattern_fields": known_pattern_fields,
    }

    if include_empty_fields:
        # Surface fields the pattern KNOWS ABOUT but that have no
        # manual value as advisory metadata. Critically NOT as
        # ExtractedFact rows — those would lie about extraction having
        # happened.
        manual_keys_normalized = {
            normalize_extracted_field_key(k)
            for k in manual_fact_values.keys()
            if isinstance(k, str)
        }
        metadata["unfilled_pattern_fields"] = [
            field_key
            for field_key in known_pattern_fields
            if normalize_extracted_field_key(field_key)
            not in manual_keys_normalized
        ]

    return metadata


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_str(value: Any) -> str | None:
    """Return ``str(value).strip() or None`` for non-empty inputs."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _pattern_id_as_str(pattern: Any) -> str | None:
    raw = getattr(pattern, "id", None)
    if raw is None:
        return None
    return str(raw)


def _normalize_template_id(template_id: str | UUID | None) -> str | None:
    if template_id is None:
        return None
    if isinstance(template_id, UUID):
        return str(template_id)
    text = str(template_id).strip()
    return text or None


def _extract_source_file_names(source_files: Iterable[Any]) -> list[str]:
    """Pull file names from the source_files list.

    Tolerates both Pydantic-modeled rows (``InvoicePatternSourceFile``)
    and raw JSONB dicts (the ORM stores them as dicts). Skips entries
    without a name. Order preserved.
    """
    out: list[str] = []
    for item in source_files:
        name: str | None = None
        if isinstance(item, dict):
            raw = item.get("file_name")
            if isinstance(raw, str):
                name = raw.strip()
        else:
            raw = getattr(item, "file_name", None)
            if isinstance(raw, str):
                name = raw.strip()
        if name:
            out.append(name)
    return out


def _iter_pattern_field_keys(pattern: Any) -> list[str]:
    """Collect the unique field keys the pattern declares.

    Sources:

      * ``regions[*].field_key`` — every region pins a canonical
        field; this is the strongest signal that the pattern has
        the layout knowledge to extract that key at runtime.
      * ``field_definitions[*].key`` (type=custom) — operator-coined
        custom fields. Surfaced so a downstream UI can show
        "this pattern can produce <custom field>" even if no region
        is drawn on it yet.

    The output list is sorted with canonical keys first (in the
    registry's order) then operator-coined customs alphabetically —
    deterministic so test snapshots are stable.
    """
    seen: set[str] = set()

    region_keys: list[str] = []
    for r in getattr(pattern, "regions", []) or []:
        raw_key = _read_attr_or_dict(r, "field_key")
        if not isinstance(raw_key, str):
            continue
        key = raw_key.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        region_keys.append(key)

    custom_keys: list[str] = []
    for d in getattr(pattern, "field_definitions", []) or []:
        kind = _read_attr_or_dict(d, "type")
        # Only surface customs here — built-in field_definitions are
        # color/label OVERRIDES of canonical fields, not new fields.
        if kind != "custom":
            continue
        raw_key = _read_attr_or_dict(d, "key")
        if not isinstance(raw_key, str):
            continue
        key = raw_key.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        custom_keys.append(key)

    # Sort: canonical-known keys first in REGISTRY order (mirrors
    # the registry's display order — operator-friendly: identity,
    # parties, dates, amounts, accounting hints), then non-canonical
    # region keys alphabetically, then customs alphabetically.
    # Region-only customs without a field_definitions entry naturally
    # land in the "unknown" bucket alphabetically.
    registry_index: dict[str, int] = {
        key: idx for idx, key in enumerate(EXTRACTED_INVOICE_FIELDS)
    }
    canonical = sorted(
        (k for k in region_keys if is_known_extracted_field_key(k)),
        key=lambda k: registry_index.get(
            normalize_extracted_field_key(k) or k, len(registry_index)
        ),
    )
    other_region = sorted(
        k for k in region_keys if not is_known_extracted_field_key(k)
    )
    return canonical + other_region + sorted(custom_keys)


def _read_attr_or_dict(item: Any, key: str) -> Any:
    """Return ``item[key]`` if dict-shaped, ``getattr(item, key)`` otherwise."""
    if isinstance(item, dict):
        return item.get(key)
    return getattr(item, key, None)
