import { TopBar } from "@/components/layout/TopBar";
import { InvoiceBuilderPage } from "@/features/invoice-builder/components/InvoiceBuilderPage";

/**
 * Route shell for the Invoice Builder workspace.
 *
 * The Invoice Builder is a sibling product surface to:
 *
 *   * Reference Data — saved catalogs (Vendors / Properties / GL Codes)
 *   * Import Builder — saved column/rule schemas for the final import
 *     output (`InvoiceTemplate`)
 *
 * Each saved row here is an `InvoicePattern` — uploaded training docs
 * with bbox-on-page region annotations that pin canonical extracted
 * invoice fields to specific rectangles on specific pages. The
 * Import Builder integration: rule cells on `invoice_field` columns
 * can OPTIONALLY reference a saved pattern + a canonical field to
 * narrow extraction context for that row. With no rule cell set,
 * extraction falls back to the broad universe of all saved patterns
 * + OCR + AI inference. **Rules narrow; they don't gate.**
 *
 * Naming distinction worth preserving across the codebase:
 *   * `InvoiceTemplate` — Import Builder's column/rule output schema.
 *   * `InvoicePattern`  — Invoice Builder's visual extraction
 *                         template. The two are independent rows in
 *                         their own tables.
 */
export default function InvoiceBuilderRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Invoice Builder" />
      <div className="flex-1 min-h-0">
        <InvoiceBuilderPage />
      </div>
    </div>
  );
}
