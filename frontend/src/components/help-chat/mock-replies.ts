/**
 * Local-only assistant reply generator for the floating help chat.
 *
 * No network calls — strictly client-side keyword routing. The chat
 * panel calls `pickMockReply(prompt)` whenever the user sends a
 * message; this function classifies the prompt and returns one of:
 *
 *   * A topic-specific explainer (Upload, Import Builder, Invoice
 *     Builder, Reference Data, validation/readiness)
 *   * A generic fallback that nudges the user toward the topic chips
 *
 * The matching is intentionally loose (`includes`, lower-cased)
 * because the value here is "feels responsive to context", not
 * intent recognition. When the real assistant lands, swap this
 * single function out for a streaming round-trip — the call site
 * (`FloatingHelpChat`) keeps its message-shape contract.
 */

const FALLBACK_REPLY =
  "I'm not connected to the live assistant yet, but this help chat will " +
  "soon guide you through Rivera workflows. For now, try asking about " +
  "Upload, Import Builder, Invoice Builder, or Reference Data — or open " +
  "the full Help Center for FAQ cards.";

/**
 * Each rule pairs a keyword set with its canned answer. Order
 * matters: rules earlier in the list win when a prompt mentions
 * multiple topics, so place the more specific topics (e.g.
 * "validation") above the broader ones (e.g. "import builder")
 * when adding new rules.
 */
interface ReplyRule {
  keywords: readonly string[];
  reply: string;
}

const RULES: readonly ReplyRule[] = [
  // --- Validation / template readiness --------------------------------
  // Placed FIRST because "validate" / "ready" are likely to co-occur
  // with "import builder" or "template", and the validation answer is
  // more useful when the operator's actual question is about it.
  {
    keywords: ["validate", "validation", "readiness", "not ready", "ready"],
    reply:
      "The Validate button checks whether an Import Builder template is " +
      "ready. It reports missing required sources, broken catalog " +
      "references, hidden fields, missing regions, and other readiness " +
      "issues — fix the listed errors and re-run to confirm.",
  },

  // --- Upload ---------------------------------------------------------
  {
    keywords: ["upload", "uploading", "uploaded"],
    reply:
      "Upload is where batches of invoice PDFs/images enter Rivera. After " +
      "upload, documents can move into review, extraction, and export " +
      "workflows. Each batch keeps its files together so reviewers can " +
      "process them as a group.",
  },

  // --- Import Builder -------------------------------------------------
  // Match both the spaced and concatenated forms.
  {
    keywords: ["import builder", "import-builder", "import template"],
    reply:
      "Import Builder defines the final output schema and rules. It " +
      "controls columns, required fields, value sources, catalog " +
      "bindings, and invoice extraction bindings. Save a template, then " +
      "use it to drive exports.",
  },

  // --- Invoice Builder -----------------------------------------------
  {
    keywords: ["invoice builder", "invoice-builder", "extraction pattern", "pattern"],
    reply:
      "Invoice Builder is the visual extraction template editor. You " +
      "upload sample invoices, draw regions, assign fields, and train " +
      "Rivera where invoice data lives on a real bill — saved patterns " +
      "feed the runtime extractor.",
  },

  // --- Reference Data ------------------------------------------------
  {
    keywords: [
      "reference data",
      "reference-data",
      "gl code",
      "gl codes",
      "vendor",
      "vendors",
      "property",
      "properties",
      "catalog",
    ],
    reply:
      "Reference Data stores master catalogs like GL Codes, Properties, " +
      "and Vendors. Import Builder can use those catalogs to validate " +
      "and fill output fields — keep them current and your exports stay " +
      "consistent.",
  },
];

/**
 * Classify a prompt and return the matching canned reply. Lower-cased
 * substring match against each rule's keyword set, first match wins.
 * Empty / whitespace-only prompts are caller-validated upstream so
 * this never gets the empty string.
 */
export function pickMockReply(prompt: string): string {
  const haystack = prompt.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((kw) => haystack.includes(kw))) {
      return rule.reply;
    }
  }
  return FALLBACK_REPLY;
}

/**
 * Quick-action chips shown in the empty state and above the input.
 * Clicking one fires it as a user message + triggers the matching
 * mock reply via the same `pickMockReply` path so suggestions and
 * typed prompts flow through the same code path.
 *
 * Order mirrors the operator's typical learning path through the
 * product (Upload → Import Builder → Invoice Builder → Reference
 * Data → readiness diagnostics).
 */
export const SUGGESTION_PROMPTS: readonly string[] = [
  "How do I upload invoices?",
  "What is Import Builder?",
  "What is Invoice Builder?",
  "How does Reference Data work?",
  "Why is my template not ready?",
];
