"use client";

import { FileText } from "lucide-react";
import { useMemo } from "react";

import { cn } from "@/lib/utils";
import {
  findResolvedField,
  type InvoicePatternRegion,
  type InvoicePatternSourceFile,
  type ResolvedField,
} from "@/types/invoice-pattern";

import { PdfPageCanvas } from "./PdfPageCanvas";

/**
 * Vertical thumbnail rail for jumping between pages in the active
 * source file. Each thumbnail renders the same page bitmap (image or
 * PDF) the main viewer uses, just at a small fixed width, with
 * miniature region overlays on top so the operator can recognise
 * "the page with three fields drawn" without needing to skim labels.
 *
 * Sits to the LEFT of the main viewer in the parent's flex row when
 * the operator picks the "thumbnails" view mode. Widths picked to fit
 * a comfortable reading rail without crowding the viewer.
 *
 * Click → selects the page (the parent updates `activePage`); the
 * active thumbnail gets a brand-tinted ring so the operator can locate
 * "where am I" at a glance.
 *
 * Region overlays here are read-only — they're a visual cue, not a
 * draw surface. Operator switches back to single / continuous mode to
 * actually edit. Keeping the rail click-only avoids accidental drags
 * on a 120px-wide thumbnail.
 */
interface ThumbnailRailProps {
  file: InvoicePatternSourceFile;
  visiblePages: readonly number[];
  activePage: number;
  regions: readonly InvoicePatternRegion[];
  /** Used only for tinting overlay outlines. Inspector-style detail
   *  isn't needed at this size. */
  resolvedFields: readonly ResolvedField[];
  onSelectPage: (page: number) => void;
}

/** Fixed thumbnail width (matches the brand palette's "small surface"
 *  scale; just wide enough to make page content recognisable). */
const THUMBNAIL_WIDTH_PX = 140;
const UNKNOWN_FIELD_COLOR = "#6b7280";

export function ThumbnailRail({
  file,
  visiblePages,
  activePage,
  regions,
  resolvedFields,
  onSelectPage,
}: ThumbnailRailProps) {
  const isImage = file.mime_type.startsWith("image/");
  const isPdf = file.mime_type === "application/pdf";

  // Group regions by page so each thumbnail only iterates its own
  // slice. Memoised because the page list rebuilds rarely; regions
  // arr is reference-stable per region edit.
  const regionsByPage = useMemo(() => {
    const map = new Map<number, InvoicePatternRegion[]>();
    for (const r of regions) {
      if (r.source_file_id !== file.id) continue;
      const existing = map.get(r.page) ?? [];
      existing.push(r);
      map.set(r.page, existing);
    }
    return map;
  }, [regions, file.id]);

  return (
    <div
      className="shrink-0 w-[10rem] bg-gray-100 border-r border-gray-200 overflow-y-auto p-2 space-y-2"
      aria-label="Page thumbnails"
    >
      {visiblePages.map((page) => {
        const isActive = page === activePage;
        const pageRegions = regionsByPage.get(page) ?? [];
        return (
          <button
            key={`${file.id}:${page}`}
            type="button"
            onClick={() => onSelectPage(page)}
            className={cn(
              "block w-full rounded-md text-left transition-shadow bg-white border",
              isActive
                ? "border-brand-500 ring-2 ring-brand-200 shadow-sm"
                : "border-gray-200 hover:border-gray-300",
            )}
            aria-current={isActive ? "page" : undefined}
            title={`Go to page ${page}`}
          >
            <div
              className="relative bg-white"
              style={{ width: `${THUMBNAIL_WIDTH_PX}px` }}
            >
              {isImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={file.data_url}
                  alt={`${file.file_name} page ${page}`}
                  className="block w-full h-auto"
                  draggable={false}
                />
              )}
              {isPdf && (
                // Re-uses the same PDF.js render component the main
                // viewer uses. Each thumbnail keys its own canvas so
                // the PDF document handle is owned per-thumbnail —
                // costs more memory than ideal, but keeps the
                // rendering pipeline boringly consistent. The
                // performance footnote in the upgrade spec
                // explicitly caps this mode's expectation to
                // moderate page counts.
                <PdfPageCanvas
                  key={`${file.id}:thumb:${page}`}
                  dataUrl={file.data_url}
                  page={page}
                />
              )}
              {!isImage && !isPdf && (
                <div className="aspect-[8.5/11] bg-gray-50 flex items-center justify-center">
                  <FileText className="h-5 w-5 text-gray-300" />
                </div>
              )}

              {/* Region overlays — visual cue only, no interactions.
                  Use a thinner border + lighter fill than the main
                  viewer so the thumbnail still reads as a thumbnail
                  rather than a click target. */}
              {pageRegions.map((r) => {
                const resolved = findResolvedField(
                  r.field_key,
                  resolvedFields,
                );
                const color = resolved?.color ?? UNKNOWN_FIELD_COLOR;
                return (
                  <div
                    key={r.id}
                    className="absolute pointer-events-none"
                    style={{
                      left: `${r.bbox.x * 100}%`,
                      top: `${r.bbox.y * 100}%`,
                      width: `${r.bbox.w * 100}%`,
                      height: `${r.bbox.h * 100}%`,
                      border: `1px solid ${color}`,
                      backgroundColor: withAlpha(color, 0.18),
                    }}
                  />
                );
              })}
            </div>
            <p className="text-[10.5px] text-center text-gray-600 px-1 py-1 tabular-nums">
              Page {page}
              {pageRegions.length > 0 && (
                <span className="text-gray-400">
                  {" "}
                  · {pageRegions.length}
                </span>
              )}
            </p>
          </button>
        );
      })}
    </div>
  );
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
