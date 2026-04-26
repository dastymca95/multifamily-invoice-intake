"use client";

import {
  Bot,
  ExternalLink,
  MessageCircle,
  Send,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

import {
  type ChatMessage,
  clearChatMessages,
  readChatMessages,
  readChatOpen,
  WELCOME_MESSAGE,
  writeChatMessages,
  writeChatOpen,
} from "./help-chat-storage";
import { pickMockReply, SUGGESTION_PROMPTS } from "./mock-replies";

/**
 * Persistent floating help chat — mounted once inside the
 * authenticated app shell, visible across every page.
 *
 * Two surfaces:
 *
 *   1. **Launcher** — a circular brand-blue button pinned to the
 *      bottom-right corner. Visible when the panel is closed; hidden
 *      while the panel is open (the panel's own header carries the
 *      close affordance).
 *
 *   2. **Panel** — a compact chat window that slides up over the
 *      page. Header (title + clear + close), suggestion chips when
 *      the conversation is empty, message transcript, input + send.
 *
 * State persistence:
 *   * Open / closed flag → `rivera-help-chat-open` (localStorage)
 *   * Message transcript → `rivera-help-chat-messages` (localStorage)
 *   * The component itself stays mounted across route changes via
 *     the AppShell, so navigation doesn't reset in-flight typing.
 *
 * Hydration: SSR can't read localStorage, so the component renders
 * NOTHING on the first paint and lifts to its real state in an
 * effect on mount. Fixed-position chrome appearing after hydration
 * is invisible to the layout (no shift) — the trade-off keeps the
 * SSR/CSR markup matched.
 *
 * No real assistant: every reply comes from `pickMockReply` (local
 * keyword routing). The fallback text and suggestion prompts steer
 * operators toward the in-app workspaces; the full Help Center
 * deep-link in the header sends them to `/help` for the FAQ cards.
 */
const MOCK_REPLY_DELAY_MS = 600;
const MAX_MESSAGE_LENGTH = 1000;

export function FloatingHelpChat() {
  // `mounted` gates the entire render. We start with the SSR
  // defaults (closed, empty) and lift to localStorage values inside
  // a mount effect so hydration matches.
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  // True while the mock reply timer is in flight. Mirrors the
  // "assistant is typing" state of a real streaming reply.
  const [pending, setPending] = useState(false);
  // Round-robin counter (currently unused — kept for the round-robin
  // fallback variant if the keyword router is ever generalised).
  const [replyRound, setReplyRound] = useState(0);

  // ---- Hydration boot ------------------------------------------------
  useEffect(() => {
    setMounted(true);
    setOpen(readChatOpen());
    const stored = readChatMessages();
    // First-run / cleared seed: drop the welcome message in.
    setMessages(stored.length > 0 ? stored : [WELCOME_MESSAGE]);
  }, []);

  // ---- Persistence: open flag ---------------------------------------
  useEffect(() => {
    if (!mounted) return;
    writeChatOpen(open);
  }, [open, mounted]);

  // ---- Persistence: messages ----------------------------------------
  // Skips writing back on the very first effect tick (when the boot
  // effect just landed) so a fresh load doesn't immediately overwrite
  // valid storage with the welcome-only seed if the welcome happened
  // to be the only thing already there. The `messages` reference
  // stays stable across renders unless a write actually happens.
  useEffect(() => {
    if (!mounted) return;
    writeChatMessages(messages);
  }, [messages, mounted]);

  // ---- Auto-scroll on append + typing -------------------------------
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, open]);

  // ---- Focus the input on open --------------------------------------
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!open) return;
    // Defer to next frame so the panel is mounted + visible before
    // we steal focus; otherwise some browsers no-op the call.
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // ---- Escape closes the panel --------------------------------------
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // ---- Send + reply --------------------------------------------------
  const submitPrompt = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || pending) return;
      const now = new Date().toISOString();
      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        text: trimmed,
        timestamp: now,
      };
      setMessages((prev) => [...prev, userMsg]);
      setDraft("");
      setPending(true);

      // Compute reply NOW (synchronously) and surface it after a
      // simulated typing delay. Round-robin counter keeps the
      // fallback path varied if the keyword router ever stops
      // hitting (which doesn't happen today — every prompt routes
      // through `pickMockReply`).
      const reply = pickMockReply(trimmed);
      const round = replyRound + 1;
      window.setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: reply,
            timestamp: new Date().toISOString(),
          },
        ]);
        setReplyRound(round);
        setPending(false);
      }, MOCK_REPLY_DELAY_MS);
    },
    [pending, replyRound],
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitPrompt(draft);
  };

  // Enter sends; Shift+Enter inserts a newline. Standard chat input
  // affordance.
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitPrompt(draft);
    }
  };

  const handleClear = useCallback(() => {
    clearChatMessages();
    setMessages([WELCOME_MESSAGE]);
  }, []);

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && !pending;
  // The empty state shows suggestion chips when only the welcome
  // bubble is present — once the operator has actually had a back-
  // and-forth, the chips clear so the transcript breathes.
  const showSuggestions =
    messages.length <= 1 && messages[0]?.id === WELCOME_MESSAGE.id;

  // Render nothing until hydrated — keeps SSR / CSR markup matched
  // (the storage reads in the boot effect would otherwise produce a
  // server/client mismatch on `open`).
  if (!mounted) return null;

  return (
    <>
      {/* ---- Launcher button ---------------------------------------
          Hidden when the panel is open — the panel header owns the
          close affordance. Pinned bottom-right. Z-index puts it
          above page content but BELOW global modals (Modal scrim is
          z-50; this is z-40 so it doesn't punch through dialogs). */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open Rivera help chat"
          title="Help"
          className={cn(
            "fixed z-40 bottom-6 right-6 sm:bottom-6 sm:right-6",
            "inline-flex items-center gap-2 rounded-full",
            "bg-brand-600 text-white shadow-lg",
            "hover:bg-brand-700 active:scale-95 transition-all",
            "px-4 py-3",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-surface",
          )}
        >
          <MessageCircle className="h-5 w-5" />
          <span className="text-sm font-semibold hidden sm:inline">Help</span>
        </button>
      )}

      {/* ---- Panel -------------------------------------------------
          Fixed bottom-right on desktop; full-width minus padding on
          mobile. Z-index 40 (same as launcher; mutually exclusive
          via the !open check above) so it sits above page chrome
          but under modals. Border + shadow gives the panel weight
          against either light or dark workspace bg. */}
      {open && (
        <section
          role="dialog"
          aria-label="Rivera help chat"
          className={cn(
            "fixed z-40 flex flex-col overflow-hidden rounded-2xl shadow-2xl border",
            // Mobile: pinned to corner with breathing room.
            "bottom-4 right-4 left-4 max-h-[calc(100vh-6rem)]",
            // Desktop: fixed width on the right edge, taller.
            "sm:left-auto sm:bottom-6 sm:right-6 sm:w-[26rem] sm:max-h-[34rem] sm:h-[34rem]",
            // Theme surfaces.
            "bg-white border-gray-200",
            "dark:bg-surface-subtle dark:border-line",
          )}
        >
          <ChatHeader onClose={() => setOpen(false)} onClear={handleClear} />

          {/* Suggestion chips are surfaced in the empty state above
              the transcript so the operator sees them before
              anything else, and again above the input below for
              ongoing easy access. Conditional on `showSuggestions`
              so they fade out once a real conversation starts. */}
          <div
            className={cn(
              "flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3",
              // Slightly tinted scrollable area so the bubbles read
              // as cards on top of a workspace surface (matches the
              // pattern used in the in-page Help chat).
              "bg-gray-50/40 dark:bg-surface/60",
            )}
          >
            {messages.map((m) => (
              <ChatBubble key={m.id} message={m} />
            ))}
            {pending && <TypingIndicator />}
            <div ref={scrollAnchorRef} />
          </div>

          {showSuggestions && (
            <div className="px-3 py-2 border-t border-gray-100 dark:border-line/60 flex flex-wrap gap-1.5">
              {SUGGESTION_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => submitPrompt(prompt)}
                  disabled={pending}
                  className={cn(
                    "px-2 py-1 rounded-full text-[11.5px] border transition-colors",
                    "border-gray-200 bg-white text-gray-700 hover:border-brand-400 hover:text-brand-700",
                    "dark:border-line dark:bg-surface dark:text-ink-muted dark:hover:border-brand-500 dark:hover:text-brand-50",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                  )}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className={cn(
              "border-t px-3 py-2 space-y-1.5",
              "border-gray-200 bg-white",
              "dark:border-line dark:bg-surface-subtle",
            )}
          >
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) =>
                  setDraft(e.target.value.slice(0, MAX_MESSAGE_LENGTH))
                }
                onKeyDown={handleKeyDown}
                rows={2}
                placeholder="Ask about Rivera (preview — replies are local)"
                disabled={pending}
                aria-label="Message"
                className={cn(
                  "flex-1 min-w-0 resize-none rounded-md border px-2.5 py-1.5 text-[13px]",
                  "border-gray-300 bg-white text-gray-800 placeholder:text-gray-400",
                  "dark:border-line dark:bg-surface dark:text-ink dark:placeholder:text-ink-subtle",
                  "focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500",
                  "disabled:bg-gray-50 dark:disabled:bg-surface-muted",
                )}
              />
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send message"
                title={
                  pending
                    ? "Assistant is replying…"
                    : !trimmed
                      ? "Type a message to send"
                      : "Send message (Enter)"
                }
                className={cn(
                  "shrink-0 inline-flex items-center justify-center rounded-md",
                  "h-9 w-9 transition-colors",
                  "bg-brand-600 text-white hover:bg-brand-700",
                  "disabled:bg-gray-300 disabled:cursor-not-allowed",
                  "dark:disabled:bg-surface-muted dark:disabled:text-ink-subtle",
                )}
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10.5px] text-gray-500 dark:text-ink-subtle leading-snug">
                Local preview · no messages leave the browser
              </p>
              <Link
                href="/help"
                onClick={() => setOpen(false)}
                className="inline-flex items-center gap-0.5 text-[10.5px] text-brand-700 dark:text-brand-50 hover:underline shrink-0"
                title="Open the full Help Center"
              >
                Help Center
                <ExternalLink className="h-2.5 w-2.5" />
              </Link>
            </div>
          </form>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Header — title row + clear + close
// ---------------------------------------------------------------------------

function ChatHeader({
  onClose,
  onClear,
}: {
  onClose: () => void;
  onClear: () => void;
}) {
  return (
    <header
      className={cn(
        "shrink-0 flex items-center gap-2 px-3 py-2.5 border-b",
        "bg-white border-gray-200",
        "dark:bg-surface-subtle dark:border-line",
      )}
    >
      <span
        className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-brand-50 text-brand-700 shrink-0 dark:bg-brand-900/40 dark:text-brand-50"
        aria-hidden
      >
        <Bot className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 dark:text-ink leading-tight">
          Rivera Assistant
        </p>
        <p className="text-[10.5px] text-gray-500 dark:text-ink-muted leading-tight">
          Ask about uploads, Import Builder, Invoice Builder, or Reference Data.
        </p>
      </div>
      <span
        className="hidden sm:inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 dark:bg-yellow-950/40 dark:text-yellow-200"
        title="Replies are local placeholders — the live assistant ships in a future release"
      >
        <Sparkles className="h-2.5 w-2.5" />
        Preview
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear conversation"
        title="Clear conversation"
        className="shrink-0 p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-ink-subtle dark:hover:bg-surface-muted dark:hover:text-ink"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close help chat"
        title="Close (Esc)"
        className="shrink-0 p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-ink-subtle dark:hover:bg-surface-muted dark:hover:text-ink"
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      className={cn(
        "flex items-start gap-2 max-w-[88%]",
        isUser ? "ml-auto flex-row-reverse" : "mr-auto",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center justify-center h-6 w-6 rounded-full shrink-0 mt-0.5",
          isUser
            ? "bg-brand-600 text-white"
            : "bg-gray-200 text-gray-700 dark:bg-surface-muted dark:text-ink-muted",
        )}
        aria-hidden
      >
        {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
      </span>
      <div
        className={cn(
          "rounded-lg px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap",
          isUser
            ? "bg-brand-600 text-white rounded-tr-sm"
            : "bg-white border border-gray-200 text-gray-800 rounded-tl-sm dark:bg-surface-subtle dark:border-line dark:text-ink",
        )}
      >
        {message.text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typing indicator — mirrors the in-page Help chat's three-dot bounce
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 max-w-[88%]">
      <span
        className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-gray-200 text-gray-700 shrink-0 dark:bg-surface-muted dark:text-ink-muted"
        aria-hidden
      >
        <Bot className="h-3 w-3" />
      </span>
      <div className="rounded-lg px-3 py-2 text-[12.5px] bg-white border border-gray-200 text-gray-500 inline-flex items-center gap-1 dark:bg-surface-subtle dark:border-line dark:text-ink-subtle">
        <Dot delay="0ms" />
        <Dot delay="120ms" />
        <Dot delay="240ms" />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-gray-400 dark:bg-ink-subtle animate-bounce"
      style={{ animationDelay: delay }}
      aria-hidden
    />
  );
}
