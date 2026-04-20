import { TopBar } from "@/components/layout/TopBar";
import { BatchDetail } from "@/features/batches/components/BatchDetail";

interface PageProps {
  params: { batchId: string };
}

export default function BatchDetailPage({ params }: PageProps) {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Batch Detail" />
      <BatchDetail batchId={params.batchId} />
    </div>
  );
}
