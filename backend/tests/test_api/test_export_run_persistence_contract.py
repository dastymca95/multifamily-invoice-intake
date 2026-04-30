"""
Phase 5E — Export Run persistence contract freeze regression
tests.

These tests pin the diagnostic / audit-only contract that the
persisted Export Runs surface (Phases 5A–5D) collectively
guarantees. They are NOT a re-litigation of per-rule classifier
coverage — those live in
``test_services/test_export_run_management.py`` and
``test_api/test_export_runs_drafts.py``.

What this file does:

  * Asserts ``id`` is the audit record id, NOT ``export_run_id``,
    on every endpoint that returns one. ``selected_profile_id`` /
    ``export_profile_id`` ARE allowed (catalog references).
  * Asserts the persisted ``draft_snapshot``'s hard-pinned literals
    (``draft_only=True`` / ``finalized=False`` /
    ``file_generated=False`` / ``download_available=False`` /
    ``production_export_ready=False``) hold even on the cleanest
    "draft_clear" path.
  * Asserts no forbidden export / file / posting / finalisation
    handle keys appear at any nesting depth in any response from
    POST / GET-by-id / GET-list (re-uses the Phase 3O
    ``assert_no_export_handles`` helper plus a Phase 5E-extended
    walker covering ``finalized_at`` / ``exported_at`` /
    ``external_system_id``).
  * Asserts PATCH is notes-only — sending any other field 422s
    AND the row's status / phase / snapshot are unchanged after a
    successful notes update.
  * Asserts the Phase 4F stateless evaluator endpoint
    (``/api/v1/export-run-drafts/evaluate``) STILL returns no
    ``id`` / ``export_run_id`` / ``export_id`` flavour.
  * Asserts the SQLAlchemy ``ExportRunRecord.__table__`` column
    set contains none of the forbidden field names — a future
    regression that adds e.g. ``file_id`` as a column is caught
    immediately.
  * Asserts the Alembic migration text contains none of the
    forbidden column names — defensive against a future migration
    that quietly adds a forbidden column.

What this file deliberately does NOT do:

  * Does NOT re-test per-rule classifier coverage.
  * Does NOT depend on internal payload field ordering.
  * Does NOT add brittle full-shape snapshots.
  * Does NOT touch documents / batches / templates / Review Queue
    tables — the persistence service never writes to those.

See also:
  * ``docs/export-run-persistence-contract.md`` — the canonical
    contract document this file enforces.
  * ``docs/export-run-draft-contract.md`` §11 — the persistence
    summary in the draft contract document.
  * ``docs/operational-preview-contract.md`` §8 — the broader
    Operational Preview hard boundaries this surface sits under.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from app.models.export_run import ExportRunRecord
from tests.test_api.test_operational_preview_contract import (
    FORBIDDEN_EXPORT_KEYS,
    assert_no_export_handles,
)


_PERSIST_ENDPOINT = "/api/v1/export-runs/drafts"
_LIST_ENDPOINT = "/api/v1/export-runs"
_EVALUATE_ENDPOINT = "/api/v1/export-run-drafts/evaluate"


# ---------------------------------------------------------------------------
# Phase 5E forbidden-key audit (extends the Phase 3O set)
# ---------------------------------------------------------------------------


# Phase 5A's persistence schema explicitly forbids these IN ADDITION
# to the Phase 3O set. Every wire-shape audit in this file walks
# the payload against the union so a future regression that adds
# any of the new finalisation-flavoured keys to the persistence
# response surfaces immediately.
PHASE_5E_EXTRA_FORBIDDEN_KEYS: frozenset[str] = frozenset(
    {
        "finalized_at",
        "exported_at",
        "external_system_id",
    }
)


PHASE_5E_FORBIDDEN_KEYS: frozenset[str] = (
    FORBIDDEN_EXPORT_KEYS | PHASE_5E_EXTRA_FORBIDDEN_KEYS
)


def assert_no_persistence_forbidden_keys(payload, *, path: str = "$") -> None:
    """Walk ``payload`` recursively. Fail loudly if any
    ``PHASE_5E_FORBIDDEN_KEYS`` member appears as a dict key.

    ``id`` is allowed — it IS the audit record id.
    ``selected_profile_id`` / ``export_profile_id`` are allowed.
    ``profile_id`` (echoed by the Phase 3I validator inside the
    request snapshot) is allowed.
    """
    if isinstance(payload, dict):
        for key, value in payload.items():
            assert key not in PHASE_5E_FORBIDDEN_KEYS, (
                f"Forbidden persistence handle key found at {path}.{key} — "
                "the Phase 5A persistence surface must not expose this. "
                "See docs/export-run-persistence-contract.md §5."
            )
            assert_no_persistence_forbidden_keys(
                value, path=f"{path}.{key}"
            )
    elif isinstance(payload, list):
        for idx, item in enumerate(payload):
            assert_no_persistence_forbidden_keys(
                item, path=f"{path}[{idx}]"
            )
    # Scalars short-circuit.


# ---------------------------------------------------------------------------
# Fixtures (kept tiny + local — mirrors the per-phase test files)
# ---------------------------------------------------------------------------


def _clear_input() -> dict:
    """Cleanest "draft_clear"-looking input — saved profile,
    clear validation, clear readiness, non-empty rows, no
    issues. Same shape as the Phase 5A API smoke tests so the
    contract regression exercises the same code path the Save
    Draft Audit Record button uses."""
    return {
        "selected_profile_id": "prof-saved-5e",
        "selected_profile_source": "saved",
        "profile_validation_status": "clear",
        "readiness_diagnostic_status": "clear",
        "export_preview_row_count": 5,
        "export_preview_issue_count": 0,
        "blocked_row_count": 0,
        "warning_row_count": 0,
    }


def _persist_clear(client, auth_headers) -> dict:
    """POST a fresh draft_clear record + return the response body."""
    resp = client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    return resp


# ---------------------------------------------------------------------------
# 1. POST creates a draft audit record
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_creates_draft_audit_record(client, auth_headers):
    """The persistence endpoint returns 201 with a draft audit
    record id, phase=draft, a valid status from the closed Phase
    5A set, and no forbidden handles at any depth."""
    response = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    # Audit record id is present and parses as UUID.
    assert "id" in body
    uuid.UUID(body["id"])
    assert body["phase"] == "draft"
    # Status is one of the closed Phase 5A vocabulary values.
    assert body["status"] in {"draft_clear", "needs_review", "blocked"}
    # No forbidden handles.
    assert_no_persistence_forbidden_keys(body)
    # Phase 3O walker also passes — the persistence endpoint is a
    # superset audit (Phase 3O keys + Phase 5E extras).
    assert_no_export_handles(body)


# ---------------------------------------------------------------------------
# 2. id is allowed; export_run_id / export_id are forbidden
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_id_present_and_export_run_id_absent_on_post(
    client, auth_headers
):
    response = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert "id" in body
    # The persistence endpoint deliberately uses ``id``, NEVER
    # ``export_run_id`` / ``export_id`` / ``export_batch_id``.
    assert "export_run_id" not in body
    assert "export_id" not in body
    assert "export_batch_id" not in body


@pytest.mark.asyncio
async def test_id_present_and_export_run_id_absent_on_get_one(
    client, auth_headers
):
    create = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert create.status_code == 201
    run_id = create.json()["id"]
    read = await client.get(
        f"{_LIST_ENDPOINT}/{run_id}", headers=auth_headers
    )
    assert read.status_code == 200, read.text
    body = read.json()
    assert body["id"] == run_id
    assert "export_run_id" not in body
    assert "export_id" not in body
    assert "export_batch_id" not in body


@pytest.mark.asyncio
async def test_id_present_and_export_run_id_absent_on_list(
    client, auth_headers
):
    # Make sure at least one row exists so the list isn't empty.
    create = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert create.status_code == 201
    response = await client.get(_LIST_ENDPOINT, headers=auth_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    items = body["items"]
    assert len(items) >= 1
    for item in items:
        assert "id" in item
        assert "export_run_id" not in item
        assert "export_id" not in item
        assert "export_batch_id" not in item


# ---------------------------------------------------------------------------
# 3. draft_clear persisted record still not finalized
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_draft_clear_persisted_record_still_not_finalized(
    client, auth_headers
):
    """Cleanest possible draft_clear input — the persisted
    snapshot's hard-pinned literals MUST hold even when the
    diagnostic verdict is ``draft_clear``. This is the contract
    that guards every future production-export work against
    accidental "if draft_clear, allow finalise" wiring on the
    persistence side."""
    response = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    # Status reaches draft_clear on this input.
    assert body["status"] == "draft_clear"
    # But every hard pin still holds on the embedded snapshot.
    snap = body["draft_snapshot"]
    assert snap["draft_only"] is True
    assert snap["finalized"] is False
    assert snap["file_generated"] is False
    assert snap["download_available"] is False
    assert snap["production_export_ready"] is False
    # And the row's phase is locked to draft regardless of the
    # diagnostic verdict.
    assert body["phase"] == "draft"


# ---------------------------------------------------------------------------
# 4 + 5. Forbidden handles audit on GET / GET-list responses
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_one_response_has_no_forbidden_handles(
    client, auth_headers
):
    create = await client.post(
        _PERSIST_ENDPOINT,
        json={
            "draft_input": _clear_input(),
            "template_id": str(uuid.uuid4()),
            "document_id": str(uuid.uuid4()),
            "batch_id": str(uuid.uuid4()),
            "export_profile_id": str(uuid.uuid4()),
            "export_profile_name": "ResMan CSV v1",
            "export_profile_version": 3,
            "target_system": "custom_csv",
        },
        headers=auth_headers,
    )
    assert create.status_code == 201
    run_id = create.json()["id"]
    read = await client.get(
        f"{_LIST_ENDPOINT}/{run_id}", headers=auth_headers
    )
    assert read.status_code == 200, read.text
    assert_no_persistence_forbidden_keys(read.json())


@pytest.mark.asyncio
async def test_list_response_has_no_forbidden_handles(client, auth_headers):
    # Seed at least one row so the walker has something to chew on.
    seed = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert seed.status_code == 201
    response = await client.get(_LIST_ENDPOINT, headers=auth_headers)
    assert response.status_code == 200, response.text
    assert_no_persistence_forbidden_keys(response.json())


# ---------------------------------------------------------------------------
# 6. PATCH is notes-only
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_notes_works(client, auth_headers):
    create = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert create.status_code == 201
    run_id = create.json()["id"]
    patch = await client.patch(
        f"{_LIST_ENDPOINT}/{run_id}",
        json={"notes": "Phase 5E contract regression note"},
        headers=auth_headers,
    )
    assert patch.status_code == 200, patch.text
    assert (
        patch.json()["notes"] == "Phase 5E contract regression note"
    )


@pytest.mark.parametrize(
    "extra_field, value",
    [
        ("status", "draft_clear"),
        ("phase", "finalized"),
        ("draft_snapshot", {"finalized": True}),
        ("export_profile_id", "11111111-1111-1111-1111-111111111111"),
        ("export_profile_name", "Forged"),
        ("export_profile_version", 99),
        ("target_system", "yardi"),
        ("template_id", "22222222-2222-2222-2222-222222222222"),
        ("document_id", "33333333-3333-3333-3333-333333333333"),
        ("batch_id", "44444444-4444-4444-4444-444444444444"),
        ("source", "manual"),
        ("row_count", 1000),
        ("blocked_row_count", 1000),
        ("warning_row_count", 1000),
        ("issue_count", 1000),
        ("request_snapshot", {"poisoned": True}),
        ("created_at", "2099-01-01T00:00:00Z"),
        ("updated_at", "2099-01-01T00:00:00Z"),
        ("id", "55555555-5555-5555-5555-555555555555"),
        # Phase 5E forbidden handles must also be rejected on
        # PATCH bodies — a forged PATCH must not be allowed to
        # smuggle a finalisation handle into the row.
        ("download_url", "https://example.com/x.csv"),
        ("file_id", "f-1"),
        ("export_run_id", str(uuid.uuid4())),
        ("finalized_at", "2099-01-01T00:00:00Z"),
        ("exported_at", "2099-01-01T00:00:00Z"),
    ],
)
@pytest.mark.asyncio
async def test_patch_rejects_non_notes_fields(
    client, auth_headers, extra_field, value
):
    """``ExportRunUpdate`` uses ``extra="forbid"`` — every field
    other than ``notes`` must 422. The parametrisation walks the
    full row shape AND the Phase 5E forbidden-handle set so a
    future regression that loosens the schema is caught
    immediately."""
    create = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert create.status_code == 201
    run_id = create.json()["id"]
    patch = await client.patch(
        f"{_LIST_ENDPOINT}/{run_id}",
        json={extra_field: value},
        headers=auth_headers,
    )
    assert patch.status_code == 422, patch.text


@pytest.mark.asyncio
async def test_patch_notes_does_not_alter_status_phase_or_snapshot(
    client, auth_headers
):
    """A successful notes-only PATCH must leave status / phase /
    draft_snapshot / row counts / profile snapshot untouched.
    Phase 5A's service only writes the ``notes`` column, but a
    future regression that copies extra fields out of the
    request body would fail this test."""
    create = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert create.status_code == 201
    before = create.json()
    run_id = before["id"]

    patch = await client.patch(
        f"{_LIST_ENDPOINT}/{run_id}",
        json={"notes": "post-eval audit comment"},
        headers=auth_headers,
    )
    assert patch.status_code == 200, patch.text
    after = patch.json()

    # Notes updated.
    assert after["notes"] == "post-eval audit comment"
    # Everything else preserved.
    for field in (
        "id",
        "status",
        "phase",
        "source",
        "export_profile_id",
        "export_profile_name",
        "export_profile_version",
        "template_id",
        "document_id",
        "batch_id",
        "target_system",
        "row_count",
        "blocked_row_count",
        "warning_row_count",
        "issue_count",
        "draft_snapshot",
        "request_snapshot",
        "created_at",
    ):
        assert before.get(field) == after.get(field), (
            f"Field {field!r} changed after notes-only PATCH "
            f"(before={before.get(field)!r}, after={after.get(field)!r})"
        )
    # Forbidden handles still absent on the response after PATCH.
    assert_no_persistence_forbidden_keys(after)


# ---------------------------------------------------------------------------
# 7. Stateless evaluator endpoint STILL returns no record id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stateless_evaluator_endpoint_still_returns_no_record_id(
    client, auth_headers
):
    """Phase 3O / 4I freeze: the diagnostic evaluator endpoint
    MUST NOT return a record id of any flavour. Phase 5A
    persistence is opt-in through the NEW endpoint family
    above; the evaluator stays stateless on the wire."""
    response = await client.post(
        _EVALUATE_ENDPOINT,
        json={"input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Phase 3O walker covers ``export_run_id`` / ``export_id`` /
    # ``file_id`` / etc.
    assert_no_export_handles(body)
    # Phase 5E walker covers ``finalized_at`` / ``exported_at`` /
    # ``external_system_id`` too — confirm none of them have
    # crept onto the evaluator response either.
    assert_no_persistence_forbidden_keys(body)
    # Top-level explicit checks for the two id-flavoured names
    # that Phase 5A uses on the sibling persistence endpoint —
    # they MUST NOT appear here.
    assert "id" not in body
    assert "export_run_id" not in body


# ---------------------------------------------------------------------------
# 8. Model column audit
# ---------------------------------------------------------------------------


def test_export_run_record_columns_have_no_forbidden_field_names():
    """``ExportRunRecord`` MUST NOT include any column name from
    the Phase 3O / 5E forbidden set. Phase 5A's existing service
    test asserts a subset of this; Phase 5E adds the full
    forbidden set including the persistence-extra finalisation
    handles.

    The columns ``id`` / ``export_profile_id`` / ``template_id``
    / ``document_id`` / ``batch_id`` are allowed (catalog
    references / soft FKs), so the assertion uses the closed
    forbidden set rather than a broader heuristic."""
    column_names = {c.name for c in ExportRunRecord.__table__.columns}
    leaked = column_names & PHASE_5E_FORBIDDEN_KEYS
    assert not leaked, (
        f"Forbidden column name(s) on ExportRunRecord: "
        f"{sorted(leaked)}. See "
        "docs/export-run-persistence-contract.md §4 + §5."
    )


def test_export_run_record_phase_column_present():
    """Phase 5A locks ``phase="draft"``. Phase 5E asserts the
    column is present so a future regression that drops the
    phase column (and silently widens the contract) is caught
    immediately."""
    column_names = {c.name for c in ExportRunRecord.__table__.columns}
    assert "phase" in column_names


# ---------------------------------------------------------------------------
# 9. Migration file column audit
# ---------------------------------------------------------------------------


_MIGRATION_FILE = (
    Path(__file__).resolve().parent.parent.parent
    / "alembic"
    / "versions"
    / "a7b8c9d0e1f2_add_export_runs_table.py"
)


def test_migration_file_exists_at_expected_path():
    """Phase 5A.1 normalised the revision id; Phase 5E asserts
    the file is still where the contract expects it. A future
    rename without updating the docs would surface here."""
    assert _MIGRATION_FILE.exists(), (
        f"Phase 5A migration file missing at expected path: "
        f"{_MIGRATION_FILE}"
    )


def test_migration_file_does_not_create_forbidden_columns():
    """Defensive — read the migration text and assert none of the
    forbidden column NAMES appear inside an ``sa.Column(`` call.

    The text scan is intentionally narrow (only inside ``sa.Column(``
    invocations) so the docstring at the top of the migration —
    which DELIBERATELY mentions the forbidden names as part of
    the contract narrative — does not trip the test.
    """
    text = _MIGRATION_FILE.read_text(encoding="utf-8")
    # Crude but effective — split by ``sa.Column(`` and check the
    # NEXT token (the column name literal) for forbidden values.
    parts = text.split("sa.Column(")
    # First chunk is the docstring + imports; skip it.
    column_decls = parts[1:]
    found_forbidden = []
    for chunk in column_decls:
        # The first quoted literal in the chunk is the column name.
        # Tolerate both single and double quotes; stop at the next
        # quote of the matching kind.
        for quote in ('"', "'"):
            if chunk.startswith(quote):
                end = chunk.find(quote, 1)
                if end > 0:
                    name = chunk[1:end]
                    if name in PHASE_5E_FORBIDDEN_KEYS:
                        found_forbidden.append(name)
                break
    assert not found_forbidden, (
        f"Migration file declares forbidden column(s): "
        f"{sorted(set(found_forbidden))}. See "
        "docs/export-run-persistence-contract.md §5."
    )


# ---------------------------------------------------------------------------
# 10. Self-test — the persistence walker fires on a malicious payload
# ---------------------------------------------------------------------------


def test_assert_no_persistence_forbidden_keys_self_test():
    """Sanity check — the audit walker actually catches a
    forbidden key. Guards against the audit silently no-oping on
    every test above (which would defeat the entire regression
    suite). Mirrors the Phase 3O self-test in
    ``test_operational_preview_contract.py``."""
    good = {
        "id": "00000000-0000-0000-0000-000000000001",
        "phase": "draft",
        "status": "draft_clear",
        "items": [
            {"id": "row-1", "phase": "draft"},
        ],
    }
    # Should not raise.
    assert_no_persistence_forbidden_keys(good)

    # Forbidden top-level key — Phase 3O member.
    with pytest.raises(
        AssertionError, match="Forbidden persistence handle"
    ):
        assert_no_persistence_forbidden_keys(
            {**good, "export_run_id": "x"}
        )

    # Forbidden top-level key — Phase 5E extra.
    with pytest.raises(
        AssertionError, match="Forbidden persistence handle"
    ):
        assert_no_persistence_forbidden_keys(
            {**good, "finalized_at": "2099-01-01T00:00:00Z"}
        )

    # Forbidden nested key.
    with pytest.raises(
        AssertionError, match="Forbidden persistence handle"
    ):
        assert_no_persistence_forbidden_keys(
            {
                **good,
                "items": [
                    {"id": "row-1", "download_url": "https://x"},
                ],
            }
        )


# ---------------------------------------------------------------------------
# Phase 6A — Approval workflow shape regression
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_response_includes_approval_status(
    client, auth_headers
):
    """Phase 6A — every persisted record carries
    ``approval_status`` defaulting to ``"not_requested"`` and
    null timestamps / actors. Confirm the field shape is on the
    wire from the moment of create."""
    response = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["approval_status"] == "not_requested"
    assert body["approval_requested_at"] is None
    assert body["approval_requested_by_user_id"] is None
    assert body["approved_at"] is None
    assert body["approved_by_user_id"] is None
    assert body["rejected_at"] is None
    assert body["rejected_by_user_id"] is None
    assert body["approval_notes"] is None
    assert body["rejection_reason"] is None


@pytest.mark.asyncio
async def test_approval_fields_on_response_have_no_forbidden_handles(
    client, auth_headers
):
    """Phase 6A added 9 approval columns to ``ExportRunRecord``.
    Confirm the resulting response shape STILL passes the Phase
    5E forbidden-handle audit walker — the new columns must not
    have introduced any forbidden key, and adding them must not
    have weakened the walker's coverage."""
    response = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    assert_no_persistence_forbidden_keys(response.json())


@pytest.mark.asyncio
async def test_patch_endpoint_remains_notes_only_after_phase_6a(
    client, auth_headers
):
    """Phase 5A's PATCH endpoint stays notes-only after Phase 6A.
    Sending ``approval_status`` (or any approval column) via PATCH
    must 422 — approval transitions go through the explicit POST
    endpoints introduced in Phase 6A."""
    create = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert create.status_code == 201
    run_id = create.json()["id"]
    for forbidden_field in (
        "approval_status",
        "approval_notes",
        "rejection_reason",
        "approval_requested_at",
        "approved_at",
        "rejected_at",
    ):
        patch = await client.patch(
            f"{_LIST_ENDPOINT}/{run_id}",
            json={forbidden_field: "x"},
            headers=auth_headers,
        )
        assert patch.status_code == 422, (
            f"PATCH should reject {forbidden_field!r}; "
            f"got {patch.status_code}: {patch.text}"
        )


@pytest.mark.asyncio
async def test_approval_endpoint_only_updates_approval_columns(
    client, auth_headers
):
    """Approving a record must NOT change ``phase`` / ``status``
    / ``draft_snapshot`` / row counts / FKs / ``created_at``.
    Phase 6A's service writes only the approval columns + the
    ``updated_by_user_id`` audit field; this test pins that
    contract on the wire."""
    create = await client.post(
        _PERSIST_ENDPOINT,
        json={"draft_input": _clear_input()},
        headers=auth_headers,
    )
    assert create.status_code == 201
    before = create.json()
    run_id = before["id"]
    req = await client.post(
        f"{_LIST_ENDPOINT}/{run_id}/request-approval",
        json={},
        headers=auth_headers,
    )
    assert req.status_code == 200
    response = await client.post(
        f"{_LIST_ENDPOINT}/{run_id}/approve-for-file-generation",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 200
    after = response.json()
    # Approval columns updated.
    assert after["approval_status"] == "approved_for_file_generation"
    assert after["approved_at"] is not None
    # Everything else preserved (Phase 5A immutable surface).
    for field in (
        "id",
        "status",
        "phase",
        "source",
        "export_profile_id",
        "export_profile_name",
        "export_profile_version",
        "template_id",
        "document_id",
        "batch_id",
        "target_system",
        "row_count",
        "blocked_row_count",
        "warning_row_count",
        "issue_count",
        "draft_snapshot",
        "request_snapshot",
        "created_at",
    ):
        assert before.get(field) == after.get(field), (
            f"Field {field!r} changed after approve transition "
            f"(before={before.get(field)!r}, after={after.get(field)!r})"
        )
    # Forbidden handles still absent on the response after approve.
    assert_no_persistence_forbidden_keys(after)


@pytest.mark.asyncio
async def test_stateless_evaluator_still_has_no_approval_status(
    client, auth_headers
):
    """Phase 6A added approval columns to the persistence side.
    The Phase 4F stateless evaluator endpoint MUST NOT have
    grown an approval surface as a side effect — its response
    has no ``approval_status`` / ``approved_at`` / etc."""
    response = await client.post(
        _EVALUATE_ENDPOINT,
        json={"input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    for forbidden in (
        "approval_status",
        "approval_requested_at",
        "approved_at",
        "rejected_at",
        "approval_notes",
        "rejection_reason",
    ):
        assert forbidden not in body, (
            f"Stateless evaluator response leaked Phase 6A approval "
            f"field {forbidden!r}"
        )
