"use client";

import {
  BarChart3,
  Building2,
  CheckSquare,
  ChevronDown,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  Hash,
  LayoutGrid,
  Upload,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Sidebar navigation.
 *
 * Two kinds of entries live in the nav:
 *   * Leaf links — a single href that navigates directly.
 *   * Sections — a labelled, collapsible group with multiple child
 *     leaves underneath. Sections do NOT navigate themselves; the
 *     parent button just toggles the children open/closed and
 *     highlights when any child route is active.
 *
 * Reference Data is a navigation group, not a workspace. Its four
 * subareas (Invoice Template Builder, GL Codes, Properties, Vendors)
 * are each independent working surfaces — they own their own
 * uploads, previews, and local workflows. There is intentionally no
 * shared "all sources live here" page; visiting `/reference-data`
 * directly server-side-redirects to the canonical first subarea
 * (Invoice Template Builder).
 *
 * Import Builder stays as its own top-level entry — it consumes
 * reference data but isn't organizationally part of it, so nesting it
 * under Reference Data would imply a hierarchy that doesn't reflect
 * how the workspaces are used.
 */

interface NavLeaf {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface NavSectionItem {
  /** Stable id for keyed rendering. */
  id: string;
  label: string;
  icon: LucideIcon;
  /**
   * URL prefix used to compute "is any descendant active?". Also the
   * URL the user hits if they paste the section URL directly — that
   * route is a server-side redirect to the section's first child;
   * it never renders a workspace of its own.
   */
  anchorHref: string;
  children: NavLeaf[];
}

type NavItem = NavLeaf | NavSectionItem;

function isSection(item: NavItem): item is NavSectionItem {
  return "children" in item;
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/upload", label: "Upload", icon: Upload },
  { href: "/review", label: "Review Queue", icon: CheckSquare },
  { href: "/exports", label: "Exports", icon: Download },
  { href: "/vendor-patterns", label: "Vendor Patterns", icon: FileText },
  // Reference Data is a navigation group — each child is its own
  // independent working area. The parent button toggles the group
  // open/closed only; it does NOT navigate. The bare `/reference-data`
  // URL server-side-redirects to Invoice Template Builder so direct
  // links don't dead-end.
  {
    id: "reference-data",
    label: "Reference Data",
    icon: Database,
    anchorHref: "/reference-data",
    children: [
      {
        href: "/reference-data/invoice-template",
        label: "Invoice Template Builder",
        icon: FileSpreadsheet,
      },
      { href: "/reference-data/gl-codes", label: "GL Codes", icon: Hash },
      {
        href: "/reference-data/properties",
        label: "Properties",
        icon: Building2,
      },
      { href: "/reference-data/vendors", label: "Vendors", icon: Users },
    ],
  },
  // Import Builder consumes reference data but is its own workspace —
  // keep it adjacent so the "inputs → design" mental model is obvious
  // without nesting it inside Reference Data.
  { href: "/import-builder", label: "Import Builder", icon: LayoutGrid },
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
        {navItems.map((item) =>
          isSection(item) ? (
            <SidebarSection key={item.id} item={item} pathname={pathname} />
          ) : (
            <SidebarLink key={item.href} item={item} pathname={pathname} />
          ),
        )}
      </nav>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Leaf link — original sidebar entry shape, unchanged styling
// ---------------------------------------------------------------------------

function SidebarLink({ item, pathname }: { item: NavLeaf; pathname: string }) {
  const active = pathname.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
        active
          ? "bg-brand-700 text-white"
          : "text-brand-50/70 hover:bg-brand-700/50 hover:text-white",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {item.label}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Section — toggle button + indented children
// ---------------------------------------------------------------------------

function SidebarSection({
  item,
  pathname,
}: {
  item: NavSectionItem;
  pathname: string;
}) {
  // "Anywhere inside the section" — covers the section's overview
  // route and every child route under it.
  const sectionActive =
    pathname === item.anchorHref ||
    pathname.startsWith(item.anchorHref + "/");
  const [expanded, setExpanded] = useState(sectionActive);

  // Auto-expand when navigation enters the section (e.g. clicking a
  // related link from another page). Doesn't force-collapse on exit
  // so the user's manual toggle is preserved across navigations.
  useEffect(() => {
    if (sectionActive) setExpanded(true);
  }, [sectionActive]);

  const Icon = item.icon;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
          // Use a softer tint for "section active" so the contrast
          // with the explicitly-active child link below stays clear:
          // child = solid brand-700, parent = brand-700 at 40%.
          sectionActive
            ? "bg-brand-700/40 text-white"
            : "text-brand-50/70 hover:bg-brand-700/50 hover:text-white",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-150",
            expanded ? "rotate-180" : "rotate-0",
          )}
        />
      </button>

      {expanded && (
        <div className="mt-1 ml-3 pl-3 border-l border-brand-700/60 space-y-0.5">
          {item.children.map((child) => {
            const childActive =
              pathname === child.href ||
              pathname.startsWith(child.href + "/");
            const ChildIcon = child.icon;
            return (
              <Link
                key={child.href}
                href={child.href}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] transition-colors",
                  childActive
                    ? "bg-brand-700 text-white font-medium"
                    : "text-brand-50/60 hover:bg-brand-700/50 hover:text-white",
                )}
              >
                <ChildIcon className="h-3.5 w-3.5 shrink-0" />
                {child.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
