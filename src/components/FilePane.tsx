import { ArrowUp, ChevronLeft, ChevronRight, Eye, EyeOff, FolderPlus, LoaderCircle, RefreshCw, Search, TriangleAlert, X } from "./icons";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { Entry } from "../api";
import type { PaneModel } from "../hooks/usePane";
import type { DropTarget, Side } from "../lib/dnd";
import { baseName, formatDate, formatMode, formatOctal, formatSize, joinPath, parentPath, pluralize } from "../lib/format";
import { FileIcon } from "./FileIcon";
import { PathBar } from "./PathBar";

const ROW = 26;
const OVERSCAN = 10;

type SortKey = "name" | "size" | "modified" | "mode";

export interface FilePaneProps {
  side: Side;
  title: string;
  icon: ReactNode;
  badge?: ReactNode;
  /** Extra buttons shown before the pane's own icons, e.g. Stop while connecting. */
  headerActions?: ReactNode;
  model: PaneModel;
  home: string;
  showPermissions: boolean;
  showHidden: boolean;
  onToggleHidden: () => void;
  /** Enter or double-click on files: transfer them to the other pane. */
  onOpenFiles: (entries: Entry[]) => void;
  onContextMenu: (e: ReactMouseEvent, selected: Entry[]) => void;
  onDelete: (selected: Entry[]) => void;
  onRename: (entry: Entry) => void;
  onNewFolder: () => void;
  onStartDrag: (e: ReactMouseEvent, entries: Entry[]) => void;
  dropTarget: DropTarget | null;
  /** Replaces the file list, e.g. when no server is connected. */
  placeholder?: ReactNode;
  /** Shown on top of the file list, e.g. while connecting. */
  overlay?: ReactNode;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortEntries(entries: Entry[], key: SortKey, dir: 1 | -1): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let c = 0;
    if (key === "size") c = a.size - b.size;
    else if (key === "modified") c = (a.modified ?? 0) - (b.modified ?? 0);
    else if (key === "mode") c = (a.mode ?? 0) - (b.mode ?? 0);
    if (c === 0) c = collator.compare(a.name, b.name);
    return c * dir;
  });
}

