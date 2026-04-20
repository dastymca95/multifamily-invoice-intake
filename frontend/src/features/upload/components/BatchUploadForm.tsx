"use client";

import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { batchesApi } from "@/lib/api/batches";
import { documentsApi } from "@/lib/api/documents";
import { getApiErrorMessage } from "@/lib/api";
import { formatFileSize } from "@/lib/utils";
import type { DocumentUploadResult } from "@/types/document";
import { CheckCircle, XCircle } from "lucide-react";
import { useState } from "react";
import { DropZone } from "./DropZone";

type UploadState = "idle" | "creating_batch" | "uploading" | "done";

export function BatchUploadForm() {
  const [batchName, setBatchName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<UploadState>("idle");
  const [results, setResults] = useState<DocumentUploadResult[]>([]);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!batchName.trim() || files.length === 0) return;
    setError("");

    try {
      setState("creating_batch");
      const batch = await batchesApi.create({ name: batchName.trim() });

      setState("uploading");
      const uploadResults = await documentsApi.uploadMany(batch.id, files);
      setResults(uploadResults);
      setState("done");
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, "Upload failed. Please try again."));
      setState("idle");
    }
  };

  if (state === "done") {
    const newCount = results.filter((r) => !r.duplicate).length;
    const dupCount = results.length - newCount;
    return (
      <div className="space-y-4">
        <InlineAlert
          tone="success"
          title={`${results.length} file${results.length !== 1 ? "s" : ""} submitted for processing.`}
        >
          {dupCount > 0
            ? `${newCount} new, ${dupCount} skipped as duplicate${dupCount === 1 ? "" : "s"}.`
            : "Open the dashboard to follow extraction progress, or open the batch directly to start review."}
        </InlineAlert>
        <div className="bg-white rounded-xl border divide-y">
          {results.map((r) => (
            <div key={r.document_id} className="flex items-center gap-3 px-4 py-3">
              {r.duplicate ? (
                <XCircle className="h-4 w-4 text-yellow-500 shrink-0" />
              ) : (
                <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
              )}
              <span className="text-sm text-gray-800 flex-1 truncate">{r.original_filename}</span>
              {r.duplicate && <Badge color="yellow">Duplicate</Badge>}
              <Badge color="gray">{r.route_used}</Badge>
              <Badge color={r.extraction_status === "extracted" ? "green" : "yellow"}>
                {r.extraction_status}
              </Badge>
            </div>
          ))}
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setFiles([]);
            setResults([]);
            setBatchName("");
            setState("idle");
          }}
        >
          Upload another batch
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Batch name</label>
        <input
          value={batchName}
          onChange={(e) => setBatchName(e.target.value)}
          placeholder="e.g. May 2026 Utilities — Oakwood Portfolio"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          required
        />
      </div>

      <DropZone onFiles={setFiles} disabled={state !== "idle"} />

      {files.length > 0 && (
        <div className="bg-white rounded-xl border divide-y text-sm max-h-48 overflow-y-auto">
          {files.map((f, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2">
              <span className="truncate text-gray-800">{f.name}</span>
              <span className="text-gray-400 text-xs ml-4 shrink-0">{formatFileSize(f.size)}</span>
            </div>
          ))}
        </div>
      )}

      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      <Button
        type="submit"
        loading={state !== "idle"}
        disabled={!batchName.trim() || files.length === 0}
      >
        {state === "creating_batch" ? "Creating batch…" : state === "uploading" ? "Uploading…" : `Upload ${files.length > 0 ? files.length + " file" + (files.length > 1 ? "s" : "") : "files"}`}
      </Button>
    </form>
  );
}
