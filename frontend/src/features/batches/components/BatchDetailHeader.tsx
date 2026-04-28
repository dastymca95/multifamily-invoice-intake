"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { OperationalPreviewLauncher } from "@/features/invoice-templates/components/OperationalPreviewLauncher";
import { displayBatchStatus } from "@/lib/status";
import { formatDate } from "@/lib/utils";
import type { Batch } from "@/types/batch";

interface BatchDetailHeaderProps {
  batch: Batch;
  onReload: () => void;
}

export function BatchDetailHeader({ batch, onReload }: BatchDetailHeaderProps) {
  const status = displayBatchStatus(batch);

  return (
    <div className="bg-white border-b">
      <div className="px-6 py-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-1"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to Dashboard
          </Link>
          <h1 className="text-lg font-semibold text-gray-900 truncate">{batch.name}</h1>
          {batch.description && (
            <p className="text-sm text-gray-500 mt-0.5 truncate">{batch.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge color={status.tone}>{status.label}</Badge>
          <Button variant="secondary" size="sm" onClick={onReload}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          {/* Phase 3C — Operational Preview launch from this batch.
              Diagnostic only: it never changes batch status, never
              creates Review Queue records, and never produces an
              export row. Pre-fills batch_id only — operators can
              add facts manually inside the preview panel to test
              how the resolver would handle them. */}
          <OperationalPreviewLauncher
            label="Operational Preview"
            variant="ghost"
            size="sm"
            batchId={batch.id}
            initialDocumentMetadata={{
              source: "batch_context",
              batch_id: batch.id,
              batch_name: batch.name,
              launch_surface: "batch_detail",
            }}
            launchContextLabel={`Batch: ${batch.name}`}
            contextNotice="Pre-filled with this batch's id. No specific document is selected — pick one in the Review Queue if you want document-level facts pre-filled."
          />
        </div>
      </div>

      <div className="px-6 pb-4 grid grid-cols-4 gap-3 text-sm">
        <Stat label="Total" value={batch.total_documents} />
        <Stat label="Processed" value={batch.processed_documents} />
        <Stat label="Failed" value={batch.failed_documents} tone={batch.failed_documents > 0 ? "red" : "default"} />
        <Stat label="Created" value={formatDate(batch.created_at)} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "red";
}) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p
        className={
          tone === "red"
            ? "text-base font-semibold text-red-600"
            : "text-base font-semibold text-gray-900"
        }
      >
        {value}
      </p>
    </div>
  );
}
