import { TopBar } from "@/components/layout/TopBar";
import { HelpPage } from "@/features/help-chat/components/HelpPage";

/**
 * Route shell for the Help Center.
 *
 * Same one-liner pattern as the Dashboard route — TopBar at the top,
 * the feature's composition root underneath. The feature owns the
 * FAQ grid + mock help chat surfaces; this file just hosts them
 * inside the standard app frame.
 */
export default function HelpRoute() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Help" />
      <div className="flex-1 overflow-y-auto">
        <HelpPage />
      </div>
    </div>
  );
}
