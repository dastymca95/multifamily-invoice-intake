/**
 * Reusable building blocks for catalog editors.
 *
 * Originally extracted from the Phase-13 Properties Quality Pass after
 * the same shape (catalog-name + description + virtualized editable
 * grid + save/discard/delete + draft semantics) was about to be
 * copy-pasted into the GL Codes editor. The pattern that made
 * Properties responsive at thousands of rows lives here:
 *
 *   - State isolation for the title bar (`IsolatedTitleBar`) so
 *     keystrokes don't re-render the grid subtree.
 *   - Row virtualization (`VirtualizedRowGrid`) so only viewport rows
 *     mount, regardless of catalog size.
 *   - Generic CRUD with O(1) reference-equality dirty tracking
 *     (`useCatalogEntries`).
 *   - Generic case-insensitive search (`useGridSearch`).
 *   - Shared chrome: source badge, delete-with-confirmation footer,
 *     empty-state prompt, sticky grid header.
 *
 * Catalogs still own their own per-row `EntryRow` components — the
 * shape of an editable row is too schema-specific to abstract without
 * forcing every page through a hostile generic. The shell handles
 * what's actually shared; row rendering stays per-catalog.
 */

export {
  useCatalogEntries,
  type UseCatalogEntriesOptions,
  type UseCatalogEntriesResult,
} from "./useCatalogEntries";

export { useGridSearch } from "./useGridSearch";

export {
  IsolatedTitleBar,
  type TitleBarHandle,
  type IsolatedTitleBarProps,
} from "./IsolatedTitleBar";

export {
  VirtualizedRowGrid,
  type VirtualizedRowGridHandle,
  type VirtualizedRowGridProps,
} from "./VirtualizedRowGrid";

export { GridHeaderRow, HeaderCell, type GridHeaderRowProps } from "./GridHeader";

export { SourceBadge, type CatalogSourceKind } from "./SourceBadge";

export {
  DeleteCatalogFooter,
  type DeleteCatalogFooterProps,
} from "./DeleteCatalogFooter";

export {
  EmptyTablePrompt,
  type EmptyTablePromptProps,
} from "./EmptyTablePrompt";
