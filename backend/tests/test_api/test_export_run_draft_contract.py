"""
Phase 4I — Export Run Draft contract freeze regression tests.

These tests pin the diagnostic-only contract that the Export Run
Draft endpoint (Phases 4F–4H) collectively guarantees. They are
NOT a re-litigation of per-rule classifier coverage — those live
in ``test_services/test_export_run_draft.py`` and the per-phase
API smoke file ``test_api/test_export_run_drafts.py``.

What this file does:

  * Asserts every hard pin (``draft_only=True``,
    ``finalized=False``, ``file_generated=False``,
    ``download_available=False``, ``production_export_ready=False``)
    is present on every status the endpoint can return.
  * Asserts the cleanest "ready"-looking input still keeps the
    pins AND keeps the operator title's "Production export
    unavailable" boundary phrase.
  * Asserts no forbidden export / file / posting handle keys
    appear at any nesting depth in the response (re-uses the
    Phase 3O ``assert_no_export_handles`` helper).
  * Asserts a caller-supplied ``production_export_ready=true`` is
    captured into ``context.input_production_export_ready_claim``
    but IGNORED for the response field.
  * Asserts the empty-input / no-rows path returns
    ``not_available`` AND still passes the export-handle audit.
  * Asserts ``selected_profile_source != "saved"`` (built-in /
    inline / unknown / null) cannot reach ``draft_clear``.
  * Asserts the response shape is "stateless" — no id-like export
    fields appear in the body. ``selected_profile_id`` is
    explicitly allowed (it's a profile id, not an export id).
  * Asserts the Phase 3O audit is wired correctly on the draft
    endpoint by running the audit walker against the response.

What this file deliberately does NOT do:

  * Does NOT re-test per-rule classifier coverage.
  * Does NOT depend on internal payload field ordering.
  * Does NOT add brittle full-shape snapshots.
  * Does NOT touch the DB — the draft endpoint is stateless.

Future phases that wire a real export engine MUST add new
endpoints (or new optional fields gated behind explicit flags) —
the draft endpoint exercised here must keep returning every hard
pin regardless.

See also:
  * ``docs/export-run-draft-contract.md`` — the canonical
    contract document this file enforces.
  * ``docs/operational-preview-contract.md`` §8 — the broader
    Operational Preview hard boundaries.
"""

from __future__ import annotations

import pytest

from tests.test_api.test_operational_preview_contract import (
    FORBIDDEN_EXPORT_KEYS,
    assert_no_export_handles,
)


# ---------------------------------------------------------------------------
# Local helpers — kept tiny + self-contained
# ---------------------------------------------------------------------------


_DRAFT_ENDPOINT = "/api/v1/export-run-drafts/evaluate"


def _clear_input() -> dict:
    """Cleanest "ready"-looking input — saved profile, clear
    validation, clear readiness, non-empty rows, no issues. The
    classifier returns ``draft_clear`` on this input AND every
    hard pin still holds."""
    return {
        "selected_profile_id": "prof-saved-4i",
        "selected_profile_source": "saved",
        "profile_validation_status": "clear",
        "readiness_diagnostic_status": "clear",
        "export_preview_row_count": 5,
        "export_preview_issue_count": 0,
        "blocked_row_count": 0,
        "warning_row_count": 0,
    }


def _assert_hard_pins(body: dict) -> None:
    """Assert every hard-pinned field is present + correct.

    Pydantic ``Literal[True]`` / ``Literal[False]`` already enforce
    these at parse time — this helper is the wire-side defence so
    a future regression in serialisation surfaces immediately
    instead of waiting for a downstream consumer to parse a bad
    response."""
    assert body["draft_only"] is True, body
    assert body["finalized"] is False, body
    assert body["file_generated"] is False, body
    assert body["download_available"] is False, body
    assert body["production_export_ready"] is False, body


# ---------------------------------------------------------------------------
# 1. Hard pins hold across every status the endpoint returns
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hard_pins_on_empty_input(client, auth_headers):
    """``not_available`` path — empty input. Hard pins still hold."""
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": {}}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "not_available"
    _assert_hard_pins(body)


@pytest.mark.asyncio
async def test_hard_pins_on_blocked_input(client, auth_headers):
    """``blocked`` path — blocked validation status. Hard pins still hold."""
    payload = _clear_input()
    payload["profile_validation_status"] = "blocked"
    payload["blocked_row_count"] = 2
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "blocked"
    _assert_hard_pins(body)


