import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

// Each color tone gets a paired dark variant: a translucent tinted
// background on the slate page surface plus a lifted text color so
// the chip stays readable. Same emotional read as the light tones.
const colors = {
  gray: "bg-gray-100 text-gray-700 dark:bg-surface-muted dark:text-ink-muted",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200",
  green:
    "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-200",
  yellow:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-200",
  red: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-200",
  purple:
    "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-200",
};

interface BadgeProps {
  children: ReactNode;
  color?: keyof typeof colors;
  className?: string;
}

export function Badge({ children, color = "gray", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        colors[color],
        className
      )}
    >
      {children}
    </span>
  );
}

export function statusBadgeColor(status: string): keyof typeof colors {
  switch (status) {
    case "approved": return "green";
    case "extracted": return "blue";
    case "processing": return "yellow";
    case "failed": return "red";
    case "rejected": return "red";
    case "pending": return "gray";
    case "completed": return "green";
    default: return "gray";
  }
}
