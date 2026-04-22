import { TopBar } from "@/components/layout/TopBar";
import { GLCodesPage } from "@/features/gl-catalogs/components/GLCodesPage";

/**
 * Route shell for the GL Codes subpage.
 *
 * Mounts the GL Codes builder workspace — the chart-of-accounts
 * sibling of the Invoice Template Builder. Each saved catalog defines
 * the rows (one per GL code) the user later validates / maps invoice
 * line-items against. The actual workspace lives in
 * `features/gl-catalogs/components/GLCodesPage.tsx`; this file is just
 * the App-Router entry point + the TopBar wrapper so the page lines up
 * with the rest of the Reference Data area.
 */
export default function GlCodesRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="GL Codes" />
      <div className="flex-1 min-h-0">
        <GLCodesPage />
      </div>
    </div>
  );
}
