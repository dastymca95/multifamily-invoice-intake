import { redirect } from "next/navigation";

/**
 * Parent /reference-data route — navigation-only.
 *
 * Reference Data is a navigation group, not an operational workspace.
 * The three subareas (GL Codes, Properties, Vendors) each own their
 * own uploads, previews, and local workflows; there is intentionally
 * no shared "all sources live here" page.
 *
 * Visiting /reference-data directly forwards to GL Codes (the
 * canonical first subarea now that the former "Invoice Template
 * Builder" child has been promoted to the top-level Import Builder
 * workspace at /import-builder). Server-side redirect — no mixed-UI
 * placeholder is rendered, even briefly.
 */
export default function ReferenceDataIndex() {
  redirect("/reference-data/gl-codes");
}
