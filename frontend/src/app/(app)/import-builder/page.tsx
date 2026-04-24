import { TopBar } from "@/components/layout/TopBar";
import { ImportBuilderPage } from "@/features/invoice-templates/components/ImportBuilderPage";

/**
 * Route shell for the Import Builder workspace.
 *
 * The Import Builder is where the final import/output schema is
 * designed: the column shape, per-column required/optional flag, value
 * source bindings (Properties / Vendors / GL Codes / extracted
 * invoice / fixed value / inline manual list), and the column-level
 * validation contract.
 *
 * History: this page is the evolution of the former
 * `/reference-data/invoice-template` Invoice Template Builder. The
 * underlying entity is still an `InvoiceTemplate` at the storage
 * layer (table + endpoint names are stable), but the product surface
 * was promoted to a top-level workspace because the column contract
 * is no longer "just headers." See `ImportBuilderPage` JSDoc for the
 * full layout.
 *
 * Note on the feature folder: the page lives in
 * `frontend/src/features/invoice-templates/` (matching the storage
 * entity name) rather than a parallel `import-builder/` folder, both
 * to avoid churning every import path and to keep the
 * folder-name-mirrors-entity-name convention.
 */
export default function ImportBuilderRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Import Builder" />
      <div className="flex-1 min-h-0">
        <ImportBuilderPage />
      </div>
    </div>
  );
}
