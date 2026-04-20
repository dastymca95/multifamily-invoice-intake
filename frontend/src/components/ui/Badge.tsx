import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

const colors = {
  gray: "bg-gray-100 text-gray-700",
  blue: "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700",
  yellow: "bg-yellow-100 text-yellow-700",
  red: "bg-red-100 text-red-700",
  purple: "bg-purple-100 text-purple-700",
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
