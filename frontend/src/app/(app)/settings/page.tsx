import { redirect } from "next/navigation";

/**
 * `/settings` is a section root, not a workspace of its own. The
 * canonical first child is the Profile panel — visiting the bare
 * settings URL routes there so direct deep-links from elsewhere in
 * the app (or pasted URLs) never dead-end on a blank page.
 *
 * Same redirect pattern Reference Data uses for its own group root.
 */
export default function SettingsRootPage() {
  redirect("/settings/profile");
}
