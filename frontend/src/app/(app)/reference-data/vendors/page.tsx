import { TopBar } from "@/components/layout/TopBar";
import { VendorsPage } from "@/features/vendor-catalogs/components/VendorsPage";

/**
 * Route shell for the Vendors subpage.
 *
 * Mounts the Vendors builder workspace — the vendor master sibling of
 * the GL Codes / Properties builders. Each saved catalog defines the
 * canonical vendor list (name + code + aliases + address + contact)
 * BillsIQ will use to match extracted invoice payees against.
 *
 * The workspace itself lives in
 * `features/vendor-catalogs/components/VendorsPage.tsx`; this file is
 * just the App-Router entry point + the TopBar wrapper so the page
 * lines up with the rest of the Reference Data area.
 *
 * Replaces the previous upload-only `ReferenceSourceWorkspace` view —
 * that page treated uploaded vendor files as the persisted artifact;
 * the new builder treats uploads as one-shot source formats that get
 * mapped into BillsIQ's canonical vendor structure before becoming
 * editable catalogs.
 */
export default function VendorsReferenceRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Vendors" />
      <div className="flex-1 min-h-0">
        <VendorsPage />
      </div>
    </div>
  );
}
