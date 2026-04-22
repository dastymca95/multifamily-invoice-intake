import { TopBar } from "@/components/layout/TopBar";
import { InvoiceTemplatePage } from "@/features/invoice-templates/components/InvoiceTemplatePage";

/**
 * Route shell for the Invoice Template Builder subpage.
 *
 * The builder is a saved-templates workspace: a left rail of saved
 * templates + a center editor for the column shape (rename / add /
 * remove / reorder) + a horizontally-scrolling spreadsheet preview.
 *
 * When the user has nothing saved yet, the editor opens on an editable
 * draft of the canonical default template — saving it promotes it to
 * a real persisted template. Existing ResMan template uploads (managed
 * on the Reference Data overview page) remain available as an optional
 * starting point in the "New template" modal.
 */
export default function InvoiceTemplateRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Invoice Template Builder" />
      <div className="flex-1 min-h-0">
        <InvoiceTemplatePage />
      </div>
    </div>
  );
}
