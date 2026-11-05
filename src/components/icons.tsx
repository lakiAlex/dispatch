// The app's icons: Hugeicons stroke-rounded (MIT, https://hugeicons.com), the set
// Lookout uses, under the names the components use. The title bar's brand glyph
// stays Lucide, since it matches the app icon, and so do the "Minimal" file icons.
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

export { ArrowDownUp } from "lucide-react";

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
