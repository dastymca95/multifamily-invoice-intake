"""Pure-function tests for the document routing decision."""

from app.domain.routing import route_document


def test_pdf_with_text_layer_routes_to_native():
    fake_pdf = b"%PDF-1.4\n... BT /F1 12 Tf (hello) Tj ET ..."
    assert route_document("application/pdf", fake_pdf) == "native_pdf"


def test_pdf_without_text_layer_routes_to_scan():
    # Header but no BT/ET text-show operators.
    fake_pdf = b"%PDF-1.4\nbinary garbage with no text operators"
    assert route_document("application/pdf", fake_pdf) == "scanned_or_image"


def test_image_jpeg_routes_to_scan():
    assert route_document("image/jpeg", b"\xff\xd8\xff\xe0junk") == "scanned_or_image"


def test_image_png_routes_to_scan():
    assert route_document("image/png", b"\x89PNG\r\n\x1a\n") == "scanned_or_image"


def test_unknown_mime_routes_to_unsupported():
    assert route_document("application/zip", b"PK\x03\x04") == "unsupported"


def test_empty_mime_routes_to_unsupported():
    assert route_document("", b"anything") == "unsupported"


def test_mime_case_insensitive():
    assert route_document("Application/PDF", b"BT ET") == "native_pdf"
