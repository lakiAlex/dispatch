const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatSize(Math.round(bytesPerSecond))}/s`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fullFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function formatDate(seconds: number | null): string {
  if (seconds == null) return "";
  const date = new Date(seconds * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `Today ${timeFormat.format(date)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${timeFormat.format(date)}`;
  if (date.getFullYear() === now.getFullYear()) return `${dayFormat.format(date)} ${timeFormat.format(date)}`;
  return fullFormat.format(date);
}

export function formatMode(mode: number | null): string {
  if (mode == null) return "";
  let out = "";
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 7;
    out += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-");
  }
  return out;
}

export function formatOctal(mode: number | null): string {
  return mode == null ? "" : (mode & 0o777).toString(8).padStart(3, "0");
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

/** True when `path` is `dir` itself or inside it. */
export function isInside(path: string, dir: string): boolean {
  const base = dir.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`) || base === "";
}

export function pluralize(count: number, word: string, plural = `${word}s`): string {
  return `${count} ${count === 1 ? word : plural}`;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}
