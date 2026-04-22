import { redirect } from "next/navigation";

/**
 * Parent /reference-data route — navigation-only.
 *
 * Reference Data is a navigation group, not an operational workspace.
 * The four subareas (Invoice Template Builder, GL Codes, Properties,
 * Vendors) each own their own uploads, previews, and local workflows;
 * there is intentionally no shared "all sources live here" page
 * anymore.
 *
 * Visiting /reference-data directly forwards to the canonical first
 * subarea (Invoice Template Builder). Server-side redirect — no
 * mixed-UI placeholder is rendered, even briefly.
 */
export default function ReferenceDataIndex() {
  redirect("/reference-data/invoice-template");
}
