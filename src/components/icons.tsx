// The app's icons: Hugeicons stroke-rounded (MIT, https://hugeicons.com), the set
// Lookout uses, under the names the components use. The title bar's BrandMark is the
// app icon's glyph, and the "Minimal" file icons stay Lucide.
import type { SVGProps } from "react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  CatIcon,
  ChartColumnIcon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  CopyPlusIcon,
  Delete02Icon,
  Download04Icon,
  FileImportIcon,
  FolderAddIcon,
  FolderOpenIcon,
  Home01Icon,
  Key01Icon,
  LaptopIcon,
  LinkSquare02Icon,
  Loading03Icon,
  LockIcon,
  Moon02Icon,
  PencilEdit02Icon,
  Plug01Icon,
  PlusSignIcon,
  RainbowIcon,
  RefreshIcon,
  RotateClockwiseIcon,
  Search01Icon,
  ServerStack02Icon,
  ShieldAlertIcon,
  StopIcon,
  Sun03Icon,
  Tick02Icon,
  Unlink04Icon,
  Upload04Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

// Hugeicons ServerIcon, drawn like the app icon (src-tauri/icons/make-icon.py): a thick raised band with a
// side face and a fold along the diagonal. Colors come from the --brand-* variables in styles.css.
const BRAND_PATHS = [
  "M1.99219 7.99988C1.99219 6.11426 1.99219 5.17145 2.57797 4.58566C3.16376 3.99988 4.10657 3.99988 5.99219 3.99988H17.9922C19.8778 3.99988 20.8206 3.99988 21.4064 4.58566C21.9922 5.17145 21.9922 6.11426 21.9922 7.99988C21.9922 9.8855 21.9922 10.8283 21.4064 11.4141C20.8206 11.9999 19.8778 11.9999 17.9922 11.9999H5.99219C4.10657 11.9999 3.16376 11.9999 2.57797 11.4141C1.99219 10.8283 1.99219 9.8855 1.99219 7.99988Z",
  "M1.99219 16C1.99219 14.1143 1.99219 13.1714 2.57798 12.5856C3.16378 11.9998 4.10659 11.9999 5.99223 11.9999L17.9922 12C19.8778 12 20.8206 12 21.4064 12.5858C21.9922 13.1716 21.9922 14.1144 21.9922 16C21.9922 17.8857 21.9922 18.8285 21.4064 19.4143C20.8206 20.0001 19.8778 20.0001 17.9922 20.0001H5.99219C4.10657 20.0001 3.16376 20.0001 2.57797 19.4143C1.99219 18.8285 1.99219 17.8857 1.99219 16Z",
  "M6.11719 7.99988H5.99219M6.24219 7.99988C6.24219 8.13795 6.13026 8.24988 5.99219 8.24988C5.85412 8.24988 5.74219 8.13795 5.74219 7.99988C5.74219 7.86181 5.85412 7.74988 5.99219 7.74988C6.13026 7.74988 6.24219 7.86181 6.24219 7.99988Z",
  "M6.11719 15.9999H5.99219M6.24219 15.9999C6.24219 16.1379 6.13026 16.2499 5.99219 16.2499C5.85412 16.2499 5.74219 16.1379 5.74219 15.9999C5.74219 15.8618 5.85412 15.7499 5.99219 15.7499C6.13026 15.7499 6.24219 15.8618 6.24219 15.9999Z",
  "M10.1172 7.99988H9.99219M10.2422 7.99988C10.2422 8.13795 10.1303 8.24988 9.99219 8.24988C9.85412 8.24988 9.74219 8.13795 9.74219 7.99988C9.74219 7.86181 9.85412 7.74988 9.99219 7.74988C10.1303 7.74988 10.2422 7.86181 10.2422 7.99988Z",
  "M10.1172 15.9999H9.99219M10.2422 15.9999C10.2422 16.1379 10.1303 16.2499 9.99219 16.2499C9.85412 16.2499 9.74219 16.1379 9.74219 15.9999C9.74219 15.8618 9.85412 15.7499 9.99219 15.7499C10.1303 15.7499 10.2422 15.8618 10.2422 15.9999Z",
];

export function BrandMark({ size = 17 }: { size?: number }) {
  const band = { stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  const glyph = (props: SVGProps<SVGGElement>) => (
    <g {...band} {...props}>
      {BRAND_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  );
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="-0.5 -0.5 25 25" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="brand-mark-top" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stopColor="var(--brand-top-1)" />
          <stop offset="1" stopColor="var(--brand-top-2)" />
        </linearGradient>
        <clipPath id="brand-mark-fold">
          <path d="M24.5 -0.5V24.5H-0.5z" />
        </clipPath>
      </defs>
      {glyph({ color: "var(--brand-side)", transform: "translate(0.35 0.7)" })}
      {glyph({ stroke: "url(#brand-mark-top)" })}
      {glyph({ color: "var(--brand-fold)", clipPath: "url(#brand-mark-fold)" })}
    </svg>
  );
}

interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

function icon(svg: IconSvgElement) {
  return function Icon({ size = 16, strokeWidth = 1.7, className }: IconProps) {
    return <HugeiconsIcon icon={svg} size={size} strokeWidth={strokeWidth} className={className} />;
  };
}

export const ArrowDown = icon(ArrowDown02Icon);
export const ArrowUp = icon(ArrowUp02Icon);
export const Cat = icon(CatIcon);
export const ChartColumn = icon(ChartColumnIcon);
export const Check = icon(Tick02Icon);
export const ChevronDown = icon(ArrowDown01Icon);
export const ChevronLeft = icon(ArrowLeft01Icon);
export const ChevronRight = icon(ArrowRight01Icon);
export const ChevronUp = icon(ArrowUp01Icon);
export const CircleCheck = icon(CheckmarkCircle02Icon);
export const Copy = icon(Copy01Icon);
export const CopyPlus = icon(CopyPlusIcon);
export const Download = icon(Download04Icon);
export const ExternalLink = icon(LinkSquare02Icon);
export const Eye = icon(ViewIcon);
export const EyeOff = icon(ViewOffIcon);
export const FileInput = icon(FileImportIcon);
export const FolderOpen = icon(FolderOpenIcon);
export const FolderPlus = icon(FolderAddIcon);
export const House = icon(Home01Icon);
export const KeyRound = icon(Key01Icon);
export const Laptop = icon(LaptopIcon);
export const LoaderCircle = icon(Loading03Icon);
export const Lock = icon(LockIcon);
export const Moon = icon(Moon02Icon);
export const Pencil = icon(PencilEdit02Icon);
export const Plug = icon(Plug01Icon);
export const Plus = icon(PlusSignIcon);
export const Rainbow = icon(RainbowIcon);
export const RefreshCw = icon(RefreshIcon);
export const RotateCw = icon(RotateClockwiseIcon);
export const Search = icon(Search01Icon);
export const Server = icon(ServerStack02Icon);
export const ShieldAlert = icon(ShieldAlertIcon);
export const Square = icon(StopIcon);
export const Sun = icon(Sun03Icon);
export const Trash2 = icon(Delete02Icon);
export const TriangleAlert = icon(Alert02Icon);
export const Unplug = icon(Unlink04Icon);
export const Upload = icon(Upload04Icon);
export const X = icon(Cancel01Icon);