export function FilePane(props: FilePaneProps) {
  const { model, side, showHidden, showPermissions, dropTarget } = props;
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const anchor = useRef(-1);
  const deferredSelect = useRef<string | null>(null);
  const focusAfterLoad = useRef<string | null>(null);
  const lastPath = useRef("");
  const typeahead = useRef({ text: "", time: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const hiddenCount = useMemo(() => model.entries.filter((e) => e.name.startsWith(".")).length, [model.entries]);

  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const visible = model.entries.filter(
      (e) => (showHidden || !e.name.startsWith(".")) && (!query || e.name.toLowerCase().includes(query)),
    );
    return sortEntries(visible, sort.key, sort.dir);
  }, [model.entries, showHidden, filter, sort]);

  const selectedEntries = () => rows.filter((r) => selected.has(r.name));

  // New folder: reset selection. Same folder (refresh): keep what still exists.
  useEffect(() => {
    if (model.path !== lastPath.current) {
      const previous = lastPath.current;
      lastPath.current = model.path;
      setSelected(new Set());
      setCursor(-1);
      anchor.current = -1;
      setFilter("");
      if (listRef.current) listRef.current.scrollTop = 0;
      // Going up a level selects the folder we came from, like Finder.
      if (previous && parentPath(previous) === model.path) focusAfterLoad.current = baseName(previous);
    } else {
      const names = new Set(model.entries.map((e) => e.name));
      setSelected((prev) => {
        const next = new Set([...prev].filter((n) => names.has(n)));
        return next.size === prev.size ? prev : next;
      });
    }
  }, [model.version]);

  useEffect(() => {
    const name = focusAfterLoad.current;
    if (!name) return;
    focusAfterLoad.current = null;
    const index = rows.findIndex((r) => r.name === name);
    if (index >= 0) moveCursor(index, false);
  }, [rows]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, [props.placeholder]);

  function scrollToIndex(index: number) {
    const el = listRef.current;
    if (!el) return;
    const header = ROW;
    if (index * ROW < el.scrollTop) el.scrollTop = index * ROW;
    else if (header + (index + 1) * ROW > el.scrollTop + el.clientHeight) {
      el.scrollTop = header + (index + 1) * ROW - el.clientHeight;
    }
  }

  function moveCursor(index: number, extend: boolean) {
    if (index < 0 || index >= rows.length) return;
    setCursor(index);
    if (extend && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      setSelected(new Set(rows.slice(a, b + 1).map((r) => r.name)));
    } else {
      setSelected(new Set([rows[index].name]));
      anchor.current = index;
    }
    scrollToIndex(index);
  }

  async function open(entry: Entry) {
    if (entry.isDir || entry.isLink) {
      const ok = await model.navigate(joinPath(model.path, entry.name));
      // A link we could not open as a folder is probably a link to a file.
      if (!ok && entry.isLink && !entry.isDir) {
        model.clearError();
        props.onOpenFiles([entry]);
      }
      return;
    }
    const files = selected.has(entry.name) ? selectedEntries().filter((e) => !e.isDir) : [entry];
    props.onOpenFiles(files);
  }

  function goUp() {
    if (model.path && model.path !== "/") void model.navigate(parentPath(model.path));
  }

  function onRowMouseDown(e: ReactMouseEvent, index: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    listRef.current?.focus({ preventScroll: true });
    const entry = rows[index];
    let next: Set<string>;
    if (e.metaKey) {
      next = new Set(selected);
      if (next.has(entry.name)) next.delete(entry.name);
      else next.add(entry.name);
      anchor.current = index;
    } else if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      next = new Set(rows.slice(a, b + 1).map((r) => r.name));
    } else if (selected.has(entry.name)) {
      // Keep a multi-selection so it can be dragged; narrow it on click instead.
      next = selected;
      deferredSelect.current = entry.name;
      anchor.current = index;
    } else {
      next = new Set([entry.name]);
      anchor.current = index;
    }
    setSelected(next);
    setCursor(index);
    if (!e.metaKey && !e.shiftKey) props.onStartDrag(e, rows.filter((r) => next.has(r.name)));
  }

  function onRowClick(e: ReactMouseEvent, index: number) {
    if (deferredSelect.current === rows[index].name && !e.metaKey && !e.shiftKey) {
      setSelected(new Set([rows[index].name]));
    }
    deferredSelect.current = null;
  }

  function onRowContextMenu(e: ReactMouseEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    const entry = rows[index];
    let current = selected;
    if (!selected.has(entry.name)) {
      current = new Set([entry.name]);
      setSelected(current);
      setCursor(index);
      anchor.current = index;
    }
    props.onContextMenu(e, rows.filter((r) => current.has(r.name)));
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    const meta = e.metaKey;
    const { key } = e;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (meta && key === "f") {
      handled();
      filterRef.current?.focus();
      return;
    }
    if (meta && key === "r") {
      handled();
      void model.refresh();
      return;
    }
    if (meta && e.shiftKey && e.code === "KeyN") {
      handled();
      props.onNewFolder();
      return;
    }
    if (meta && e.shiftKey && e.code === "Period") {
      handled();
      props.onToggleHidden();
      return;
    }
    if (meta && key === "a") {
      handled();
      setSelected(new Set(rows.map((r) => r.name)));
      return;
    }
    if (meta && key === "[") {
      handled();
      model.back();
      return;
    }
    if (meta && key === "]") {
      handled();
      model.forward();
      return;
    }
    if ((meta && key === "Backspace") || key === "Delete") {
      handled();
      const items = selectedEntries();
      if (items.length) props.onDelete(items);
      return;
    }
    if ((meta && key === "ArrowUp") || key === "Backspace") {
      handled();
      goUp();
      return;
    }
    if (key === "F2") {
      handled();
      const items = selectedEntries();
      if (items.length === 1) props.onRename(items[0]);
      return;
    }
    if (key === "Enter" || (meta && key === "ArrowDown")) {
      handled();
      if (cursor >= 0 && rows[cursor]) void open(rows[cursor]);
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      handled();
      const delta = key === "ArrowDown" ? 1 : -1;
      const index = cursor < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, cursor + delta));
      moveCursor(index, e.shiftKey);
      return;
    }
    if (key === "Home") {
      handled();
      moveCursor(0, e.shiftKey);
      return;
    }
    if (key === "End") {
      handled();
      moveCursor(rows.length - 1, e.shiftKey);
      return;
    }
    if (key === "Escape") {
      if (filter) setFilter("");
      else setSelected(new Set());
      return;
    }
    if (key.length === 1 && !meta && !e.ctrlKey && !e.altKey) {
      handled();
      const now = Date.now();
      const t = typeahead.current;
      t.text = now - t.time > 800 ? key.toLowerCase() : t.text + key.toLowerCase();
      t.time = now;
      const index = rows.findIndex((r) => r.name.toLowerCase().startsWith(t.text));
      if (index >= 0) moveCursor(index, false);
    }
  }

  const start = Math.max(0, Math.floor(viewport.top / ROW) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW) + OVERSCAN);
  const selectedSize = selectedEntries().reduce((sum, e) => sum + (e.isDir ? 0 : e.size), 0);
  const paneDrop = dropTarget?.side === side && dropTarget.folder === null;
  const sortHeader = (key: SortKey, label: string, className: string) => (
    <button
      type="button"
      className={`col ${className}${sort.key === key ? " sorted" : ""}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
    >
      {label}
      {sort.key === key && <span className="sort-arrow">{sort.dir === 1 ? "▲" : "▼"}</span>}
    </button>
  );

  return (
    <section
      className={`pane${paneDrop ? " drop-active" : ""}${showPermissions ? " with-perms" : ""}`}
      data-drop-side={side}
    >
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-title-icon">{props.icon}</span>
          <span className="pane-title-text">{props.title}</span>
          {props.badge}
        </div>
        <div className="pane-actions">
          {props.headerActions}
          <button
            type="button"
            className="icon-button"
            title={props.showHidden ? "Hide hidden files (⇧⌘.)" : "Show hidden files (⇧⌘.)"}
            onClick={props.onToggleHidden}
            disabled={!!props.placeholder}
          >
            {props.showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
          <button type="button" className="icon-button" title="New folder (⇧⌘N)" onClick={props.onNewFolder} disabled={!!props.placeholder}>
            <FolderPlus size={15} />
          </button>
          <button type="button" className="icon-button" title="Refresh (⌘R)" onClick={() => void model.refresh()} disabled={!!props.placeholder}>
            <RefreshCw size={14} className={model.loading ? "spin" : undefined} />
          </button>
        </div>
      </header>

      <div className="pane-toolbar">
        <div className="nav-buttons">
          <button type="button" className="icon-button" title="Back (⌘[)" disabled={!model.canBack} onClick={model.back}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="icon-button" title="Forward (⌘])" disabled={!model.canForward} onClick={model.forward}>
            <ChevronRight size={16} />
          </button>
          <button type="button" className="icon-button" title="Up one level (⌘↑)" disabled={!model.path || model.path === "/"} onClick={goUp}>
            <ArrowUp size={15} />
          </button>
        </div>
        <PathBar path={model.path} home={props.home} onNavigate={(p) => void model.navigate(p)} />
        <label className="filter">
          <Search size={13} />
          <input
            ref={filterRef}
            value={filter}
            placeholder="Filter"
            spellCheck={false}
            disabled={!!props.placeholder}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                listRef.current?.focus();
              } else if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                listRef.current?.focus();
                moveCursor(0, false);
              }
            }}
          />
          {filter && (
            <button type="button" className="filter-clear" onClick={() => setFilter("")}>
              <X size={12} />
            </button>
          )}
        </label>
      </div>

      {props.placeholder ? (
        <div className="pane-placeholder">{props.placeholder}</div>
      ) : (
        <div
          ref={listRef}
          className="file-list"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest(".row, .list-header")) {
              setSelected(new Set());
              setCursor(-1);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setSelected(new Set());
            props.onContextMenu(e, []);
          }}
        >
          <div className="list-header">
            {sortHeader("name", "Name", "c-name")}
            {sortHeader("size", "Size", "c-size")}
            {sortHeader("modified", "Modified", "c-date")}
            {showPermissions && sortHeader("mode", "Permissions", "c-perm")}
          </div>
          {model.error && (
            <div className="list-error">
              <TriangleAlert size={14} />
              <span>{model.error}</span>
              <button type="button" className="icon-button" onClick={model.clearError}>
                <X size={13} />
              </button>
            </div>
          )}
          <div className="rows" style={{ height: rows.length * ROW }}>
            {rows.slice(start, end).map((entry, offset) => {
              const index = start + offset;
              const isSelected = selected.has(entry.name);
              const isDrop = dropTarget?.side === side && dropTarget.folder === entry.name;
              return (
                <div
                  key={entry.name}
                  className={`row${isSelected ? " selected" : ""}${index === cursor ? " cursor" : ""}${isDrop ? " drop" : ""}${
                    entry.name.startsWith(".") ? " hidden-file" : ""
                  }`}
                  style={{ top: index * ROW }}
                  data-row-name={entry.name}
                  data-row-dir={entry.isDir ? "1" : undefined}
                  onMouseDown={(e) => onRowMouseDown(e, index)}
                  onClick={(e) => onRowClick(e, index)}
                  onDoubleClick={() => void open(entry)}
                  onContextMenu={(e) => onRowContextMenu(e, index)}
                >
                  <div className="cell c-name">
                    <FileIcon entry={entry} />
                    <span className="name-text">{entry.name}</span>
                    {entry.isLink && <span className="link-mark" title="Symbolic link">↗</span>}
                  </div>
                  <div className="cell c-size">{entry.isDir ? "" : formatSize(entry.size)}</div>
                  <div className="cell c-date">{formatDate(entry.modified)}</div>
                  {showPermissions && (
                    <div className="cell c-perm" title={formatOctal(entry.mode)}>
                      {formatMode(entry.mode)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!model.loading && !model.error && rows.length === 0 && (
            <div className="list-empty">{filter ? "No matches" : "This folder is empty"}</div>
          )}
          {props.overlay}
        </div>
      )}

      <footer className="pane-status">
        {model.loading ? (
          <span className="status-loading">
            <LoaderCircle size={12} className="spin" /> Loading
          </span>
        ) : (
          <span>
            {pluralize(rows.length, "item")}
            {!showHidden && hiddenCount > 0 && <span className="muted"> · {hiddenCount} hidden</span>}
          </span>
        )}
        {selected.size > 0 && (
          <span>
            {selected.size} selected{selectedSize > 0 && ` · ${formatSize(selectedSize)}`}
          </span>
        )}
      </footer>
    </section>
  );
}
