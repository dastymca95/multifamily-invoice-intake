import { TopBar } from "@/components/layout/TopBar";
import { PatternList } from "@/features/vendor-patterns/components/PatternList";

export default function VendorPatternsPage() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Vendor Patterns" />
      <div className="flex-1 p-6">
        <PatternList />
      </div>
    </div>
  );
}
