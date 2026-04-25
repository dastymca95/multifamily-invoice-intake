"use client";

import { Bot, Send, Sparkles, User } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

import { pickMockReply } from "../lib/mock-replies";

/**
 * Local-only "talk to the help assistant" preview.
 *
 * Strict no-network contract: when the operator hits Send the panel
 * appends the user's message to a local transcript, waits a beat
 * (`MOCK_REPLY_DELAY_MS`) so the simulated typing reads as a reply
 * instead of an instant echo, then appends a canned assistant
 * message from `pickMockReply`. Nothing leaves the browser. The disabled
 * banner at the top of the panel makes the placeholder nature explicit
 * so operators don't waste time typing real questions expecting real
 * answers.
 *
 * When real AI wiring lands, this component swaps `pickMockReply` for
 * a streaming round-trip and removes the preview banner; the message
 * shape stays the same so persistence + history features can be
 * added without a rewrite.
 */
interface ChatMessage {
  /** Stable id for keyed rendering. */
  id: string;
  role: "user" | "assistant";
  text: string;
}

const MOCK_REPLY_DELAY_MS = 600;
const MAX_MESSAGE_LENGTH = 1000;

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "seed-1",
    role: "assistant",
    text:
      "Hi — I'm a placeholder for the in-app help assistant. Ask me anything and I'll show you how the wiring will feel once the assistant backend is live.",
  },
];

export function HelpChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [draft, setDraft] = useState("");
  // True while the mock reply timer is pending. Mirrors the
  // "assistant is typing" state of a real streaming reply so the
  // UI flow already has a place to render it.
  const [pending, setPending] = useState(false);

  // Track the assistant reply round number so the mock pool can
  // round-robin instead of repeating the same canned line every send.
  const [replyRound, setReplyRound] = useState(0);

  // Auto-scroll the transcript to the latest message on every append
  // (and on the typing indicator). Operators care about the bottom.
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending]);

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && !pending;

  const handleSend = () => {
    if (!canSend) return;
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      text: trimmed,
    };
    setMessages((prev) => [...prev, userMsg]);
    setDraft("");
    setPending(true);

    // Simulate assistant typing — purely client-side timer; bail out
    // safely if the component unmounts mid-wait. (No abort needed
    // since there's no real request to cancel.)
    const reply = pickMockReply(replyRound);
    const round = replyRound + 1;
    window.setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: "assistant", text: reply },
      ]);
      setReplyRound(round);
      setPending(false);
    }, MOCK_REPLY_DELAY_MS);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    handleSend();
  };

  // Enter sends; Shift+Enter inserts a newline. Standard chat input
  // affordance, mirrors the editor convention.
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden flex flex-col h-[28rem]">
      <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
        <Bot className="h-4 w-4 text-brand-600" aria-hidden />
        <h3 className="text-sm font-semibold text-gray-800">Help assistant</h3>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5">
          <Sparkles className="h-2.5 w-2.5" aria-hidden />
          Preview
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3 bg-gray-50/40">
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} />
        ))}
        {pending && <TypingIndicator />}
        <div ref={scrollAnchorRef} />
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-gray-200 bg-white px-3 py-2"
      >
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Ask the assistant a question (preview — replies are placeholders)"
            disabled={pending}
            className="flex-1 min-w-0 resize-none rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSend}
            title={
              pending
                ? "The mock assistant is replying…"
                : !trimmed
                  ? "Type a message to send"
                  : "Send message"
            }
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </Button>
        </div>
        <p className="text-[10.5px] text-gray-500 mt-1.5 leading-snug">
          Replies are local-only placeholders. The real assistant ships
          in a future release — no messages are sent to a server.
        </p>
      </form>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      className={cn(
        "flex items-start gap-2 max-w-[85%]",
        isUser ? "ml-auto flex-row-reverse" : "mr-auto",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center justify-center h-6 w-6 rounded-full shrink-0 mt-0.5",
          isUser ? "bg-brand-600 text-white" : "bg-gray-200 text-gray-700",
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
            : "bg-white border border-gray-200 text-gray-800 rounded-tl-sm",
        )}
      >
        {message.text}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 max-w-[85%]">
      <span
        className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-gray-200 text-gray-700 shrink-0"
        aria-hidden
      >
        <Bot className="h-3 w-3" />
      </span>
      <div className="rounded-lg px-3 py-2 text-[12.5px] bg-white border border-gray-200 text-gray-500 inline-flex items-center gap-1">
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
      className="inline-block h-1.5 w-1.5 rounded-full bg-gray-400 animate-bounce"
      style={{ animationDelay: delay }}
      aria-hidden
    />
  );
}