@pytest.mark.asyncio
async def test_hard_pins_on_needs_review_input(client, auth_headers):
    """``needs_review`` path — warning rows. Hard pins still hold."""
    payload = _clear_input()
    payload["warning_row_count"] = 1
    payload["export_preview_issue_count"] = 1
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "needs_review"
    _assert_hard_pins(body)


@pytest.mark.asyncio
async def test_hard_pins_on_draft_clear_input(client, auth_headers):
    """``draft_clear`` path — cleanest input. Hard pins still hold."""
    response = await client.post(
        _DRAFT_ENDPOINT,
        json={"input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "draft_clear"
    _assert_hard_pins(body)


# ---------------------------------------------------------------------------
# 2. draft_clear STILL is not production export
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_draft_clear_still_not_production_export(client, auth_headers):
    """Cleanest possible draft_clear input — boundary copy must
    still announce ``Production export unavailable`` AND every
    hard pin must hold. This is the contract that guards every
    future production-export work against accidental "if
    draft_clear, allow export" wiring."""
    response = await client.post(
        _DRAFT_ENDPOINT,
        json={"input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Verdict reaches "draft_clear" — confirms the input was the
    # cleanest case the classifier accepts.
    assert body["status"] == "draft_clear"
    # But every hard pin remains.
    _assert_hard_pins(body)
    # Operator title still carries the boundary phrase. Phase 4I
    # locks this in so future copy edits cannot drop the contract
    # reminder from the operator surface.
    assert "Production export unavailable" in body["operator_title"]
    # Architectural always-on reasons remain in the reason list
    # even when status is draft_clear — the contract is honest
    # that the future export engine still doesn't exist.
    expected_always_on_reasons = {
        "diagnostic_only_pipeline",
        "no_export_engine",
        "no_file_generation",
        "no_export_run_persistence",
        "no_final_approval",
        "no_export_audit_trail",
        "no_external_posting",
    }
    assert expected_always_on_reasons.issubset(set(body["reasons"]))


# ---------------------------------------------------------------------------
# 3. Forbidden export handles audit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_response_has_no_export_handles_on_clear_input(
    client, auth_headers
):
    """Phase 3O ``assert_no_export_handles`` walker — must pass
    even on the cleanest draft_clear path that includes every
    optional ID field on the input."""
    payload = _clear_input()
    payload.update(
        {
            "operational_result_id": "op-4i-1",
            "template_id": "tmpl-4i-1",
            "document_id": "doc-4i-1",
            "batch_id": "batch-4i-1",
        }
    )
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    assert_no_export_handles(response.json())


@pytest.mark.asyncio
async def test_response_has_no_export_handles_on_empty_input(
    client, auth_headers
):
    """Empty input — ``not_available`` path — also passes the
    forbidden-handle audit."""
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": {}}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    assert_no_export_handles(response.json())


@pytest.mark.asyncio
async def test_response_has_no_export_handles_on_blocked_input(
    client, auth_headers
):
    """``blocked`` path — also passes the forbidden-handle audit."""
    payload = _clear_input()
    payload["profile_validation_status"] = "blocked"
    payload["blocked_row_count"] = 3
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    assert_no_export_handles(response.json())


# ---------------------------------------------------------------------------
# 4. Caller production_export_ready=true is ignored
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_caller_production_ready_claim_is_ignored(client, auth_headers):
    """Defence in depth — even if the caller flips
    ``production_export_ready=True`` on the input, the response
    field stays pinned to ``False``. The caller's claim is
    captured inside ``context.input_production_export_ready_claim``
    so a paste-into-Slack workflow makes the discrepancy visible
    without flipping the contract."""
    payload = _clear_input()
    payload["production_export_ready"] = True
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # The hard pin holds even though the caller claimed otherwise.
    assert body["production_export_ready"] is False
    # Caller's claim is captured in the context echo. The exact
    # key is the contract — the Phase 4F service uses this name and
    # the panel's full report renders it as audit context.
    assert body.get("context") is not None
    assert body["context"]["input_production_export_ready_claim"] is True
    # And the audit walker still passes — the context echo does
    # not introduce any forbidden handle.
    assert_no_export_handles(body)


# ---------------------------------------------------------------------------
# 5. Built-in profile source cannot reach draft_clear
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_built_in_source_cannot_reach_draft_clear(client, auth_headers):
    """The contract requires a SAVED profile to reach
    ``draft_clear``. Built-in starters — even with otherwise-clear
    inputs — must classify as ``needs_review`` with
    ``profile_not_persisted`` in the reason list."""
    payload = _clear_input()
    payload["selected_profile_id"] = "builtin:custom-csv-mirror"
    payload["selected_profile_source"] = "built_in"
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Cannot be draft_clear.
    assert body["status"] != "draft_clear"
    assert body["status"] == "needs_review"
    # And the persistence reason is surfaced explicitly.
    assert "profile_not_persisted" in body["reasons"]
    # Hard pins still hold and the audit still passes.
    _assert_hard_pins(body)
    assert_no_export_handles(body)


@pytest.mark.asyncio
async def test_unknown_profile_source_cannot_reach_draft_clear(
    client, auth_headers
):
    """Forward-compat — an unknown source string (e.g. a future
    ``inline`` source) MUST also fail to reach ``draft_clear``.
    The classifier's ``selected_profile_source not in {"saved"}``
    rule is the only persistence signal; future sources must opt
    in explicitly."""
    payload = _clear_input()
    payload["selected_profile_source"] = "future_unknown_source"
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] != "draft_clear"
    assert "profile_not_persisted" in body["reasons"]
    _assert_hard_pins(body)


# ---------------------------------------------------------------------------
# 6. No-rows / no-profile returns not_available without export handles
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_rows_returns_not_available_with_clean_audit(
    client, auth_headers
):
    """Zero rows is the most common ``not_available`` trigger.
    Confirm it returns ``not_available``, includes
    ``no_rows_to_export`` in the reason list, AND passes the
    forbidden-handle audit."""
    payload = _clear_input()
    payload["export_preview_row_count"] = 0
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "not_available"
    assert "no_rows_to_export" in body["reasons"]
    _assert_hard_pins(body)
    assert_no_export_handles(body)


@pytest.mark.asyncio
async def test_no_profile_returns_not_available_with_clean_audit(
    client, auth_headers
):
    """No selected profile id — also ``not_available``. Hard pins
    + forbidden-handle audit still hold."""
    payload = _clear_input()
    payload["selected_profile_id"] = None
    response = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "not_available"
    _assert_hard_pins(body)
    assert_no_export_handles(body)


# ---------------------------------------------------------------------------
# 7. Stateless response shape — no id-like export fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_response_top_level_keys_have_no_export_id_fields(
    client, auth_headers
):
    """Direct top-level audit — explicit list of disallowed keys.
    The Phase 3O ``assert_no_export_handles`` walker covers every
    nesting depth; this test gives a faster, more readable
    failure message if a future regression adds e.g.
    ``export_run_id`` directly to the top-level response.

    NOTE: ``selected_profile_id`` IS explicitly allowed — a
    profile id is a catalog reference, not an export handle. The
    forbidden set deliberately omits it so the test does not
    confuse the two."""
    response = await client.post(
        _DRAFT_ENDPOINT,
        json={"input": _clear_input()},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    top_level_keys = set(body.keys())
    leaked = top_level_keys & FORBIDDEN_EXPORT_KEYS
    assert not leaked, (
        f"Forbidden export handle key(s) leaked into the draft response "
        f"top-level: {sorted(leaked)}. See "
        "docs/export-run-draft-contract.md §4."
    )
    # Profile id remains allowed and round-trips verbatim.
    assert body["selected_profile_id"] == "prof-saved-4i"


@pytest.mark.asyncio
async def test_endpoint_is_stateless_repeated_calls_match(
    client, auth_headers
):
    """The endpoint is pure — identical inputs MUST produce
    identical verdicts on repeated calls. If a future regression
    introduces side-effects / DB writes / id generation, this
    will catch it because the response would diverge across
    calls."""
    payload = _clear_input()
    first = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    second = await client.post(
        _DRAFT_ENDPOINT, json={"input": payload}, headers=auth_headers
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    first_body = first.json()
    second_body = second.json()
    # Field-by-field equality — covers status, hard pins, reasons,
    # operator copy, next steps, disclaimers, and the context
    # echo. If a future regression bakes a timestamp / random id
    # into the response, this test surfaces it loudly.
    assert first_body == second_body
