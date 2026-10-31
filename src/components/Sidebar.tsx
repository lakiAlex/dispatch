import { ArrowDownUp, ChevronRight, FileInput, LoaderCircle, Plus, Search, Server, X } from "lucide-react";
import { forwardRef, useMemo, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { protocolLabel, type Site } from "../api";

const COLLAPSED_KEY = "dispatch.collapsedFolders";

export const SITE_COLORS: Record<string, string> = {
  red: "var(--c-red)",
  orange: "var(--c-orange)",
  yellow: "var(--c-yellow)",
  green: "var(--c-green)",
  cyan: "var(--c-cyan)",
  blue: "var(--c-blue)",
  purple: "var(--c-purple)",
};

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

interface SidebarProps {
  sites: Site[];
  selectedId: string | null;
  connectedSiteId: string | null;
  connectingSiteId: string | null;
  onSelect: (id: string) => void;
  onConnect: (site: Site) => void;
  onNew: () => void;
  onImport: () => void;
  onContextMenu: (e: ReactMouseEvent, site: Site) => void;
  /** Right-click on the empty part of the site list. */
  onListContextMenu: (e: ReactMouseEvent) => void;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const Sidebar = forwardRef<HTMLInputElement, SidebarProps>(function Sidebar(props, searchRef) {
  const { sites, selectedId } = props;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? sites.filter((s) => `${s.name} ${s.host} ${s.user} ${s.folder}`.toLowerCase().includes(q))
      : sites;
    return [...list].sort((a, b) => collator.compare(a.name, b.name));
  }, [sites, query]);

  const groups = useMemo(() => {
    const map = new Map<string, Site[]>();
    for (const site of filtered) {
      const key = query ? "" : site.folder;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(site);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : collator.compare(a, b)));
  }, [filtered, query]);

  const toggleFolder = (folder: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const visibleOrder = groups.flatMap(([folder, list]) => (folder && collapsed.has(folder) ? [] : list));

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const index = visibleOrder.findIndex((s) => s.id === selectedId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = visibleOrder[Math.min(visibleOrder.length - 1, Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) props.onSelect(next.id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const site = visibleOrder[index] ?? visibleOrder[0];
      if (site) props.onConnect(site);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar" data-tauri-drag-region />
      <div className="brand" data-tauri-drag-region>
        <ArrowDownUp size={15} strokeWidth={2} />
        <span className="brand-name">Dispatch</span>
        <span className="brand-sub">- SFTP Client</span>
      </div>

      <div className="sidebar-search">
        <Search size={13} />
        <input
          ref={searchRef}
          value={query}
          placeholder={sites.length ? `Search ${sites.length} sites` : "Search sites"}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
        />
        {query ? (
          <button type="button" className="filter-clear" onClick={() => setQuery("")}>
            <X size={12} />
          </button>
        ) : (
          <kbd className="kbd">⌘K</kbd>
        )}
      </div>

      <div
        className="site-list"
        onContextMenu={(e) => {
          e.preventDefault();
          props.onListContextMenu(e);
        }}
      >
        {sites.length === 0 && (
          <div className="sidebar-empty">
            <Server size={28} strokeWidth={1.5} />
            <p>No saved sites yet.</p>
            <button type="button" className="button primary" onClick={props.onImport}>
              <FileInput size={14} /> Import from FileZilla
            </button>
            <button type="button" className="button" onClick={props.onNew}>
              <Plus size={14} /> New site
            </button>
          </div>
        )}
        {sites.length > 0 && filtered.length === 0 && <div className="sidebar-note">No sites match "{query}"</div>}
        {groups.map(([folder, list]) => {
          const isCollapsed = !!folder && collapsed.has(folder);
          return (
            <div key={folder || "_root"} className="site-group">
              {folder && (
                <button type="button" className="folder-row" onClick={() => toggleFolder(folder)}>
                  <ChevronRight size={12} className={`folder-chevron${isCollapsed ? "" : " open"}`} />
                  <span>{folder}</span>
                  <span className="folder-count">{list.length}</span>
                </button>
              )}
              {!isCollapsed &&
                list.map((site) => {
                  const connected = site.id === props.connectedSiteId;
                  const connecting = site.id === props.connectingSiteId;
                  return (
                    <div
                      key={site.id}
                      className={`site-row${site.id === selectedId ? " selected" : ""}${connected ? " connected" : ""}${
                        folder ? " nested" : ""
                      }`}
                      title={`${protocolLabel(site.protocol)} · ${site.user ? `${site.user}@` : ""}${site.host}:${site.port}`}
                      onClick={() => props.onSelect(site.id)}
                      onDoubleClick={() => props.onConnect(site)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        props.onSelect(site.id);
                        props.onContextMenu(e, site);
                      }}
                    >
                      <span
                        className="site-dot"
                        style={{ background: SITE_COLORS[site.color] ?? "var(--site-dot)" }}
                      />
                      <div className="site-text">
                        <div className="site-name">{site.name || site.host}</div>
                        <div className="site-host">
                          {site.user ? `${site.user}@` : ""}
                          {site.host}
                        </div>
                      </div>
                      {connecting ? (
                        <LoaderCircle size={13} className="spin site-state" />
                      ) : connected ? (
                        <span className="live-dot site-state" title="Connected" />
                      ) : (
                        <span className="proto-tag">{protocolLabel(site.protocol)}</span>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="footer-button" onClick={props.onNew} title="New site">
          <Plus size={14} /> New site
        </button>
      </div>
    </aside>
  );
});
