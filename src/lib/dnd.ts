import type { Entry } from "../api";

export type Side = "local" | "remote";

/** Files being dragged with the mouse inside the window. */
export interface DragPayload {
  side: Side;
  dir: string;
  entries: Entry[];
}

/** Where a drag would land: a pane, and optionally a folder row in it. */
export interface DropTarget {
  side: Side;
  folder: string | null;
}

/** Finds the drop target under a point in the window. */
export function dropTargetAt(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest<HTMLElement>("[data-drop-side]");
  if (!pane) return null;
  const row = el?.closest<HTMLElement>("[data-row-dir]");
  return { side: pane.dataset.dropSide as Side, folder: row?.dataset.rowName ?? null };
}
