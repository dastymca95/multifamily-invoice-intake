"""
Pure-function PDF page trimmer.

Used by `POST /documents/{id}/trim` to rewrite a stored PDF after the user
marks pages for removal in the upload workspace's Pages tab.

This module deliberately knows nothing about storage, the database, or HTTP —
it takes bytes in, returns bytes out. That makes it cheap to unit-test and
keeps the trim endpoint focused on the I/O / state-machine concerns
(checksums, storage swap, re-extraction).

Why pypdf and not pdf-lib (which the queued flow uses):
  * pypdf is already a hard dependency for native-PDF extraction, so this
    adds zero install footprint.
  * Doing the rewrite server-side keeps the request payload as small JSON
    (`{ removed_pages: [int] }`) instead of re-uploading the whole file.
  * The server is the source of truth for stored bytes — round-tripping
    the file through the browser to trim it would just be a copy in disguise.
"""

from __future__ import annotations

import io


class PageTrimError(ValueError):
    """Raised for any user-correctable trim input problem.

    The trim endpoint maps these to HTTP 422 so the frontend can surface the
    message verbatim. Anything that hits a non-PageTrimError exception is a
    bug or a corrupt file and should bubble up as a 500.
    """


def trim_pdf_bytes(
    src_bytes: bytes, removed_pages: list[int]
) -> tuple[bytes, int]:
    """
    Return a new PDF byte string with the requested 1-indexed pages dropped.

    Args:
        src_bytes:      The full bytes of the source PDF.
        removed_pages:  1-indexed page numbers the user marked for removal.

    Returns:
        ``(new_bytes, kept_page_count)``.

    Raises:
        PageTrimError: If `removed_pages` is empty, contains out-of-range
                       page numbers, or would leave zero pages behind. Also
                       raised if the source can't be parsed as a PDF.
    """
    # Imported lazily so importing this module doesn't drag pypdf into hot
    # paths that don't need it (e.g. unit tests of unrelated code).
    from pypdf import PdfReader, PdfWriter
    from pypdf.errors import PdfReadError

    if not removed_pages:
        raise PageTrimError("No pages were marked for removal")

    try:
        reader = PdfReader(io.BytesIO(src_bytes))
        # Touch .pages once up front so a malformed PDF fails fast with our
        # own error rather than partway through copying.
        total = len(reader.pages)
    except (PdfReadError, ValueError, OSError) as exc:
        raise PageTrimError(f"Couldn't parse the source PDF: {exc}") from exc

    if total == 0:
        raise PageTrimError("Source PDF has no pages")

    removed_set = set(removed_pages)
    out_of_range = sorted(p for p in removed_set if p < 1 or p > total)
    if out_of_range:
        raise PageTrimError(
            f"Page numbers out of range (PDF has {total} pages): "
            f"{out_of_range}"
        )

    kept_indices = [i for i in range(total) if (i + 1) not in removed_set]
    if not kept_indices:
        raise PageTrimError("At least one page must remain after trimming")

    writer = PdfWriter()
    for i in kept_indices:
        writer.add_page(reader.pages[i])

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue(), len(kept_indices)
