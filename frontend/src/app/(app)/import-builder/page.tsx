import { TopBar } from "@/components/layout/TopBar";
import { ImportBuilderPage } from "@/features/import-builder/components/ImportBuilderPage";

/**
 * Route shell for the Import Builder workspace.
 *
 * Unlike the Reference Data page (vertical card stack), the Import
 * Builder is a three-column workspace with its own internal scroll
 * regions, so the outer container uses `overflow-hidden` and lets each
 * column manage its own overflow.
 */
export default function ImportBuilderRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Import Builder" />
      <div className="flex-1 min-h-0 overflow-hidden">
        <ImportBuilderPage />
      </div>
    </div>
  );
}
