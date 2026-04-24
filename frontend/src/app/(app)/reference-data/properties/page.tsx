import { TopBar } from "@/components/layout/TopBar";
import { PropertiesPage } from "@/features/property-catalogs/components/PropertiesPage";

/**
 * Route shell for the Properties subpage.
 *
 * Mounts the Properties (property/unit master data) builder workspace
 * — sibling of the GL Codes and Invoice Template builders. Each saved
 * property catalog defines the canonical rows BillsIQ keys property
 * abbreviation matching, export mapping, and unit-level charge
 * resolution against. The actual workspace lives in
 * `features/property-catalogs/components/PropertiesPage.tsx`; this
 * file is just the App-Router entry point + the TopBar wrapper so the
 * page lines up with the rest of the Reference Data area.
 */
export default function PropertiesReferenceRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Properties" />
      <div className="flex-1 min-h-0">
        <PropertiesPage />
      </div>
    </div>
  );
}
