import { TopBar } from "@/components/layout/TopBar";
import { ImportPreviewPage } from "@/features/import-builder/components/ImportPreviewPage";

/**
 * Route shell for the Import Preview workspace.
 *
 * This page used to live at `/import-builder` and be the "Import
 * Builder," but the product surface called the Import Builder is now
 * the evolved schema-design experience under `/import-builder`
 * (formerly Invoice Template Builder, promoted out of Reference
 * Data). This page is the *preview* of how invoices would map into a
 * given configuration's column shape — that's a runtime concern, not
 * a contract-design concern, hence the relocation to `/import-preview`.
 *
 * Three-column workspace with internal scroll regions, so the outer
 * container uses `overflow-hidden` and lets each column manage its
 * own overflow.
 */
export default function ImportPreviewRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Import Preview" />
      <div className="flex-1 min-h-0 overflow-hidden">
        <ImportPreviewPage />
      </div>
    </div>
  );
}
