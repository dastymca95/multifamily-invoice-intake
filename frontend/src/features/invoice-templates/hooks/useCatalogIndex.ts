"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getApiErrorMessage,
  glCatalogsApi,
  propertyCatalogsApi,
  vendorCatalogsApi,
} from "@/lib/api";
import type { ColumnSourceType } from "@/types/invoice-template";
import type { GLCatalogOut, GLCatalogSummary } from "@/types/gl-catalog";
import type {
  PropertyCatalogOut,
  PropertyCatalogSummary,
} from "@/types/property-catalog";
import type {
  VendorCatalogOut,
  VendorCatalogSummary,
} from "@/types/vendor-catalog";

/**
 * Mount-time loader for the three catalog summary lists the Import
 * Builder needs to disambiguate catalog-backed source bindings, plus
 * a LAZY DETAIL CACHE for the rule-cell catalog pickers.
 *
 * Why one hook (not three):
 *   * The page calls all three in parallel on mount; one hook owns the
 *     fan-out and exposes a single loading flag.
 *   * Threading three slices through `ImportBuilderPage` ->
 *     `TemplateEditor` -> `ColumnInspector` is one prop, not three.
 *   * Refresh after a catalog is created on `/reference-data/*` is a
 *     single call, not three coordinated calls.
 *
 * Why hoisted at the page (not inside `ColumnInspector`):
 *   * The inspector mounts/unmounts every time the user picks a
 *     different column. Re-fetching on every mount would be wasteful
 *     and visibly flicker the catalog selector. Hoisting to the page
 *     keeps the index stable across column-switches.
 *
 * The DETAIL CACHE (added with the rule-cell picker work):
 *
 *   * Catalog-backed rule cells need the FULL list of entries inside
 *     the bound catalog so the picker can render a searchable dropdown
 *     of real vendor / property / GL rows. Summary lists carry counts,
 *     not entries, so a separate per-catalog detail fetch is needed.
 *
 *   * Many cells under the same column share one catalog; the page
 *     might have 50 vendor cells against `acme-vendors-v3`. Fetching
 *     the detail per cell-mount would be punishing. The cache is keyed
 *     by `${kind}:${id}` so all cells against the same catalog share
 *     a single in-flight fetch and a single cached result.
 *
 *   * `ensureCatalogDetail(sourceType, id)` is the entry point — call
 *     it on cell mount; it no-ops if the detail is already cached or
 *     in flight, otherwise it fires the request. Resolves when the
 *     fetch settles. Safe to call repeatedly.
 *
 *   * `getCatalogDetail(sourceType, id)` is the read-side selector,
 *     returning the cached detail (or null) plus its loading + error
 *     state.
 *
 *   * Storage uses a ref-backed Map (so concurrent ensures dedupe
 *     against the SAME mutable map, not a stale closure) plus a
 *     version counter (`bumpVersion`) that's bumped on every state
 *     transition so subscribed components re-render. Pattern adapted
 *     from typical "external store + tick" hook designs — `useSyncExternalStore`
 *     would be cleaner but pulls in extra ceremony for what's a one-call-
 *     site-per-app feature.
 *
 * Failure model: each list fetches independently. A single-catalog
 * failure (say `gl-catalogs` returns 500) doesn't block the other two
 * — the inspector will show the empty state for the failed kind with
 * the recorded error rather than a global blank screen. `error` here
 * is the most-recent failure message; `vendors`/`properties`/`glCodes`
 * are always valid arrays (default `[]`). Detail failures are surfaced
 * per-catalog via `getCatalogDetail(...).error` and don't pollute the
 * top-level `error`.
 *
 * The summaries are intentionally the *list* shape (no entries array)
 * — list responses don't carry entries, that's why we now have the
 * detail cache below.
 */
