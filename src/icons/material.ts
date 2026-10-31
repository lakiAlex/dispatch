// Material Icon Theme (VS Code extension by PKief, MIT), from the material-icon-theme package.
import manifest from "material-icon-theme/dist/material-icons.json";
import { byBasename, createResolver, type VsCodeIconTheme } from "./vscodeTheme";

// Open-folder variants are only used in tree views.
const urls = import.meta.glob<string>(
  ["/node_modules/material-icon-theme/icons/*.svg", "!/node_modules/material-icon-theme/icons/*-open.svg"],
  { query: "?no-inline", import: "default", eager: true },
);

export const resolve = createResolver(manifest as unknown as VsCodeIconTheme, byBasename(urls));
