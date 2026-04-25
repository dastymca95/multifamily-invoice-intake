/**
 * Local-only mock reply pool for the Help Chat surface.
 *
 * The chat panel is intentionally NOT wired to a real assistant
 * backend yet — we render a friendly canned response so operators
 * who try the input get an explanation of why the reply isn't
 * substantive, plus a pointer at the FAQ cards above.
 *
 * Why a small rotation instead of a single fixed string: makes the
 * preview surface read as "this is intentionally a placeholder"
 * rather than "this is broken and stuck on one message".
 *
 * Adding real assistant wiring is a separate effort. When that
 * lands, swap `pickMockReply` out at the call site for an actual
 * round-trip; the chat panel's view-model contract stays the same.
 */
export const MOCK_PLACEHOLDER_REPLIES: readonly string[] = [
  "Thanks for the question! I'm a placeholder for the in-app help assistant — the real assistant lights up in a future release. In the meantime, the FAQ cards above link straight into each workspace and cover the most common how-do-I questions.",
  "Got it — once the assistant backend is wired up I'll be able to walk you through this step by step. For now, the FAQ cards above point at the workspace you're asking about; pop in there and the inline tooltips will fill in the rest.",
  "Heard you. I'm not connected to a real knowledge base yet, so I can't quote chapter and verse on this one. The fastest path today is the FAQ above plus the in-product tooltips on each workspace's toolbar.",
  "Noted — full assistant replies are coming soon. While you wait, the FAQ cards above are the most up-to-date source for product-level questions. If you're stuck on something specific, your account manager can help in the meantime.",
];

/**
 * Pick a mock reply for a given user prompt. The prompt isn't
 * actually inspected — we round-robin by index. Implementation kept
 * deterministic so the same prompt never gets a different stub
 * across renders within the same chat session.
 */
export function pickMockReply(roundIndex: number): string {
  const safe = Math.max(0, Math.floor(roundIndex));
  return MOCK_PLACEHOLDER_REPLIES[safe % MOCK_PLACEHOLDER_REPLIES.length];
}
