"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileImage,
  FileText,
  FileWarning,
  Loader2,
  X,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { cn, formatFileSize } from "@/lib/utils";

import type { TrackedFile, TrackedFileStatus } from "../hooks/useBatchUpload";
import { UploadProgressBar } from "./UploadProgressBar";

interface DocumentNodeProps {
  tracked: TrackedFile;
  /** True when this is the workspace's currently-selected item. */
  selected?: boolean;
  /** Click anywhere on the card to select. */
  onSelect?: (id: string) => void;
  /**
   * Remove this item. The hook's `removeDocument` knows whether the row is
   * local-only (queued / duplicate / failed) or has a server-side
   * counterpart that needs DELETE. We just hide the action while a row is
   * mid-upload so the user can't pull it out from under itself.
   */
  onRemove?: (id: string) => void;
}

const STATUS_LABEL: Record<TrackedFileStatus, string> = {
  queued: "Queued",
  uploading: "Uploading",
  uploaded: "Uploaded",
  extracted: "Extracted",
  duplicate: "Duplicate",
  failed: "Failed",
};

type BadgeColor = "gray" | "blue" | "green" | "yellow" | "red" | "purple";

const STATUS_BADGE: Record<TrackedFileStatus, BadgeColor> = {
  queued: "gray",
  uploading: "blue",
  uploaded: "blue",
  extracted: "green",
  duplicate: "yellow",
  failed: "red",
};

function StatusIcon({ status }: { status: TrackedFileStatus }) {
  const cls = "h-3.5 w-3.5";
  switch (status) {
    case "queued":
      return <Clock className={cn(cls, "text-gray-400")} />;
    case "uploading":
      return <Loader2 className={cn(cls, "text-brand-600 animate-spin")} />;
    case "uploaded":
      return <Loader2 className={cn(cls, "text-blue-500 animate-spin")} />;
    case "extracted":
      return <CheckCircle2 className={cn(cls, "text-green-500")} />;
    case "duplicate":
      return <Copy className={cn(cls, "text-yellow-600")} />;
    case "failed":
      return <FileWarning className={cn(cls, "text-red-500")} />;
  }
}

function FileTypeIcon({ tracked }: { tracked: TrackedFile }) {
  const isImage = tracked.meta?.source === "image";
  const Icon = isImage ? FileImage : FileText;
  return (
    <div className="h-9 w-9 rounded-md bg-gray-100 flex items-center justify-center shrink-0">
      <Icon className="h-4 w-4 text-gray-500" />
    </div>
  );
}

function PageList({ tracked }: { tracked: TrackedFile }) {
  const meta = tracked.meta;

  if (!meta) {
    return (
      <p className="text-[11px] text-gray-400">Reading document metadata…</p>
    );
  }

  if (meta.pageCount == null) {
    return (
      <p className="text-[11px] text-gray-400">
        Page count not available for this file. The document will still be
        uploaded and processed in full.
      </p>
    );
  }

  if (meta.source === "image") {
    return (
      <div className="flex flex-wrap gap-1.5">
        <span className="inline-flex items-center justify-center min-w-[2.25rem] h-7 px-2 rounded-md border border-gray-200 bg-gray-50 text-[11px] font-medium text-gray-600">
          1 image
        </span>
      </div>
    );
  }

  // PDF — emit a numbered chip per page. Cap at 60 to keep large PDFs from
  // exploding the panel; the count is still shown alongside.
  const total = meta.pageCount;
  const cap = 60;
  const visible = Math.min(total, cap);
  const chips: number[] = [];
  for (let i = 1; i <= visible; i += 1) chips.push(i);

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((n) => (
          <span
            key={n}
            className="inline-flex items-center justify-center min-w-[2.25rem] h-7 px-2 rounded-md border border-gray-200 bg-gray-50 text-[11px] font-medium text-gray-600"
            title={`Page ${n}`}
          >
            {n}
          </span>
        ))}
        {total > cap && (
          <span className="inline-flex items-center justify-center h-7 px-2 rounded-md border border-dashed border-gray-300 bg-white text-[11px] text-gray-500">
            +{total - cap} more
          </span>
        )}
      </div>
      <p className="text-[10.5px] text-gray-400 mt-2">
        Page placeholders only — content previews aren&apos;t generated in
        the browser.
      </p>
    </div>
  );
}

