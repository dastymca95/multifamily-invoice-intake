"use client";

import { CheckCircle2, FileImage, FileText, FileWarning, X } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { displayDocumentStatus, displayRoute } from "@/lib/status";
import { cn, formatFileSize } from "@/lib/utils";
import type { Document } from "@/types/document";

interface PersistedDocumentNodeProps {
  document: Document;
  selected?: boolean;
  onSelect?: (id: string) => void;
  /**
   * Trigger the unified `removeDocument` flow. Hidden while extraction is
   * in flight server-side ("processing") so the user can't yank a row mid-
   * background-job.
   */
  onRemove?: (id: string) => void;
}

/**
 * Node representing a document that's already saved to the batch on the
 * server. Lives alongside `DocumentNode` (which represents queued / in-
 * flight uploads) inside `DocumentVisualizer`.
 *
 * Visually we mark these "Saved" with a subtle left border so the user can
 * quickly tell what's ephemeral vs durable in the workspace.
 */
export function PersistedDocumentNode({
  document,
  selected = false,
  onSelect,
  onRemove,
}: PersistedDocumentNodeProps) {
  const status = displayDocumentStatus(document);

  const isImage = document.mime_type.startsWith("image/");
  const Icon = isImage ? FileImage : FileText;

  const isProcessing =
    document.extraction_status === "pending" ||
    document.extraction_status === "processing";

  const handleCardClick = () => {
    if (onSelect) onSelect(document.id);
  };

  return (
    <div
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : -1}
      onClick={onSelect ? handleCardClick : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleCardClick();
              }
            }
          : undefined
      }
      className={cn(
        "bg-white border rounded-lg overflow-hidden transition-colors border-l-4",
        onSelect && "cursor-pointer",
        selected
          ? "border-brand-500 border-l-brand-500 ring-2 ring-brand-100"
          : "border-gray-200 border-l-green-300 hover:border-gray-300",
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="h-9 w-9 rounded-md bg-gray-100 flex items-center justify-center shrink-0">
          <Icon className="h-4 w-4 text-gray-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-medium text-gray-800 truncate">
              {document.original_filename}
            </p>
            <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-gray-400 font-medium">
              Saved
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-500">
            <span>{formatFileSize(document.file_size_bytes)}</span>
            <span className="text-gray-300">·</span>
            <span>{displayRoute(document.route_used)}</span>
            {document.error_message && (
              <>
                <span className="text-gray-300">·</span>
                <span className="text-red-600 truncate">extraction error</span>
              </>
            )}
          </div>
        </div>

        <Badge color={status.tone} className="shrink-0">
          <span className="inline-flex items-center gap-1">
            {document.extraction_status === "extracted" && (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {document.extraction_status === "failed" && (
              <FileWarning className="h-3.5 w-3.5" />
            )}
            {status.label}
          </span>
        </Badge>

        {onRemove && !isProcessing && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(document.id);
            }}
            className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-600"
            aria-label={`Remove ${document.original_filename}`}
            title="Remove from batch"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
