import { createContext, useContext } from "react";
import type { Entry } from "../api";
import type { Theme } from "../lib/theme";

export type IconSetId = "icons" | "material" | "bearded" | "vscode-icons" | "minimal";

export const ICON_SETS: { id: IconSetId; label: string }[] = [
  { id: "icons", label: "Default icons" },
  { id: "material", label: "Material" },
  { id: "bearded", label: "Bearded" },
  { id: "vscode-icons", label: "VS Icons" },
  { id: "minimal", label: "Minimal" },
];

export type IconEntry = Pick<Entry, "name" | "isDir" | "isLink">;

/** Returns the image URL for a file or folder. */
export type IconResolver = (entry: IconEntry, mode: Theme) => string;

// Image sets load on first use, so their icons and mappings stay out of the start-up bundle.
const loaders: Partial<Record<IconSetId, () => Promise<{ resolve: IconResolver }>>> = {
  material: () => import("./material"),
  bearded: () => import("./bearded"),
  "vscode-icons": () => import("./vscodeIcons"),
  icons: () => import("./vscicons"),
};

const loaded = new Map<IconSetId, Promise<IconResolver | null>>();

/** The resolver for an image-based set, or null for Minimal, which is drawn with Lucide. */
export function loadIconSet(id: IconSetId): Promise<IconResolver | null> {
  const loader = loaders[id];
  if (!loader) return Promise.resolve(null);
  if (!loaded.has(id)) loaded.set(id, loader().then((module) => module.resolve));
  return loaded.get(id)!;
}

export const IconSetContext = createContext<{ id: IconSetId; resolve: IconResolver | null }>({
  id: "icons",
  resolve: null,
});

export function useIconSet() {
  return useContext(IconSetContext);
}
