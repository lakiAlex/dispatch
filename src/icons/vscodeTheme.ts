// Resolves icons from a VS Code icon theme (the JSON an icon theme extension ships),
// matched the way VS Code does: exact file name, then the longest extension, then
// the file's language. Folders by exact name.
import type { Theme } from "../lib/theme";
import type { IconEntry, IconResolver } from "./sets";

type IconMap = Record<string, string>;

interface IconMaps {
  file?: string;
  folder?: string;
  fileNames?: IconMap;
  fileExtensions?: IconMap;
  folderNames?: IconMap;
  languageIds?: IconMap;
}

export interface VsCodeIconTheme extends IconMaps {
  iconDefinitions: Record<string, { iconPath: string }>;
  light?: IconMaps;
}

// VS Code picks many icons through a file's language. These are the language ids
// of VS Code's built-in languages for common extensions.
const LANGUAGE_BY_EXTENSION: IconMap = {
  php: "php", phtml: "php", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", json: "json", jsonc: "jsonc",
  md: "markdown", markdown: "markdown", html: "html", htm: "html", css: "css", scss: "scss", sass: "sass",
  less: "less", yml: "yaml", yaml: "yaml", xml: "xml", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", sql: "sql", ini: "ini", toml: "toml",
  twig: "twig", vue: "vue", svelte: "svelte", lua: "lua", pl: "perl", bat: "bat", ps1: "powershell",
  txt: "plaintext", graphql: "graphql", dart: "dart", r: "r", scala: "scala", ex: "elixir", hs: "haskell",
};

const lowerKeys = (map: IconMap = {}): IconMap =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));

/** Maps "anything/icons/php.svg" keys from import.meta.glob to "php.svg". */
export function byBasename(urls: Record<string, string>): IconMap {
  return Object.fromEntries(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]));
}

export function createResolver(
  theme: VsCodeIconTheme,
  svgUrls: IconMap,
  options: { folder?: (mode: Theme) => string } = {},
): IconResolver {
  const urlById: IconMap = {};
  for (const [id, definition] of Object.entries(theme.iconDefinitions)) {
    const url = svgUrls[definition.iconPath.slice(definition.iconPath.lastIndexOf("/") + 1)];
    if (url) urlById[id] = url;
  }

  // Light-theme entries override the dark ones; missing ones fall back to dark.
  const build = (light?: IconMaps) => ({
    file: (light?.file && urlById[light.file] ? light.file : theme.file) ?? "",
    folder: (light?.folder && urlById[light.folder] ? light.folder : theme.folder) ?? "",
    names: { ...lowerKeys(theme.fileNames), ...lowerKeys(light?.fileNames) },
    extensions: { ...lowerKeys(theme.fileExtensions), ...lowerKeys(light?.fileExtensions) },
    folders: { ...lowerKeys(theme.folderNames), ...lowerKeys(light?.folderNames) },
    languages: { ...theme.languageIds, ...light?.languageIds },
  });
  const sets = { dark: build(), light: build(theme.light) };

  const iconId = (entry: IconEntry, mode: Theme): string => {
    const set = sets[mode];
    const name = entry.name.toLowerCase();
    if (entry.isDir) return set.folders[name] ?? (entry.isLink && urlById["folder-link"] ? "folder-link" : set.folder);
    if (set.names[name]) return set.names[name];
    // "app.blade.php" tries "blade.php", then "php". ".env" tries "env".
    const parts = name.split(".");
    for (let i = 1; i < parts.length; i++) {
      const icon = set.extensions[parts.slice(i).join(".")];
      if (icon) return icon;
    }
    const language = parts.length > 1 ? LANGUAGE_BY_EXTENSION[parts[parts.length - 1]] : undefined;
    return (language && set.languages[language]) || set.file;
  };

  return (entry, mode) => {
    if (entry.isDir && options.folder && !sets[mode].folders[entry.name.toLowerCase()]) return options.folder(mode);
    return urlById[iconId(entry, mode)] ?? urlById[entry.isDir ? sets[mode].folder : sets[mode].file] ?? "";
  };
}
