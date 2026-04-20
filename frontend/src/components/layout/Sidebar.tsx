"use client";

import { cn } from "@/lib/utils";
import {
  BarChart3,
  CheckSquare,
  Download,
  FileText,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/upload", label: "Upload", icon: Upload },
  { href: "/review", label: "Review Queue", icon: CheckSquare },
  { href: "/exports", label: "Exports", icon: Download },
  { href: "/vendor-patterns", label: "Vendor Patterns", icon: FileText },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 shrink-0 bg-brand-900 text-white flex flex-col min-h-screen">
      <div className="px-6 py-5 border-b border-brand-700">
        <span className="text-lg font-bold tracking-tight">BillsIQ</span>
        <p className="text-xs text-brand-50/60 mt-0.5">Property Accounting</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                active
                  ? "bg-brand-700 text-white"
                  : "text-brand-50/70 hover:bg-brand-700/50 hover:text-white"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
