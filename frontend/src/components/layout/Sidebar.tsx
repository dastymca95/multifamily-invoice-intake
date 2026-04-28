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
    // Sidebar uses the requested light gray shell while active
    // destinations keep Rivera Blue for orientation.
    <aside className="w-60 shrink-0 bg-[#dfe4e1] text-[#1f2933] flex flex-col min-h-screen border-r border-[#c7d0ca]">
      {/* The PNG wordmark is white for dark chrome; crop the mark and
          render the text live so the brand stays readable on gray. */}
      <div className="px-5 py-5 border-b border-[#c7d0ca] flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <div className="h-11 w-11 overflow-hidden rounded-xl">
            <RiveraLogo
              variant="fullLockup"
              className="h-11 w-[145px] max-w-none object-contain object-left"
            />
          </div>
          <span className="text-[30px] font-extrabold leading-none tracking-normal text-[#111827]">
            Rivera
          </span>
        </div>
        <p className="text-[11px] text-[#3f4d57] leading-none">
          Property Accounting
        </p>
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
        <div className="mt-auto pt-3 border-t border-[#c7d0ca] space-y-1">
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
        // `relative` + the lime indicator below: gives every active
        // item an Electric Lime left bar so the brand validation
        // accent shows up across the chrome without dominating.
        "relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150",
        active
          ? // Active: Real Estate Blue body + brighter foreground.
            "bg-brand-700 text-white"
          : "text-[#334155] hover:bg-white/55 hover:text-[#111827]",
      )}
      aria-current={active ? "page" : undefined}
    >
      {/* Electric Lime left bar — only on active. Left-aligned with
          the rounded background so it reads as part of the pill,
          not a stray decoration. `pointer-events-none` keeps the
          link the click target. */}
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r bg-rivera-lime"
        />
      )}
      <Icon
        className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          // Active icon brightens to pure white; idle uses softer
          // brand tone but slightly lifted from the label so it
          // reads as scannable iconography.
          active ? "text-white" : "text-[#475569]",
        )}
      />
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
          "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150",
          sectionActive
            ? "bg-white/55 text-[#111827]"
            : "text-[#334155] hover:bg-white/55 hover:text-[#111827]",
        )}
      >
        <Icon
          className={cn(
            "h-4 w-4 shrink-0",
            sectionActive ? "text-[#111827]" : "text-[#475569]",
          )}
        />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-150",
            expanded ? "rotate-180" : "rotate-0",
          )}
        />
      </button>

      {expanded && (
        <div className="mt-1 ml-3 pl-3 border-l border-[#9aa8a1] space-y-0.5">
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
                  "relative flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] transition-colors duration-150",
                  childActive
                    ? "bg-brand-700 text-white font-medium"
                    : "text-[#46545f] hover:bg-white/55 hover:text-[#111827]",
                )}
                aria-current={childActive ? "page" : undefined}
              >
                <ChildIcon
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    childActive ? "text-white" : "text-[#5b6770]",
                  )}
                />
                {child.label}
                {/* Active nested item gets a small Electric Lime dot
                    on the right edge — the brand validation accent
                    you can scan down the submenu without breaking
                    the active row's solid brand-blue background. */}
                {childActive && (
                  <span
                    aria-hidden
                    className="pointer-events-none ml-auto h-1.5 w-1.5 rounded-full bg-rivera-lime"
                  />
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
