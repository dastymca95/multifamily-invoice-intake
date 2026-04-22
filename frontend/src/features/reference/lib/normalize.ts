import type { ReferenceKind } from "@/types/reference";

/**
 * Reference Data — header normalization + per-kind key-field detection.
 *
 * Used by the Source Preview panel to render an honest, Power Query-style
 * cleaned table on top of whatever the parser actually saw. We never
 * invent columns or values — we only:
 *
 *   * Pretty-format raw header strings for display
 *     (`property_name` / `propertyName` / `PROPERTY NAME` → "Property name")
 *   * Surface a per-kind "spine" of likely key columns (Name / Code /
 *     Address …) so the user can sanity-check at a glance that they
 *     uploaded the right report.
 *
 * The key-field patterns intentionally mirror the substring approach
 * used by `app/domain/resman_preview.py::classify_column` on the
 * backend — any reshuffle of those patterns there should also be
 * reflected here so the UI hints stay consistent with what the import
 * pipeline is willing to map.
 */

/**
 * Pretty-format a raw column header for display.
 *
 * Rules (intentionally conservative — we never drop content):
 *   * Trim whitespace.
 *   * Leave positional placeholders alone — "Column 3" stays "Column 3".
 *     The parser uses these for blank-header columns.
 *   * Insert a space at camelCase boundaries (`propertyName` → `property Name`).
 *   * Replace runs of `_`, `-`, `.` with single spaces.
 *   * Collapse multi-space runs.
 *   * Apply sentence case (first letter upper, rest lower) so the headers
 *     read like UI labels rather than database identifiers.
 *
 * The original string is always preserved by the caller as a tooltip /
 * monospace subtitle so power users can still see the exact source name.
 */
export function prettyHeader(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (/^Column\s+\d+$/i.test(trimmed)) return trimmed;

  const camelSplit = trimmed.replace(/([a-z])([A-Z])/g, "$1 $2");
  const spaced = camelSplit.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return trimmed;

  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Per-kind keyword groups used to find likely "spine" columns. Each
 * group is matched by trying its needles in order against the lowercased
 * header strings. First match wins, and a header column is only ever
 * claimed by one group (so "Property Name" claimed for "Name" can't be
 * re-used for "Property" later).
 *
 * The needles err on the side of broad matching — we'd rather surface a
 * column that's a near-miss than show nothing. The user always sees the
 * raw column name in the table itself, so a wrong guess here is cosmetic.
 */
const KEY_FIELD_PATTERNS: Record<
  ReferenceKind,
  Array<{ label: string; needles: string[] }>
> = {
  properties: [
    { label: "Name", needles: ["property name", "property", "name"] },
    { label: "Code", needles: ["abbrev", "short code", "code", "id"] },
    { label: "Address", needles: ["address", "street"] },
    { label: "City", needles: ["city"] },
    { label: "State", needles: ["state", "province"] },
    { label: "ZIP", needles: ["zip", "postal"] },
  ],
  units: [
    { label: "Unit", needles: ["unit name", "unit number", "unit"] },
    { label: "Property", needles: ["property name", "property"] },
    { label: "Beds", needles: ["bedroom", "bed"] },
    { label: "Baths", needles: ["bathroom", "bath"] },
    { label: "SqFt", needles: ["sqft", "sq ft", "square"] },
  ],
  vendors: [
    { label: "Vendor", needles: ["vendor name", "vendor", "payee", "name"] },
    { label: "ID", needles: ["vendor id", "vendor code", "id", "code"] },
    { label: "Email", needles: ["email", "e mail"] },
    { label: "Phone", needles: ["phone", "tel"] },
  ],
  // The import template IS the desired output shape — every column is
  // already meaningful by design, so there's no useful "spine subset" to
  // surface. Returning empty here makes the preview panel skip the
  // caption and lean entirely on the table itself.
  import_template: [],
};

export interface KeyFieldHit {
  /** Canonical short label shown in the caption (e.g. "Name"). */
  label: string;
  /** The raw column name as it appears in `parsed_columns`. */
  columnName: string;
}

/**
 * Find the best-fit column for each per-kind label. Returns labels in
 * the per-kind preference order, skipping any that can't be matched.
 * Empty array for `import_template` (by design) and for any kind whose
 * columns don't match anything.
 */
export function detectKeyFields(
  kind: ReferenceKind,
  columns: string[],
): KeyFieldHit[] {
  const patterns = KEY_FIELD_PATTERNS[kind];
  if (patterns.length === 0 || columns.length === 0) return [];

  const lowered = columns.map((c) => c.toLowerCase());
  const claimed = new Set<number>();
  const hits: KeyFieldHit[] = [];

  for (const { label, needles } of patterns) {
    let foundIndex = -1;
    outer: for (const needle of needles) {
      for (let i = 0; i < lowered.length; i++) {
        if (claimed.has(i)) continue;
        if (lowered[i].includes(needle)) {
          foundIndex = i;
          break outer;
        }
      }
    }
    if (foundIndex >= 0) {
      claimed.add(foundIndex);
      hits.push({ label, columnName: columns[foundIndex] });
    }
  }
  return hits;
}