export interface CatalogIndex {
  vendors: VendorCatalogSummary[];
  properties: PropertyCatalogSummary[];
  glCodes: GLCatalogSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Trigger a fetch of the full catalog detail (entries) for the given
   * id, no-op if already cached or in flight. Resolves when the fetch
   * settles (success OR failure). Safe to call from a useEffect on
   * cell mount — repeated callers share the same in-flight promise.
   */
  ensureCatalogDetail: (
    sourceType: ColumnSourceType,
    id: string,
  ) => Promise<void>;
  /**
   * Read the cached detail for a given catalog id. Returns the
   * normalized entries (kind-specific shape adapted to a common
   * `CatalogDetailEntry`) plus its loading + error state. Returns
   * `null` for source kinds that aren't catalog-backed.
   */
  getCatalogDetail: (
    sourceType: ColumnSourceType,
    id: string,
  ) => CatalogDetailState | null;
}

export function useCatalogIndex(): CatalogIndex {
  const [vendors, setVendors] = useState<VendorCatalogSummary[]>([]);
  const [properties, setProperties] = useState<PropertyCatalogSummary[]>([]);
  const [glCodes, setGlCodes] = useState<GLCatalogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Independent settles: a single-list failure doesn't blank out the
    // other two. We surface the *first* error seen for diagnostic
    // copy; the inspector's empty-state covers per-kind missing data
    // by checking `array.length === 0` regardless of error.
    const [vRes, pRes, gRes] = await Promise.allSettled([
      vendorCatalogsApi.list(),
      propertyCatalogsApi.list(),
      glCatalogsApi.list(),
    ]);
    let firstErr: string | null = null;
    if (vRes.status === "fulfilled") {
      setVendors(vRes.value.items);
    } else {
      setVendors([]);
      firstErr ??= getApiErrorMessage(
        vRes.reason,
        "Couldn't load vendor catalogs.",
      );
    }
    if (pRes.status === "fulfilled") {
      setProperties(pRes.value.items);
    } else {
      setProperties([]);
      firstErr ??= getApiErrorMessage(
        pRes.reason,
        "Couldn't load property catalogs.",
      );
    }
    if (gRes.status === "fulfilled") {
      setGlCodes(gRes.value.items);
    } else {
      setGlCodes([]);
      firstErr ??= getApiErrorMessage(
        gRes.reason,
        "Couldn't load GL catalogs.",
      );
    }
    setError(firstErr);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- Detail cache ------------------------------------------------------
  //
  // Stored in a ref so concurrent `ensureCatalogDetail` calls dedupe
  // against the SAME mutable map (not a stale closure copy). A version
  // counter forces a re-render after each transition so consumers
  // observe the new state.
  //
  // Cache key namespaces by source kind (e.g. `"vendor_field:abc-123"`)
  // even though id collisions across kinds are vanishingly unlikely
  // with UUIDs — the namespace makes the contract explicit and prevents
  // a future "what if we use short ids" rewrite from blowing up.

  const detailCacheRef = useRef<Map<string, CatalogDetailState>>(new Map());
  const inFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const [, setCacheVersion] = useState(0);
  const bumpVersion = useCallback(() => {
    setCacheVersion((v) => v + 1);
  }, []);

  const ensureCatalogDetail = useCallback(
    async (sourceType: ColumnSourceType, id: string): Promise<void> => {
      const key = detailCacheKey(sourceType, id);
      if (key === null) return;
      const existing = detailCacheRef.current.get(key);
      if (existing && (existing.entries !== null || existing.loading)) {
        // Already fetched (success or live error retained), or already
        // loading. Either way, no action — the in-flight promise (if
        // any) will settle and re-render via bumpVersion. For a retry,
        // call refreshCatalogDetail (not surfaced yet — add when we
        // need explicit retry UX).
        const inFlight = inFlightRef.current.get(key);
        if (inFlight) {
          await inFlight;
        }
        return;
      }
      // Mark loading immediately so concurrent ensures see live state.
      detailCacheRef.current.set(key, {
        entries: null,
        loading: true,
        error: null,
      });
      bumpVersion();
      const promise = (async () => {
        try {
          const entries = await fetchCatalogDetail(sourceType, id);
          detailCacheRef.current.set(key, {
            entries,
            loading: false,
            error: null,
          });
        } catch (e) {
          detailCacheRef.current.set(key, {
            entries: null,
            loading: false,
            error: getApiErrorMessage(e, "Couldn't load catalog entries."),
          });
        } finally {
          inFlightRef.current.delete(key);
          bumpVersion();
        }
      })();
      inFlightRef.current.set(key, promise);
      await promise;
    },
    [bumpVersion],
  );

  const getCatalogDetail = useCallback(
    (
      sourceType: ColumnSourceType,
      id: string,
    ): CatalogDetailState | null => {
      const key = detailCacheKey(sourceType, id);
      if (key === null) return null;
      return detailCacheRef.current.get(key) ?? null;
    },
    // The ref doesn't trigger renders by itself; we depend on the
    // version counter that's bumped on every transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    vendors,
    properties,
    glCodes,
    loading,
    error,
    refresh,
    ensureCatalogDetail,
    getCatalogDetail,
  };
}

