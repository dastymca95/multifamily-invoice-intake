/**
 * Reference Data — types mirror `app/schemas/reference.py`.
 *
 * The four kinds correspond to the ResMan inputs the eventual export
 * pipeline will need. The backend's `REFERENCE_KINDS` is the source of
 * truth; this constant is just the frontend's local copy used for
 * iteration order and exhaustive switches.
 */

export type ReferenceKind =
  | "properties"
  | "units"
  | "vendors"
  | "import_template";

export const REFERENCE_KINDS: readonly ReferenceKind[] = [
  "properties",
  "units",
  "vendors",
  "import_template",
] as const;

export type ReferenceParseStatus = "parsed" | "parse_failed";

export interface ReferenceFile {
  id: string;
  kind: ReferenceKind;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  checksum_sha256: string;
  parse_status: ReferenceParseStatus;
  parse_error: string | null;
  /** Detected header row, in source order. Null on parse failure. */
  parsed_columns: string[] | null;
  /** Total non-blank data rows (excludes header). Null on parse failure. */
  parsed_row_count: number | null;
  /** Up to 5 rows for inspection. Null on parse failure. */
  sample_rows: Array<Record<string, string>> | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReferenceSlot {
  kind: ReferenceKind;
  /** Human-readable kind label, e.g. "Property report". */
  label: string;
  /** One-paragraph explanation of what this kind is used for. */
  description: string;
  /** Null when nothing has been uploaded for this kind yet. */
  current: ReferenceFile | null;
}

export interface ReferenceListResponse {
  slots: ReferenceSlot[];
}
