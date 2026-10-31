// vscode-icons (MIT): file and folder matching from vscode-icons-js, icon artwork
// from the Iconify copy of the set (@iconify-json/vscode-icons).
import collection from "@iconify-json/vscode-icons/icons.json";
import { getIconForFile, getIconForFolder } from "vscode-icons-js";
import type { IconResolver } from "./sets";

interface IconifyIcon {
  body: string;
  width?: number;
  height?: number;
}

const icons = collection.icons as Record<string, IconifyIcon>;
const aliases = (collection.aliases ?? {}) as Record<string, { parent: string }>;
const urls = new Map<string, string | null>();

function dataUrl(name: string): string | null {
  if (!urls.has(name)) {
    const icon = icons[name] ?? icons[aliases[name]?.parent];
    const width = icon?.width ?? collection.width ?? 16;
    const height = icon?.height ?? collection.height ?? 16;
    urls.set(
      name,
      icon
        ? `data:image/svg+xml,${encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${icon.body}</svg>`,
          )}`
        : null,
    );
  }
  return urls.get(name)!;
}

// vscode-icons-js returns file names like "file_type_php.svg"; Iconify calls that icon "file-type-php".
const iconName = (file: string) => file.replace(/\.svg$/, "").replace(/_/g, "-");

export const resolve: IconResolver = (entry) => {
  const file = entry.isDir ? getIconForFolder(entry.name) : getIconForFile(entry.name);
  const fallback = entry.isDir ? "default-folder" : "default-file";
  return dataUrl(file ? iconName(file) : fallback) ?? dataUrl(fallback) ?? "";
};
