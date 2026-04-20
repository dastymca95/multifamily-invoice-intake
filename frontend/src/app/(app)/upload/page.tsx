import { TopBar } from "@/components/layout/TopBar";
import { BatchUploadForm } from "@/features/upload/components/BatchUploadForm";

export default function UploadPage() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Upload Documents" />
      <div className="flex-1 p-6 max-w-3xl">
        <BatchUploadForm />
      </div>
    </div>
  );
}
