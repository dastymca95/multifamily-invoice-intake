import { TopBar } from "@/components/layout/TopBar";
import { ReviewQueue } from "@/features/review/components/ReviewQueue";

export default function ReviewQueuePage() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Review Queue" />
      <div className="flex-1 p-6">
        <ReviewQueue />
      </div>
    </div>
  );
}
