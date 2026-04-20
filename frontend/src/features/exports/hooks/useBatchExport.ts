"use client";

import { useState } from "react";

import { exportsApi, getApiErrorMessage } from "@/lib/api";
import type { ExportFormat } from "@/types/api";
import type { ExportJob } from "@/types/invoice";

export type ExportPhase = "idle" | "creating" | "downloading";

export interface UseBatchExportResult {
  job: ExportJob | null;
  phase: ExportPhase;
  error: string | null;
  create: (batchId: string, format: ExportFormat) => Promise<void>;
  download: () => Promise<void>;
  reset: () => void;
}

/**
 * Drives a single batch-export interaction: trigger creation, then optionally
 * download the resulting file.
 *
 * Phase 1 backend is synchronous, so the job returned from `createForBatch`
 * already has its terminal status (`completed` / `failed`). No polling.
 *
 * `error` is the user-facing message for the latest failed step. A backend
 * `failed` job is treated as an error (we surface `job.error_message`) so
 * the UI can show one consistent red banner.
 */
export function useBatchExport(): UseBatchExportResult {
  const [job, setJob] = useState<ExportJob | null>(null);
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const create = async (batchId: string, format: ExportFormat) => {
    setPhase("creating");
    setError(null);
    try {
      const created = await exportsApi.createForBatch(batchId, format);
      setJob(created);
      if (created.status === "failed") {
        setError(created.error_message || "Export failed.");
      }
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to create export."));
    } finally {
      setPhase("idle");
    }
  };

  const download = async () => {
    if (!job) return;
    setPhase("downloading");
    setError(null);
    try {
      await exportsApi.download(job.id, job.format);
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to download export."));
    } finally {
      setPhase("idle");
    }
  };

  const reset = () => {
    setJob(null);
    setPhase("idle");
    setError(null);
  };

  return { job, phase, error, create, download, reset };
}