/**
 * Pluck the relevant slice of the catalog index for a given column
 * source type. Returns null for non-catalog source kinds — the
 * inspector treats null as "no second-level binding needed".
 *
 * Centralising this here means the inspector's catalog-section
 * doesn't have to know anything about how the index is shaped, and a
 * future fourth catalog kind plugs in here in one place.
 */
/**
 * Lightweight cross-kind shape the inspector reads. We surface
 * `entry_count` so the binding chip can show "Bound to ACME · 412
 * entries" without the inspector knowing which catalog slice it's
 * looking at. All three CatalogSummary types already carry these
 * three fields with identical names.
 */
export interface CatalogOption {
  id: string;
  name: string;
  entry_count: number;
}

export function catalogSliceFor(
  source: ColumnSourceType,
  index: CatalogIndex,
): { items: ReadonlyArray<CatalogOption>; loading: boolean } | null {
  switch (source) {
    case "vendor_field":
      return { items: index.vendors, loading: index.loading };
    case "property_field":
      return { items: index.properties, loading: index.loading };
    case "gl_field":
      return { items: index.glCodes, loading: index.loading };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Detail cache types + adapters
// ---------------------------------------------------------------------------

/**
 * Normalized one-row shape the rule-cell picker iterates over.
 * Adapted from each catalog kind's native entry shape so the picker
 * doesn't carry kind-specific branching.
 *
 *   * `entryId`     — stable id of the source catalog row. Persisted
 *                     verbatim into `RuleCellSelection.entry_id` so
 *                     the runtime resolver can look the row up by id
 *                     even if its display fields drift.
 *   * `fieldValue`  — value of the catalog row's BOUND FIELD (whichever
 *                     `column.source_ref.field` names). The string the
 *                     resolver matches against the field's index.
 *                     Empty when the bound field isn't set on the
 *                     entry (e.g. a vendor with no vendor_code) — the
 *                     picker's row shows it greyed.
 *   * `label`       — display label (always populated; falls back to a
 *                     reasonable per-kind default if the natural label
 *                     field is empty). What the chip / dropdown shows.
 *   * `secondary`   — optional muted sub-line (vendor city / property
 *                     address / GL category). Helps disambiguate
 *                     same-named entries.
 *   * `active`      — drives the picker's "show inactive" filter and
 *                     the muted styling on inactive rows.
 *   * `searchHaystack` — pre-lowered concatenation of label + bound
 *                     field + secondary + a few alias-style fields,
 *                     so the picker's filter is one lowercase
 *                     substring scan per row instead of a per-row
 *                     re-build.
 */
export interface CatalogDetailEntry {
  entryId: string;
  fieldValue: string;
  label: string;
  secondary: string;
  active: boolean;
  searchHaystack: string;
  /**
   * Original kind-tagged raw row, kept inline so the picker can
   * project a per-bound-field `fieldValue` via `fieldValueFor` without
   * having to recover the row through a separate lookup. Kept
   * read-only by convention.
   */
  raw: RawCatalogEntry;
}

export interface CatalogDetailState {
  /**
   * Raw entry list adapted to `CatalogDetailEntry`. Null while loading
   * or after a failed fetch.
   */
  entries: CatalogDetailEntry[] | null;
  loading: boolean;
  error: string | null;
}

/**
 * Namespace cache keys by source kind so different catalog tables can
 * reuse the same id without colliding. Returns null for non-catalog
 * kinds (the caller should never reach the cache for these).
 */
function detailCacheKey(
  sourceType: ColumnSourceType,
  id: string,
): string | null {
  switch (sourceType) {
    case "vendor_field":
      return `vendor:${id}`;
    case "property_field":
      return `property:${id}`;
    case "gl_field":
      return `gl:${id}`;
    default:
      return null;
  }
}

/**
 * Fetch + normalize one catalog's full entry list. Extracted from the
 * hook body for readability — the kind-specific adapters live here.
 *
 * Each adapter projects its native entry to the shared
 * `CatalogDetailEntry` shape; the picker is then completely
 * kind-agnostic. The bound `field` from the column's `source_ref`
 * isn't applied here because the same catalog detail can be reused
 * across columns bound to different fields — the picker derives
 * `fieldValue` per column at render time.
 *
 * Note: we still pre-compute a `searchHaystack` per entry that
 * concatenates the most useful fields. Doing this once in the hook
 * (vs. once per keystroke in the picker) keeps a 5000-entry vendor
 * filter snappy.
 */
async function fetchCatalogDetail(
  sourceType: ColumnSourceType,
  id: string,
): Promise<CatalogDetailEntry[]> {
  switch (sourceType) {
    case "vendor_field": {
      const detail = await vendorCatalogsApi.get(id);
      return adaptVendorDetail(detail);
    }
    case "property_field": {
      const detail = await propertyCatalogsApi.get(id);
      return adaptPropertyDetail(detail);
    }
    case "gl_field": {
      const detail = await glCatalogsApi.get(id);
      return adaptGLDetail(detail);
    }
    default:
      throw new Error(`Cannot fetch detail for non-catalog kind: ${sourceType}`);
  }
}

/**
 * Adapt a vendor catalog's `entries` to the picker's normalized shape.
 *
 * Naming choices:
 *   * `label`       = `vendor_name` — the most readable identifier
 *                     across most catalogs. Falls back to vendor_code
 *                     if vendor_name is somehow blank (shouldn't
 *                     happen — backend requires vendor_name — but
 *                     defensive against legacy data).
 *   * `secondary`   = `vendor_code` if present, else city + state.
 *                     Disambiguates two "AT&T" rows by code or by
 *                     locality.
 *   * `searchHaystack` includes name + code + aliases + email + city
 *                     so the picker's filter matches "epb" → vendor
 *                     code, "energy power" → name, "billing@epb" →
 *                     email, etc.
 */
function adaptVendorDetail(detail: VendorCatalogOut): CatalogDetailEntry[] {
  return detail.entries.map((e) => {
    const name = e.vendor_name?.trim() || "";
    const code = e.vendor_code?.trim() || "";
    const city = e.city?.trim() || "";
    const state = e.state?.trim() || "";
    const aliases = (e.aliases ?? []).join(" ");
    const label = name || code || "(unnamed vendor)";
    const secondary = code
      ? code
      : city
        ? state
          ? `${city}, ${state}`
          : city
        : "";
    return {
      entryId: e.id,
      // fieldValue is computed per column at picker render time (the
      // bound field varies). We surface the canonical "name" here for
      // a sensible fallback if a column has no field bound yet — keeps
      // the chip non-empty.
      fieldValue: name,
      label,
      secondary,
      active: e.active,
      searchHaystack: [
        name,
        code,
        aliases,
        e.email ?? "",
        e.contact_name ?? "",
        city,
        state,
      ]
        .join(" ")
        .toLowerCase(),
      raw: { kind: "vendor", row: e },
    };
  });
}

function adaptPropertyDetail(
  detail: PropertyCatalogOut,
): CatalogDetailEntry[] {
  return detail.entries.map((e) => {
    const name = e.property_name?.trim() || "";
    const code = e.property_code?.trim() || "";
    const abbr = e.property_abbreviation?.trim() || "";
    const unit = e.unit_number?.trim() || "";
    const city = e.city?.trim() || "";
    const state = e.state?.trim() || "";
    const label = unit
      ? `${name || code || "(unnamed property)"} · #${unit}`
      : name || code || "(unnamed property)";
    const secondary = abbr
      ? code && abbr !== code
        ? `${abbr} · ${code}`
        : abbr
      : code || (city ? (state ? `${city}, ${state}` : city) : "");
    return {
      entryId: e.id,
      fieldValue: name,
      label,
      secondary,
      active: e.active,
      searchHaystack: [
        name,
        code,
        abbr,
        unit,
        city,
        state,
        e.address ?? "",
        e.building ?? "",
      ]
        .join(" ")
        .toLowerCase(),
      raw: { kind: "property", row: e },
    };
  });
}

function adaptGLDetail(detail: GLCatalogOut): CatalogDetailEntry[] {
  return detail.entries.map((e) => {
    const code = e.code?.trim() || "";
    const desc = e.description?.trim() || "";
    const cat = e.category?.trim() || "";
    // GL codes alone are opaque; pair with description for the label.
    const label = code && desc ? `${code} · ${desc}` : code || desc || "(unnamed GL)";
    const secondary = cat;
    return {
      entryId: e.id,
      fieldValue: code,
      label,
      secondary,
      active: e.active,
      searchHaystack: [code, desc, cat].join(" ").toLowerCase(),
      raw: { kind: "gl", row: e },
    };
  });
}

/**
 * Project a single normalized entry's `fieldValue` for a given bound
 * field name. The detail adapter pre-fills `fieldValue` with a
 * sensible "name" default (vendor_name / property_name / gl code), but
 * a column might be bound to a more specific field — e.g. a Vendor
 * column bound to `vendor_code` should write the code, not the name.
 *
 * Resolution rules:
 *   * `null` field → fall back to the entry's default `fieldValue`.
 *   * Known per-kind field name → return the corresponding scalar
 *     from the entry's adapter inputs (re-read on demand; cheap).
 *   * Unknown field → fall back to the default.
 *
 * The picker calls this once per pick; volume is tiny.
 *
 * Note: we don't keep the raw entry around after adaptation, so this
 * helper takes the SOURCE detail row (kind-specific) plus the field
 * name. Callers that already adapted to `CatalogDetailEntry` can
 * still get the right value back by passing the original detail row.
 */
export type RawCatalogEntry =
  | { kind: "vendor"; row: VendorCatalogOut["entries"][number] }
  | { kind: "property"; row: PropertyCatalogOut["entries"][number] }
  | { kind: "gl"; row: GLCatalogOut["entries"][number] };

export function fieldValueFor(
  raw: RawCatalogEntry,
  field: string | null,
): string {
  if (raw.kind === "vendor") {
    const r = raw.row;
    switch (field) {
      case "vendor_code":
        return (r.vendor_code ?? "").trim();
      case "vendor_name":
        return (r.vendor_name ?? "").trim();
      case "external_id":
        // BillsIQ's external_id slot for vendors maps to vendor_code in
        // the canonical schema (backend doesn't carry a separate
        // external_id field on vendor entries). Best-effort fallback so
        // the picker doesn't write empty strings for a sensible field.
        return (r.vendor_code ?? "").trim();
      case "address":
        return (r.address ?? "").trim();
      case "city":
        return (r.city ?? "").trim();
      case "state":
        return (r.state ?? "").trim();
      case "zip":
        return (r.zip ?? "").trim();
      case "contact_name":
        return (r.contact_name ?? "").trim();
      case "email":
        return (r.email ?? "").trim();
      case "phone":
        return (r.phone ?? "").trim();
      default:
        return (r.vendor_name ?? "").trim();
    }
  }
  if (raw.kind === "property") {
    const r = raw.row;
    switch (field) {
      case "abbreviation":
        return (r.property_abbreviation ?? "").trim();
      case "name":
        return (r.property_name ?? "").trim();
      case "external_id":
        return (r.property_code ?? "").trim();
      case "address":
        return (r.address ?? "").trim();
      case "city":
        return (r.city ?? "").trim();
      case "state":
        return (r.state ?? "").trim();
      case "zip":
        return (r.zip ?? "").trim();
      default:
        return (r.property_name ?? "").trim();
    }
  }
  // gl
  const r = raw.row;
  switch (field) {
    case "gl_code":
      return (r.code ?? "").trim();
    case "description":
      return (r.description ?? "").trim();
    default:
      return (r.code ?? "").trim();
  }
}
