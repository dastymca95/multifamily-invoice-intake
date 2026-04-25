import {
  Database,
  Download,
  FileSearch,
  LayoutGrid,
  type LucideIcon,
  Upload,
} from "lucide-react";

/**
 * Static FAQ catalog rendered as cards on the Help page. Each entry
 * deep-links into the workspace it talks about so an operator can
 * jump straight there from the help surface.
 *
 * Why a hand-curated list instead of crawled docs: the workspace
 * count is small (5 product surfaces) and the operator's questions
 * cluster around the same handful of intents per workspace. A short
 * list of high-quality cards beats a long auto-generated index for
 * this product surface; we can graduate to a search-indexed help
 * center once the question funnel justifies the maintenance.
 *
 * Each `body` is a pair of short paragraphs — one stating what the
 * workspace does, one pointing at the most common operator action.
 * Kept short enough to fit on a card without truncation at the
 * default viewport width.
 */
export interface FaqCard {
  id: string;
  title: string;
  icon: LucideIcon;
  /**
   * Deep-link target inside the app. Click-through navigates the
   * operator to the workspace described in the card body.
   */
  workspaceHref: string;
  /**
   * Human-readable label for the deep-link button.
   */
  workspaceLabel: string;
  /**
   * Multi-paragraph body. Rendered with whitespace preserved.
   */
  body: string[];
}

export const FAQ_CARDS: readonly FaqCard[] = [
  {
    id: "uploading-invoices",
    title: "Uploading invoices",
    icon: Upload,
    workspaceHref: "/upload",
    workspaceLabel: "Open Upload",
    body: [
      "Drag a PDF or image into the Upload page (or pick files via the file picker) and BillsIQ groups them into a batch for OCR + extraction.",
      "Once a batch finishes processing, head to Review Queue to confirm the extracted fields, fix any low-confidence cells, and approve documents for export.",
    ],
  },
  {
    id: "import-builder",
    title: "Import Builder",
    icon: LayoutGrid,
    workspaceHref: "/import-builder",
    workspaceLabel: "Open Import Builder",
    body: [
      "Import Builder is where you design the final import schema — column shape, required vs. optional, and per-column value sources (catalogs, fixed values, manual lists, or invoice-field extraction).",
      "Add rules to override the default value source for specific groups of documents (e.g. \"vendor = ACME → use Account Number from this pattern\").",
    ],
  },
  {
    id: "invoice-builder",
    title: "Invoice Builder",
    icon: FileSearch,
    workspaceHref: "/invoice-builder",
    workspaceLabel: "Open Invoice Builder",
    body: [
      "Invoice Builder owns visual extraction patterns. Upload a sample bill, draw boxes on it, and assign each box to one of the canonical extracted invoice fields.",
      "Saved patterns plug into Import Builder rule cells — the runtime extractor uses the pinned regions as a strong hint for which value to pull on similar bills.",
    ],
  },
  {
    id: "reference-data",
    title: "Reference Data",
    icon: Database,
    workspaceHref: "/reference-data",
    workspaceLabel: "Open Reference Data",
    body: [
      "Reference Data is your library of business entities — GL Codes, Properties, and Vendors. Import them via CSV or maintain them in-app; Import Builder columns can bind directly to a catalog so values stay consistent across exports.",
      "Each catalog has its own working area with previews, validation, and version history.",
    ],
  },
  {
    id: "exports",
    title: "Exports",
    icon: Download,
    workspaceHref: "/exports",
    workspaceLabel: "Open Exports",
    body: [
      "Exports turn approved batches into the file shapes your downstream accounting system expects (CSV, XLSX, or system-specific formats). Each export uses an Import Builder template to drive the column shape.",
      "Run an export ad hoc, or schedule recurring exports for end-of-day / end-of-week cadences.",
    ],
  },
];
