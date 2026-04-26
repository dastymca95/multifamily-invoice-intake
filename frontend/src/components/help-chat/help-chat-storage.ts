/**
 * localStorage-backed persistence for the floating help chat.
 *
 * Two keys, both rivera-namespaced so they can't collide with the
 * separate `/help` page's in-page chat (`features/help-chat/*`) or
 * with theme/account preferences:
 *
 *   * `rivera-help-chat-open`     — "1" / "0" (boolean as char so the
 *                                    raw localStorage value is human-
 *                                    readable in DevTools).
 *   * `rivera-help-chat-messages` — JSON-serialised `ChatMessage[]`.
 *
 * SSR safety: every accessor checks `typeof window` and try/catches
 * the localStorage call so a private-mode browser, a sandbox iframe,
 * or a quota-exceeded write degrades gracefully to in-memory-only.
 *
 * The two state slices live behind their own helpers so callers
 * don't need to remember the key names; renaming or migrating to a
 * different store later only touches this module.
 */

export const HELP_CHAT_OPEN_KEY = "rivera-help-chat-open";
export const HELP_CHAT_MESSAGES_KEY = "rivera-help-chat-messages";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  /** Stable id used as the React key for the bubble. */
  id: string;
  role: ChatRole;
  text: string;
  /**
   * Wire-format ISO 8601. We store + read as a string so the JSON
   * round-trip stays lossless; the renderer can `new Date(ts)` if it
   * ever wants to surface it.
   */
  timestamp: string;
}

/**
 * Default welcome bubble injected the first time the panel opens
 * (and after a "Clear conversation" action). Kept here next to the
 * persistence layer so the seed contract is in one place.
 */
export const WELCOME_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "assistant",
  text:
    "Hi, I'm here to help with Rivera. Ask me about uploading invoices, " +
    "building import templates, invoice extraction patterns, or reference data.",
  timestamp: "1970-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Open / closed flag
// ---------------------------------------------------------------------------

/** Read the persisted open state. Defaults to false when missing. */
export function readChatOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HELP_CHAT_OPEN_KEY) === "1";
  } catch {
    // Private mode / quota / iframe sandbox — fall back to closed.
    return false;
  }
}

/**
 * Persist the open / closed flag. Silently no-ops when localStorage
 * isn't available — the in-memory state still works for the session,
 * the preference just doesn't survive a refresh.
 */
export function writeChatOpen(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HELP_CHAT_OPEN_KEY, next ? "1" : "0");
  } catch {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Read the persisted message list. Returns the empty array on:
 *   * SSR (no window)
 *   * Missing key
 *   * Malformed JSON (corruption / older shape)
 *   * Anything thrown by `JSON.parse` or the storage read
 *
 * Caller is expected to seed the welcome message when this returns
 * an empty list — see `FloatingHelpChat`.
 */
export function readChatMessages(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HELP_CHAT_MESSAGES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Light shape-check on each entry — drop anything that doesn't
    // smell like a ChatMessage rather than throwing on the whole
    // batch. A future schema change just gets dropped silently
    // instead of crashing the panel.
    return parsed.filter(isChatMessage);
  } catch {
    return [];
  }
}

/**
 * Persist the message list. Catches and swallows storage errors —
 * the panel keeps running on in-memory state when persistence
 * fails (e.g. quota exceeded after thousands of messages).
 */
export function writeChatMessages(messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      HELP_CHAT_MESSAGES_KEY,
      JSON.stringify(messages),
    );
  } catch {
    /* no-op */
  }
}

/** Drop the message list entirely (for the "Clear" affordance). */
export function clearChatMessages(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(HELP_CHAT_MESSAGES_KEY);
  } catch {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.role === "user" || v.role === "assistant") &&
    typeof v.text === "string" &&
    typeof v.timestamp === "string"
  );
}
