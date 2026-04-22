import { TopBar } from "@/components/layout/TopBar";
import { ReferenceSourceWorkspace } from "@/features/reference/components/ReferenceSourceWorkspace";

/**
 * Properties subpage.
 *
 * Independent working area that owns the property master data — both the
 * Property report (names / abbreviations / addresses) and the Unit
 * report (units + property/unit relationships). The Unit report sits
 * here rather than in its own subpage because units only make sense in
 * the context of properties; from the user's perspective this page is
 * "the property + unit master data lives here".
 *
 * Each report is independently uploadable / replaceable / removable
 * inside its own card; uploads are routed through the existing
 * /reference-data/{kind} endpoints, so no backend change is required.
 */
export default function PropertiesReferenceRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Properties" />
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <ReferenceSourceWorkspace
          kinds={["properties", "units"]}
          intro={
            <>
              <p className="text-sm text-gray-600">
                Property master data — names, abbreviations, addresses, and the
                unit roster. BillsIQ uses the Property report to match invoices
                to property abbreviations on export, and the Unit report to
                resolve unit-level charges back to the right property.
              </p>
              <p className="text-[11px] text-gray-400 mt-1">
                Each report can be re-uploaded at any time to replace the
                stored copy — there&apos;s no version history.
              </p>
            </>
          }
        />
      </div>
    </div>
  );
}
