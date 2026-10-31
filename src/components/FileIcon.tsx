import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderSymlink,
} from "lucide-react";
import { useIconSet, type IconEntry } from "../icons/sets";
import { useTheme } from "../lib/theme";

// "Minimal" is drawn with Lucide in gray: one outline icon per file type.
const GROUPS: [RegExp, typeof File][] = [
  [/\.(png|jpe?g|gif|webp|svg|avif|heic|ico|bmp|tiff?)$/i, FileImage],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/i, FileArchive],
  [/\.(mp4|mov|webm|mkv|avi|m4v)$/i, FileVideo],
  [/\.(mp3|wav|flac|aac|ogg|m4a)$/i, FileAudio],
  [/\.(json|ya?ml|toml|xml|lock)$/i, FileJson],
  [/\.(csv|xlsx?|ods|numbers)$/i, FileSpreadsheet],
  [/\.(pem|key|crt|ppk|pub|htpasswd)$|^\.env/i, FileLock],
  [
    /\.(php|js|mjs|cjs|ts|tsx|jsx|css|scss|sass|less|html?|twig|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|sh|zsh|bash|sql|lua|pl)$|^\.htaccess$/i,
    FileCode,
  ],
  [/\.(txt|md|log|rtf|pdf|docx?|pages|ini|conf|cfg)$/i, FileText],
];

function MinimalIcon({ entry, size }: { entry: IconEntry; size: number }) {
  if (entry.isDir) {
    const Icon = entry.isLink ? FolderSymlink : Folder;
    return <Icon size={size} className="file-icon mono-folder" strokeWidth={1.75} />;
  }
  const Icon = GROUPS.find(([pattern]) => pattern.test(entry.name))?.[1] ?? File;
  return <Icon size={size} className="file-icon mono" strokeWidth={1.75} />;
}

export function FileIcon({ entry, size = 16 }: { entry: IconEntry; size?: number }) {
  const mode = useTheme();
  const { id, resolve } = useIconSet();
  if (id === "minimal") return <MinimalIcon entry={entry} size={size} />;
  const src = resolve?.(entry, mode);
  // Empty space of the same size while an icon set is still loading.
  if (!src) return <span className="file-icon" style={{ width: size, height: size }} />;
  return <img src={src} width={size} height={size} className="file-icon" alt="" draggable={false} />;
}