export function DocumentNode({
  tracked,
  selected = false,
  onSelect,
  onRemove,
}: DocumentNodeProps) {
  const [expanded, setExpanded] = useState(false);

  const meta = tracked.meta;
  const status = tracked.status;
  const isUploading = status === "uploading";
  const isTerminal =
    status === "extracted" ||
    status === "duplicate" ||
    status === "failed" ||
    status === "uploaded";

  const progressTone =
    status === "failed"
      ? "error"
      : status === "duplicate"
        ? "warning"
        : status === "extracted"
          ? "success"
          : status === "uploading"
            ? "active"
            : "idle";

  // Hide the page-list expansion control until we have something to show.
  const canExpand =
    meta != null && meta.pageCount != null && meta.pageCount > 0;

  const pagesLabel =
    meta == null
      ? "…"
      : meta.pageCount == null
        ? "—"
        : `${meta.pageCount} ${meta.pageCount === 1 ? "page" : "pages"}`;

  // Whole-card click selects. A duplicate is the most "actionable" state
  // here — it routes the user toward the conflict info in the preview pane.
  const handleCardClick = () => {
    if (onSelect) onSelect(tracked.id);
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
        "bg-white border rounded-lg overflow-hidden transition-colors",
        onSelect && "cursor-pointer",
        selected
          ? "border-brand-500 ring-2 ring-brand-100"
          : status === "duplicate"
            ? "border-yellow-200 hover:border-yellow-300"
            : "border-gray-200 hover:border-gray-300",
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (canExpand) setExpanded((v) => !v);
          }}
          disabled={!canExpand}
          className={cn(
            "h-5 w-5 shrink-0 flex items-center justify-center rounded text-gray-400",
            canExpand
              ? "hover:bg-gray-100 hover:text-gray-600 cursor-pointer"
              : "cursor-default opacity-30",
          )}
          aria-label={expanded ? "Collapse pages" : "Expand pages"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        <FileTypeIcon tracked={tracked} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-medium text-gray-800 truncate">
              {tracked.file.name}
            </p>
            {meta && (
              <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-gray-400 font-medium">
                {meta.kindLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-500">
            <span>{formatFileSize(tracked.file.size)}</span>
            <span className="text-gray-300">·</span>
            <span>{pagesLabel}</span>
            {tracked.result?.route_used && (
              <>
                <span className="text-gray-300">·</span>
                <span className="text-gray-500">{tracked.result.route_used}</span>
              </>
            )}
            {status === "duplicate" && (
              <>
                <span className="text-gray-300">·</span>
                <span className="text-yellow-700 font-medium">
                  click to compare
                </span>
              </>
            )}
          </div>
        </div>

        <Badge color={STATUS_BADGE[status]} className="shrink-0">
          <span className="inline-flex items-center gap-1">
            <StatusIcon status={status} />
            {STATUS_LABEL[status]}
          </span>
        </Badge>

        {onRemove && status !== "uploading" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(tracked.id);
            }}
            className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label={`Remove ${tracked.file.name}`}
            title="Remove from batch"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Per-file progress bar — only meaningful while uploading or once a terminal state is reached. */}
      {(isUploading || isTerminal) && (
        <div className="px-3 pb-2">
          <UploadProgressBar
            value={isUploading ? tracked.progress : 100}
            tone={progressTone}
            size="sm"
          />
        </div>
      )}

      {/* Inline error message for failed uploads. */}
      {status === "failed" && tracked.error && (
        <div className="px-3 pb-2 -mt-1">
          <p className="text-[11px] text-red-600">{tracked.error}</p>
        </div>
      )}

      {/* Expanded page list. */}
      {expanded && canExpand && (
        <div
          className="border-t bg-gray-50/50 px-3 py-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          <PageList tracked={tracked} />
        </div>
      )}
    </div>
  );
}
