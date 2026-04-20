import { TopBar } from "@/components/layout/TopBar";
import { ExportForm } from "@/features/exports/components/ExportForm";

export default function ExportsPage() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Exports" />
      <div className="flex-1 p-6 max-w-2xl">
        <ExportForm />
      </div>
    </div>
  );
}
