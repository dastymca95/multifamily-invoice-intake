/**
 * Floating help chat — public surface.
 *
 * Mount `<FloatingHelpChat />` ONCE in the authenticated app shell
 * so it persists across route changes. Don't mount per-page.
 *
 * Distinct from the full Help Center at `/help`
 * (`features/help-chat/*`) — that's the deep FAQ + chat surface.
 * The floating chat is the always-available quick-question
 * shortcut. Their localStorage keys, message arrays, and
 * components are intentionally separate.
 */
export { FloatingHelpChat } from "./FloatingHelpChat";
