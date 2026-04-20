import { TopBar } from "@/components/layout/TopBar";
import { InvoiceReviewPanel } from "@/features/review/components/InvoiceReviewPanel";

interface Props {
  params: { documentId: string };
}

export default function ReviewDetailPage({ params }: Props) {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Review Invoice" />
      <div className="flex-1 overflow-hidden">
        <InvoiceReviewPanel documentId={params.documentId} />
      </div>
    </div>
  );
}
