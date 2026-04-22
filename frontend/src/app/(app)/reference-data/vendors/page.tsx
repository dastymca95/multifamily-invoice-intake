import { TopBar } from "@/components/layout/TopBar";
import { ReferenceSourceWorkspace } from "@/features/reference/components/ReferenceSourceWorkspace";

/**
 * Vendors subpage.
 *
 * Independent working area that owns the vendor master data — the
 * vendor list and (where present) external identifiers BillsIQ matches
 * extracted invoice payees against. Future vendor-matching workflow will
 * live on this page; today it's a single-source upload + parsed preview.
 */
export default function VendorsReferenceRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Vendors" />
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <ReferenceSourceWorkspace
          kinds={["vendors"]}
          intro={
            <>
              <p className="text-sm text-gray-600">
                Vendor master data — the vendor list and any external
                identifiers BillsIQ should match extracted invoice payees
                against. Unknown vendors surface in the review queue so you
                can decide whether to add or rename them in ResMan.
              </p>
              <p className="text-[11px] text-gray-400 mt-1">
                Re-upload at any time to replace the stored copy — there&apos;s
                no version history.
              </p>
            </>
          }
        />
      </div>
    </div>
  );
}
