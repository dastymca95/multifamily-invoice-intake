import { TopBar } from "@/components/layout/TopBar";
import { BatchUploadForm } from "@/features/upload/components/BatchUploadForm";

export default function UploadPage() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Upload Documents" />
      {/* Wider container so the two-column workspace (controls + visualizer)
          has room to breathe on standard 1280-wide laptop screens. */}
      {/* The workspace owns its own scroll regions — the controls column,
          document list, and preview each scroll independently — so the
          outer container is fixed-height with `overflow-hidden`. This is
          what lets the preview pane fill the viewport and render PDFs at
          a useful scale instead of being stuck at a fixed inner height. */}
      <div className="flex-1 min-h-0 overflow-hidden p-4">
        <BatchUploadForm />
      </div>
    </div>
  );
}
