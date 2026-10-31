// Bearded Icons (VS Code extension by BeardedBear, GPL-3.0), see src/assets/bearded-icons/SOURCE.txt.
import manifest from "../assets/bearded-icons/icons.json";
import type { Theme } from "../lib/theme";
import { byBasename, createResolver, type VsCodeIconTheme } from "./vscodeTheme";

const urls = import.meta.glob<string>("../assets/bearded-icons/icons/*.svg", {
  query: "?no-inline",
  import: "default",
  eager: true,
});

// Bearded Icons has one gray, slightly transparent folder. Draw its shape solid and blue.
const FOLDER_PATH =
  "M14 6.05V12a1 1 0 0 1-1 1H3.05A1 1 0 0 1 2 12V4.05a1 1 0 0 1 1-1h3.3a1 1 0 0 1 .94.58l.42.84a1 1 0 0 0 .99.53H13a1 1 0 0 1 1 1.05";
const folder = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="${color}" d="${FOLDER_PATH}"/></svg>`,
  )}`;
const folders: Record<Theme, string> = { dark: folder("#7aa2f7"), light: folder("#2e7de9") };

export const resolve = createResolver(manifest as unknown as VsCodeIconTheme, byBasename(urls), {
  folder: (mode) => folders[mode],
});
