import { cn } from "@/lib/utils";
import { type ButtonHTMLAttributes, forwardRef } from "react";

// `dark:*` overrides keep the button readable across themes without
// changing the brand identity:
//   * primary stays brand blue in both modes (Rivera blue is a
//     constant — see the brand-color note in tailwind.config.ts)
//   * secondary swaps its white-on-gray-border surface for the slate
//     surface tokens
//   * danger keeps the red accent (red palette stays usable on dark)
//   * ghost is purely chrome and follows the surface tokens
const variants = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-500",
  secondary:
    "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 " +
    "dark:bg-surface-subtle dark:text-ink dark:border-line dark:hover:bg-surface-muted",
  danger:
    "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500",
  ghost:
    "text-gray-600 hover:bg-gray-100 " +
    "dark:text-ink-muted dark:hover:bg-surface-muted",
};

const sizes = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-base",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", loading, className, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {loading && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {children}
    </button>
  )
);
Button.displayName = "Button";
