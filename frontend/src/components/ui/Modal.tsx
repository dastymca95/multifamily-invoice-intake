"use client";

import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}

const sizes = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export function Modal({ open, onClose, title, children, size = "md" }: ModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Scrim deepens slightly in dark mode (0.4 → 0.6) so the
          dialog still pops against the already-dark page bg. */}
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60"
        onClick={onClose}
      />
      <div
        className={cn(
          "relative w-full mx-4 rounded-xl shadow-xl",
          "bg-white dark:bg-surface-subtle border border-gray-200 dark:border-line",
          sizes[size],
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-line">
          <h2 className="text-base font-semibold text-gray-900 dark:text-ink">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-ink-subtle dark:hover:bg-surface-muted dark:hover:text-ink"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}
