"use client";

import {
  BarChart3,
  Building2,
  CheckSquare,
  ChevronDown,
  Database,
  Download,
  FileSearch,
  FileText,
  Hash,
  LayoutGrid,
  LifeBuoy,
  Settings,
  Upload,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { RiveraLogo } from "./RiveraLogo";

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
 * Reference Data is a navigation group, not a workspace. Its three
 * subareas (GL Codes, Properties, Vendors) are each independent
 * working surfaces — they own their own uploads, previews, and local
 * workflows. There is intentionally no shared "all sources live here"
 * page; visiting `/reference-data` directly server-side-redirects to
 * the canonical first subarea (GL Codes).
 *
 * Import Builder used to live as a child of Reference Data ("Invoice
 * Template Builder") but was promoted to a top-level workspace once
 * its scope expanded from "name some headers" to "design the full
 * column-level import contract" — its inputs come FROM reference data
 * but it's no longer a kind of reference data. Sidebar order keeps
 * Import Builder adjacent to Reference Data so the "inputs → design"
 * mental model is still obvious.
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
  // URL server-side-redirects to GL Codes so direct links don't
  // dead-end. The former "Invoice Template Builder" child was promoted
  // out to a top-level Import Builder workspace below.
  {
    id: "reference-data",
    label: "Reference Data",
    icon: Database,
    anchorHref: "/reference-data",
    children: [
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
  // it's where the per-column import contract is designed (column
  // shape, required/optional, source bindings, manual values lists,
  // validation hints). Keep it adjacent to Reference Data so the
  // "inputs → design" mental model is obvious without nesting it
  // inside.
  { href: "/import-builder", label: "Import Builder", icon: LayoutGrid },
  // Invoice Builder is a sibling product surface to Import Builder. It
  // owns visual extraction patterns — saved bbox-on-page annotations
  // that pin canonical extracted invoice fields to specific rectangles
  // on training documents. Distinct from Import Builder (which owns
  // the FINAL output column/rule schema) and from Reference Data
  // (catalogs of business entities); placed after both so the
  // workspace order reads bottom-up: source data → output schema →
  // visual extraction templates.
  { href: "/invoice-builder", label: "Invoice Builder", icon: FileSearch },
];

/**
 * Account / utility entries. Pinned to the bottom of the sidebar
 * with a divider above so they don't compete with the workspace
 * verbs above. Help is a leaf into the in-app help center; Settings
 * targets the section root (`/settings`) which server-side-redirects
 * to `/settings/profile` — same pattern Reference Data uses. Routing
 * to the bare section root means the existing `startsWith` active
 * detection in SidebarLink lights up for ANY `/settings/*` sub-route,
 * not just profile.
 */
const utilityNavItems: NavLeaf[] = [
  { href: "/help", label: "Help", icon: LifeBuoy },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    // Sidebar palette stays inverted in BOTH themes — brand-900 in
    // light mode, slate-950 in dark — so the brand square + nav still
    // read as the "chrome" of the app rather than blending into the
    // page surface. Border + text muting tokens swap.
    <aside className="w-60 shrink-0 bg-brand-900 text-white dark:bg-surface-inverted flex flex-col min-h-screen">
      {/* Brand mark — Rivera logo + wordmark. Logo lives as inline SVG
          (see RiveraLogo) so there's no public/ asset to ship. The
          tagline below the wordmark stays anchored to the property-
          accounting positioning. */}
      <div className="px-5 py-5 border-b border-brand-700 flex items-center gap-3">
        <RiveraLogo className="h-9 w-9 shrink-0" title="Rivera" />
        <div className="min-w-0">
          <span className="block text-lg font-bold tracking-tight leading-none">
            Rivera
          </span>
          <p className="text-[11px] text-brand-50/60 mt-1 leading-none">
            Property Accounting
          </p>
        </div>
      </div>

      <nav className="flex-1 flex flex-col px-3 py-4">
        <div className="space-y-1">
          {navItems.map((item) =>
            isSection(item) ? (
              <SidebarSection key={item.id} item={item} pathname={pathname} />
            ) : (
              <SidebarLink key={item.href} item={item} pathname={pathname} />
            ),
          )}
        </div>
        {/* Utility tray — pinned to the bottom with a soft divider so
            the workspace verbs above don't compete for visual weight
            with always-available entries like Help / Settings.
            `mt-auto` does the pinning; if the sidebar ever gets short
            on vertical space the workspace list scrolls and this tray
            stays glued to the bottom. */}
        <div className="mt-auto pt-3 border-t border-brand-700/60 space-y-1">
          {utilityNavItems.map((item) => (
            <SidebarLink key={item.href} item={item} pathname={pathname} />
          ))}
        </div>
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
