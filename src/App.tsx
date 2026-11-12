import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileInput,
  FolderPlus,
  KeyRound,
  Laptop,
  LoaderCircle,
  Pencil,
  Plug,
  Moon,
  Plus,
  Rainbow,
  RefreshCw,
  Server,
  Square,
  Sun,
  Trash2,
  Unplug,
  Upload,
  CopyPlus,
  BrandMark,
  Cat,
} from "./components/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  api,
  emptySite,
  protocolLabel,
  toAppError,
  type ConflictPolicy,
  type Entry,
  type ImportReport,
  type Job,
  type JobProgress,
  type JobState,
  type LogLine,
  type SessionInfo,
  type Site,
} from "./api";
import { ContextMenu, type MenuEntry, type MenuState } from "./components/ContextMenu";
import { ChmodDialog, ConfirmDialog, HostKeyDialog, ImportReportDialog, InputDialog, SecretDialog } from "./components/Dialogs";
import { FilePane } from "./components/FilePane";
import { MemeButton } from "./components/Meme";
import { Sidebar, SidebarIcon, type SidebarIconName } from "./components/Sidebar";
import { UpdateButton } from "./components/Update";
import { WindowSnap } from "./components/WindowSnap";
import { SiteDialog } from "./components/SiteDialog";
import { TransferPanel } from "./components/TransferPanel";
import { usePane } from "./hooks/usePane";
import { dropTargetAt, type DragPayload, type DropTarget, type Side } from "./lib/dnd";
import { copyText, isInside, joinPath, pluralize } from "./lib/format";
import { ThemeContext, type Theme } from "./lib/theme";
import { ICON_SETS, IconSetContext, loadIconSet, type IconResolver, type IconSetId } from "./icons/sets";

type DialogState =
  | { type: "site"; site: Site }
  | { type: "secret"; kind: "password" | "passphrase"; site: Site; message?: string }
  | { type: "hostkey"; site: Site; hostPort: string; expected: string; actual: string }
  | { type: "input"; title: string; label: string; initial: string; confirmLabel: string; onConfirm: (value: string) => void }
  | { type: "confirm"; title: string; message: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void }
  | { type: "chmod"; names: string[]; paths: string[]; initial: number }
  | { type: "import"; report: ImportReport };

interface Toast {
  id: number;
  kind: "info" | "error";
  message: string;
}

interface ConnectOptions {
  password?: string;
  passphrase?: string;
  remember?: boolean;
}

const PANEL_KEY = "dispatch.panel";

type ImportSource = "filezilla" | "cyberduck";
const THEME_KEY = "dispatch.theme";
const ICON_SET_KEY = "dispatch.iconSet";
const SIDE_KEY = "dispatch.sideWidth";
const SIDE_OPEN_KEY = "dispatch.sitesOpen";
const COMPACT_KEY = "dispatch.compactBar";
const MEMES_KEY = "dispatch.memes";

function loadPanel(): { collapsed: boolean; height: number } {
  try {
    return { collapsed: false, height: 240, ...JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}") };
  } catch {
    return { collapsed: false, height: 240 };
  }
}

export default function App() {
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [connecting, setConnecting] = useState<Site | null>(null);
  const [home, setHome] = useState("");
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem("dispatch.showHidden") !== "0");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [jobs, setJobs] = useState<Map<number, Job>>(new Map());
  const [policy, setPolicy] = useState<ConflictPolicy>("ask");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [panel, setPanel] = useState(loadPanel);
  const [queueSignal, setQueueSignal] = useState(0);
  const [iconSet, setIconSet] = useState<IconSetId>(() => {
    const saved = localStorage.getItem(ICON_SET_KEY);
    return ICON_SETS.some((s) => s.id === saved) ? (saved as IconSetId) : "icons";
  });
  const [iconResolver, setIconResolver] = useState<IconResolver | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "light" ? "light" : "dark"));
  const [drag, setDrag] = useState<{ payload: DragPayload; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [themeSwitched, setThemeSwitched] = useState(false);
  const [sitesOpen, setSitesOpen] = useState(() => localStorage.getItem(SIDE_OPEN_KEY) !== "0");
  const [sideWidth, setSideWidth] = useState(() => Number(localStorage.getItem(SIDE_KEY)) || 272);
  const [compact, setCompact] = useState(() => localStorage.getItem(COMPACT_KEY) === "1");
  const [memes, setMemes] = useState(() => localStorage.getItem(MEMES_KEY) !== "0");

  useEffect(() => {
    localStorage.setItem(SIDE_OPEN_KEY, sitesOpen ? "1" : "0");
  }, [sitesOpen]);

  const localLister = useCallback((path: string) => api.localList(path), []);
  const remoteLister = useMemo(() => (session ? (path: string) => api.remoteList(session.id, path) : null), [session]);
  const local = usePane(localLister);
  const remote = usePane(remoteLister);

  // Event listeners registered once read the latest values through refs.
  const latest = useRef({ session, local, remote });
  latest.current = { session, local, remote };

  const toast = useCallback((kind: Toast["kind"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 3500);
  }, []);

  const refreshSites = useCallback(async () => setSites(await api.listSites()), []);

  // ---- Startup and backend events ----

  useEffect(() => {
    void refreshSites();
    void api.localHome().then(async (h) => {
      setHome(h);
      const saved = localStorage.getItem("dispatch.localPath");
      if (!(saved && (await latest.current.local.navigate(saved)))) await latest.current.local.navigate(h);
    });
    void api.queueSnapshot().then((snapshot) => {
      setJobs(new Map(snapshot.jobs.map((j) => [j.id, j])));
      setPolicy(snapshot.policy);
    });

    const timers: Partial<Record<Side, number>> = {};
    const scheduleRefresh = (side: Side) => {
      window.clearTimeout(timers[side]);
      timers[side] = window.setTimeout(() => void latest.current[side].refresh(), 400);
    };

    const unlisteners = [
      listen<Job[]>("queue:upsert", (e) => {
        setJobs((prev) => {
          const next = new Map(prev);
          for (const job of e.payload) next.set(job.id, job);
          return next;
        });
        const { session: s, local: l, remote: r } = latest.current;
        for (const job of e.payload) {
          if (job.state !== "done") continue;
          if (job.kind === "upload" && s?.connKey === job.connKey && r.path && isInside(job.remote, r.path)) scheduleRefresh("remote");
          if (job.kind === "download" && l.path && isInside(job.local, l.path)) scheduleRefresh("local");
        }
      }),
      listen<JobProgress[]>("queue:progress", (e) => {
        setJobs((prev) => {
          const next = new Map(prev);
          for (const p of e.payload) {
            const job = next.get(p.id);
            if (job) next.set(p.id, { ...job, transferred: p.transferred, speed: p.speed });
          }
          return next;
        });
      }),
      listen<number[]>("queue:remove", (e) => {
        setJobs((prev) => {
          const next = new Map(prev);
          for (const id of e.payload) next.delete(id);
          return next;
        });
      }),
      listen<LogLine>("log", (e) => setLogs((prev) => [...prev.slice(-999), e.payload])),
    ];

    // Files dragged in from Finder.
    const dropListener = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "leave") {
        setDropTarget(null);
        return;
      }
      const scale = window.devicePixelRatio || 1;
      const target = dropTargetAt(p.position.x / scale, p.position.y / scale);
      const { session: s, remote: r, local: l } = latest.current;
      if (p.type === "drop") {
        setDropTarget(null);
        if (target?.side === "remote" && s) {
          const dir = target.folder ? joinPath(r.path, target.folder) : r.path;
          void api
            .enqueueUpload(s.id, p.paths, dir)
            .then(() => setQueueSignal((n) => n + 1))
            .catch((err) => toast("error", toAppError(err).message));
        } else if (target?.side === "local" && p.paths.length === 1) {
          void l.navigate(p.paths[0]);
        }
      } else {
        setDropTarget(target?.side === "remote" && !s ? null : target);
      }
    });

    return () => {
      unlisteners.forEach((u) => void u.then((f) => f()));
      void dropListener.then((f) => f());
    };
  }, [refreshSites, toast]);

  useEffect(() => {
    if (local.path) localStorage.setItem("dispatch.localPath", local.path);
  }, [local.path]);

  useEffect(() => {
    localStorage.setItem("dispatch.showHidden", showHidden ? "1" : "0");
  }, [showHidden]);

  useEffect(() => {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panel));
  }, [panel]);

  useEffect(() => {
    localStorage.setItem(ICON_SET_KEY, iconSet);
    let current = true;
    setIconResolver(null);
    void loadIconSet(iconSet).then((resolve) => current && setIconResolver(() => resolve));
    return () => {
      current = false;
    };
  }, [iconSet]);

  const iconContext = useMemo(() => ({ id: iconSet, resolve: iconResolver }), [iconSet, iconResolver]);

  // The native window theme colors the window buttons and system menus.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    void getCurrentWindow().setTheme(theme).catch(() => undefined);
  }, [theme]);

  // Open the start folders when a session begins.
  useEffect(() => {
    if (!session) {
      remote.reset();
      return;
    }
    void remote.navigate(session.startDir).then((ok) => {
      if (!ok && session.startDir !== session.home) void remote.navigate(session.home);
    });
    if (session.localDir) void local.navigate(session.localDir);
  }, [session]);

  // ---- Connecting ----

  const connectTo = useCallback(
    async (site: Site, opts: ConnectOptions = {}) => {
      if (site.auth === "ask" && opts.password === undefined) {
        setDialog({ type: "secret", kind: "password", site });
        return;
      }
      const current = latest.current.session;
      if (current) {
        await api.disconnect(current.id).catch(() => undefined);
        setSession(null);
      }
      setSelectedSiteId(site.id || null);
      setConnecting(site);
      const label = site.name || site.host;
      try {
        const info = await api.connect(site, opts);
        setSession(info);
        if (opts.remember) void refreshSites();
      } catch (e) {
        const err = toAppError(e);
        const usesPassword = site.auth === "password" || site.auth === "ask";
        if (err.code === "cancelled") {
          return;
        } else if (err.code === "need_password" || (err.code === "auth" && usesPassword)) {
          setDialog({
            type: "secret",
            kind: "password",
            site,
            message: err.code === "auth" ? `${err.message}. Check the password and try again.` : undefined,
          });
        } else if (err.code === "need_passphrase") {
          setDialog({ type: "secret", kind: "passphrase", site, message: opts.passphrase ? err.message : undefined });
        } else if (err.code === "hostkey_changed" && err.data) {
          setDialog({ type: "hostkey", site, hostPort: err.data.hostPort, expected: err.data.expected, actual: err.data.actual });
        } else if (err.code === "cert") {
          setDialog({
            type: "confirm",
            title: "Certificate not trusted",
            message: (
              <>
                <p>{err.message}</p>
                <p>
                  The server's TLS certificate could not be verified. This is common on shared hosting where the certificate is issued
                  for a different host name. Connect anyway and remember this for {label}?
                </p>
              </>
            ),
            confirmLabel: "Connect anyway",
            onConfirm: async () => {
              const updated = { ...site, insecureTls: true };
              if (site.id) {
                await api.saveSite(updated);
                void refreshSites();
              }
              void connectTo(updated, opts);
            },
          });
        } else {
          toast("error", `${label}: ${err.message}`);
        }
      } finally {
        setConnecting(null);
      }
    },
    [refreshSites, toast],
  );

  const disconnect = useCallback(async () => {
    const current = latest.current.session;
    if (!current) return;
    setSession(null);
    await api.disconnect(current.id).catch(() => undefined);
  }, []);

  // ---- Sites ----

  const folders = useMemo(() => [...new Set(sites.map((s) => s.folder).filter(Boolean))].sort(), [sites]);
  const selectedSite = sites.find((s) => s.id === selectedSiteId) ?? null;

  // Imports from the other app's usual location, or asks for the files when they are not there.
  const importSites = useCallback(
    async (source: ImportSource) => {
      const run = async (paths?: string[]) => {
        const report = source === "filezilla" ? await api.importFilezilla(paths?.[0]) : await api.importCyberduck(paths);
        await refreshSites();
        setDialog({ type: "import", report });
      };
      try {
        await run();
      } catch (e) {
        const err = toAppError(e);
        if (err.code !== "not_found") {
          toast("error", err.message);
          return;
        }
        const picked =
          source === "filezilla"
            ? await openFileDialog({
                title: "Choose FileZilla's sitemanager.xml or an exported sites file",
                multiple: false,
                directory: false,
                filters: [{ name: "FileZilla sites", extensions: ["xml"] }],
              })
            : await openFileDialog({
                title: "Choose Cyberduck bookmarks (.duck files)",
                multiple: true,
                directory: false,
                filters: [{ name: "Cyberduck bookmarks", extensions: ["duck"] }],
              });
        const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
        if (paths.length) await run(paths).catch((err2) => toast("error", toAppError(err2).message));
      }
    },
    [refreshSites, toast],
  );

  const saveSite = async (site: Site, secrets: { password?: string; passphrase?: string }, connect: boolean) => {
    try {
      const saved = await api.saveSite(site, secrets.password, secrets.passphrase);
      await refreshSites();
      setDialog(null);
      setSelectedSiteId(saved.id);
      if (connect) {
        void connectTo(saved, {
          password: secrets.password || undefined,
          passphrase: secrets.passphrase || undefined,
        });
      }
    } catch (e) {
      toast("error", toAppError(e).message);
    }
  };

  const confirmDeleteSite = (site: Site) => {
    setDialog({
      type: "confirm",
      title: `Delete ${site.name || site.host}?`,
      message: "The site and its saved password are removed from Dispatch. Files on the server are not touched.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        await api.deleteSite(site.id);
        if (selectedSiteId === site.id) setSelectedSiteId(null);
        await refreshSites();
      },
    });
  };

  const siteMenu = (e: ReactMouseEvent, site: Site) => {
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Connect", icon: <Plug size={14} />, onSelect: () => void connectTo(site) },
        "separator",
        { label: "Edit", icon: <Pencil size={14} />, onSelect: () => setDialog({ type: "site", site }) },
        {
          label: "Duplicate",
          icon: <CopyPlus size={14} />,
          onSelect: () =>
            setDialog({ type: "site", site: { ...site, id: "", name: `${site.name} copy`, passwordSaved: false, passphraseSaved: false } }),
        },
        { label: "Copy host", icon: <Copy size={14} />, onSelect: () => void copyText(site.host) },
        "separator",
        { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => confirmDeleteSite(site) },
      ],
    });
  };

  // ---- File operations ----

  const upload = useCallback(
    async (entries: Entry[], fromDir: string, toDir?: string) => {
      const s = latest.current.session;
      if (!s) {
        toast("info", "Connect to a server first.");
        return;
      }
      try {
        await api.enqueueUpload(s.id, entries.map((e) => joinPath(fromDir, e.name)), toDir ?? latest.current.remote.path);
        setPanel((p) => ({ ...p, collapsed: false }));
        setQueueSignal((n) => n + 1);
      } catch (e) {
        toast("error", toAppError(e).message);
      }
    },
    [toast],
  );

  const download = useCallback(
    async (entries: Entry[], fromDir: string, toDir?: string) => {
      const s = latest.current.session;
      if (!s) return;
      try {
        await api.enqueueDownload(
          s.id,
          entries.map((e) => ({ path: joinPath(fromDir, e.name), name: e.name, isDir: e.isDir, isLink: e.isLink, size: e.size })),
          toDir ?? latest.current.local.path,
        );
        setPanel((p) => ({ ...p, collapsed: false }));
        setQueueSignal((n) => n + 1);
      } catch (e) {
        toast("error", toAppError(e).message);
      }
    },
    [toast],
  );

  const run = async (action: () => Promise<unknown>, after: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      toast("error", toAppError(e).message);
    }
    await after();
  };

  const askNewFolder = (side: Side) => {
    const pane = side === "local" ? local : remote;
    if (!pane.path) return;
    setDialog({
      type: "input",
      title: "New folder",
      label: "Name",
      initial: "New folder",
      confirmLabel: "Create",
      onConfirm: (name) => {
        const path = joinPath(pane.path, name);
        void run(() => (side === "local" ? api.localMkdir(path) : api.remoteMkdir(session!.id, path)), pane.refresh);
      },
    });
  };

  const askRename = (side: Side, entry: Entry) => {
    const pane = side === "local" ? local : remote;
    setDialog({
      type: "input",
      title: `Rename ${entry.name}`,
      label: "New name",
      initial: entry.name,
      confirmLabel: "Rename",
      onConfirm: (name) => {
        if (name === entry.name) return;
        const from = joinPath(pane.path, entry.name);
        const to = joinPath(pane.path, name);
        void run(() => (side === "local" ? api.localRename(from, to) : api.remoteRename(session!.id, from, to)), pane.refresh);
      },
    });
  };

  const askDelete = (side: Side, entries: Entry[]) => {
    if (!entries.length) return;
    const pane = side === "local" ? local : remote;
    const what = entries.length === 1 ? `"${entries[0].name}"` : pluralize(entries.length, "item");
    const hasFolders = entries.some((e) => e.isDir && !e.isLink);
    if (side === "local") {
      setDialog({
        type: "confirm",
        title: `Move ${what} to the Trash?`,
        message: "You can restore them from the Trash in Finder.",
        confirmLabel: "Move to Trash",
        onConfirm: () => void run(() => api.localTrash(entries.map((e) => joinPath(pane.path, e.name))), pane.refresh),
      });
      return;
    }
    const s = session!;
    setDialog({
      type: "confirm",
      title: `Delete ${what} from ${s.label}?`,
      message: hasFolders
        ? "Folders are deleted with everything in them. This cannot be undone."
        : "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () =>
        void run(
          () =>
            api.remoteDelete(
              s.id,
              entries.map((e) => ({ path: joinPath(pane.path, e.name), name: e.name, isDir: e.isDir, isLink: e.isLink })),
            ),
          pane.refresh,
        ),
    });
  };

  const paneMenu = (side: Side, e: ReactMouseEvent, selected: Entry[]) => {
    const pane = side === "local" ? local : remote;
    const single = selected.length === 1 ? selected[0] : null;
    const items: MenuEntry[] = [];
    if (selected.length) {
      if (side === "local") {
        items.push({
          label: session ? `Upload to ${session.label}` : "Upload",
          icon: <Upload size={14} />,
          disabled: !session,
          onSelect: () => void upload(selected, pane.path),
        });
        items.push("separator");
        if (single) {
          items.push({
            label: single.isDir ? "Open" : "Open with default app",
            icon: <ExternalLink size={14} />,
            onSelect: () =>
              single.isDir ? void pane.navigate(joinPath(pane.path, single.name)) : void openPath(joinPath(pane.path, single.name)),
          });
          items.push({
            label: "Show in Finder",
            icon: <Laptop size={14} />,
            onSelect: () => void revealItemInDir(joinPath(pane.path, single.name)),
          });
          items.push({ label: "Rename", icon: <Pencil size={14} />, shortcut: "F2", onSelect: () => askRename(side, single) });
        }
        items.push({ label: "Move to Trash", icon: <Trash2 size={14} />, shortcut: "⌘⌫", danger: true, onSelect: () => askDelete(side, selected) });
      } else {
        items.push({ label: "Download", icon: <Download size={14} />, onSelect: () => void download(selected, pane.path) });
        items.push("separator");
        if (single) items.push({ label: "Rename", icon: <Pencil size={14} />, shortcut: "F2", onSelect: () => askRename(side, single) });
        items.push({
          label: "Permissions",
          icon: <KeyRound size={14} />,
          onSelect: () =>
            setDialog({
              type: "chmod",
              names: selected.map((x) => x.name),
              paths: selected.map((x) => joinPath(pane.path, x.name)),
              initial: selected[0].mode ?? 0o644,
            }),
        });
        items.push({ label: "Delete", icon: <Trash2 size={14} />, shortcut: "⌘⌫", danger: true, onSelect: () => askDelete(side, selected) });
      }
      items.push("separator");
      items.push({
        label: selected.length === 1 ? "Copy path" : "Copy paths",
        icon: <Copy size={14} />,
        onSelect: () => void copyText(selected.map((x) => joinPath(pane.path, x.name)).join("\n")),
      });
      items.push("separator");
    }
    items.push({ label: "New folder", icon: <FolderPlus size={14} />, shortcut: "⇧⌘N", onSelect: () => askNewFolder(side) });
    items.push({ label: "Refresh", icon: <RefreshCw size={14} />, shortcut: "⌘R", onSelect: () => void pane.refresh() });
    items.push({
      label: showHidden ? "Hide hidden files" : "Show hidden files",
      icon: <Eye size={14} />,
      shortcut: "⇧⌘.",
      onSelect: () => setShowHidden((v) => !v),
    });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---- Dragging between panes ----

  const validTarget = (payload: DragPayload, target: DropTarget | null): DropTarget | null => {
    if (!target) return null;
    if (target.side === "remote" && !latest.current.session) return null;
    if (target.side === payload.side) {
      // Same pane: only a move into another folder makes sense.
      if (!target.folder || payload.entries.some((e) => e.name === target.folder)) return null;
    }
    return target;
  };

  const handleDrop = (payload: DragPayload, target: DropTarget) => {
    const { local: l, remote: r, session: s } = latest.current;
    const pane = target.side === "local" ? l : r;
    const dir = target.folder ? joinPath(pane.path, target.folder) : pane.path;
    if (target.side !== payload.side) {
      if (payload.side === "local") void upload(payload.entries, payload.dir, dir);
      else void download(payload.entries, payload.dir, dir);
      return;
    }
    void run(async () => {
      for (const entry of payload.entries) {
        const from = joinPath(payload.dir, entry.name);
        const to = joinPath(dir, entry.name);
        if (target.side === "local") await api.localRename(from, to);
        else await api.remoteRename(s!.id, from, to);
      }
    }, pane.refresh);
  };

  const startDrag = (side: Side, e: ReactMouseEvent, entries: Entry[]) => {
    if (!entries.length) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const payload: DragPayload = { side, dir: (side === "local" ? local : remote).path, entries };
    let active = false;
    const move = (ev: MouseEvent) => {
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      active = true;
      setDrag({ payload, x: ev.clientX, y: ev.clientY });
      setDropTarget(validTarget(payload, dropTargetAt(ev.clientX, ev.clientY)));
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!active) return;
      const target = validTarget(payload, dropTargetAt(ev.clientX, ev.clientY));
      setDrag(null);
      setDropTarget(null);
      if (target) handleDrop(payload, target);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // ---- Keyboard shortcuts ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "k") {
        e.preventDefault();
        setSitesOpen(true);
        // The panel may still be mounting when it was closed.
        requestAnimationFrame(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        });
      } else if (e.key === "r") {
        // Cmd+R would reload the web view.
        e.preventDefault();
      } else if (e.key === "1" || e.key === "2") {
        e.preventDefault();
        const selector = e.key === "1" ? '[data-drop-side="local"] .file-list' : '[data-drop-side="remote"] .file-list';
        document.querySelector<HTMLElement>(selector)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Queue ----

  const jobList = useMemo(() => [...jobs.values()].sort((a, b) => a.id - b.id), [jobs]);

  const queueAction = (action: () => Promise<unknown>) => void action().catch((e) => toast("error", toAppError(e).message));

  // ---- Dialogs ----

  const closeDialog = () => setDialog(null);

  const renderDialog = () => {
    if (!dialog) return null;
    switch (dialog.type) {
      case "site":
        return (
          <SiteDialog
            site={dialog.site}
            folders={folders}
            home={home}
            onCancel={closeDialog}
            onSave={(site, secrets, connect) => void saveSite(site, secrets, connect)}
            onConnectOnly={(site, password) => {
              closeDialog();
              void connectTo(site, { password: password || undefined });
            }}
            onDelete={dialog.site.id ? () => confirmDeleteSite(dialog.site) : undefined}
          />
        );
      case "secret":
        return (
          <SecretDialog
            kind={dialog.kind}
            siteLabel={dialog.site.name || dialog.site.host}
            message={dialog.message}
            canRemember={!!dialog.site.id && dialog.site.auth !== "ask"}
            onCancel={closeDialog}
            onSubmit={(value, remember) => {
              const site = dialog.site;
              closeDialog();
              void connectTo(site, dialog.kind === "password" ? { password: value, remember } : { passphrase: value, remember });
            }}
          />
        );
      case "hostkey":
        return (
          <HostKeyDialog
            hostPort={dialog.hostPort}
            expected={dialog.expected}
            actual={dialog.actual}
            onCancel={closeDialog}
            onTrust={async () => {
              const site = dialog.site;
              closeDialog();
              await api.trustHostKey(dialog.hostPort, dialog.actual);
              void connectTo(site);
            }}
          />
        );
      case "input":
        return (
          <InputDialog
            title={dialog.title}
            label={dialog.label}
            initial={dialog.initial}
            confirmLabel={dialog.confirmLabel}
            onCancel={closeDialog}
            onConfirm={(value) => {
              closeDialog();
              dialog.onConfirm(value);
            }}
          />
        );
      case "confirm":
        return (
          <ConfirmDialog
            title={dialog.title}
            message={dialog.message}
            confirmLabel={dialog.confirmLabel}
            danger={dialog.danger}
            onCancel={closeDialog}
            onConfirm={() => {
              closeDialog();
              dialog.onConfirm();
            }}
          />
        );
      case "chmod":
        return (
          <ChmodDialog
            names={dialog.names}
            initial={dialog.initial}
            onCancel={closeDialog}
            onConfirm={(mode) => {
              closeDialog();
              void run(() => api.remoteChmod(session!.id, dialog.paths, mode), remote.refresh);
            }}
          />
        );
      case "import":
        return <ImportReportDialog report={dialog.report} onClose={closeDialog} />;
    }
  };

  // ---- Layout ----

  const remotePlaceholder = session ? undefined : connecting ? (
    <div className="placeholder">
      <LoaderCircle size={28} className="spin accent" />
      <h3>Connecting to {connecting.name || connecting.host}</h3>
      <p className="muted">
        {protocolLabel(connecting.protocol)} · {connecting.host}:{connecting.port}
      </p>
    </div>
  ) : (
    <div className="placeholder">
      <Server size={34} strokeWidth={1.4} />
      <h3>No server connected</h3>
      {sites.length === 0 ? (
        <>
          <p className="muted">Bring over your saved sites from FileZilla or Cyberduck, or add one.</p>
          <div className="placeholder-actions">
            <button type="button" className="button" onClick={() => void importSites("filezilla")}>
              <FileInput size={14} /> Import from FileZilla
            </button>
            <button type="button" className="button" onClick={() => void importSites("cyberduck")}>
              <FileInput size={14} /> Import from Cyberduck
            </button>
            <button type="button" className="button primary" onClick={() => setDialog({ type: "site", site: emptySite() })}>
              <Plus size={14} /> New site
            </button>
          </div>
        </>
      ) : selectedSite ? (
        <>
          <p className="muted">
            {selectedSite.user ? `${selectedSite.user}@` : ""}
            {selectedSite.host}
          </p>
          <div className="placeholder-actions">
            <button type="button" className="button primary" onClick={() => void connectTo(selectedSite)}>
              <Plug size={14} /> Connect to {selectedSite.name || selectedSite.host}
            </button>
          </div>
        </>
      ) : (
        <p className="muted">Double-click a site in the sidebar to connect. ⌘K searches your sites.</p>
      )}
    </div>
  );

  // ---- Sidebar ----

  const toggleCompact = () => {
    setCompact(!compact);
    localStorage.setItem(COMPACT_KEY, compact ? "0" : "1");
  };

  const startSideResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sideWidth;
    const move = (ev: MouseEvent) => setSideWidth(Math.max(220, Math.min(480, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
      setSideWidth((w) => (localStorage.setItem(SIDE_KEY, String(w)), w));
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const sideButton = (name: SidebarIconName, tip: string, onClick: (e: ReactMouseEvent) => void, active = false, badge = 0) => (
    <button type="button" className={`activity-button${active ? " active" : ""}`} data-tip={tip} aria-label={tip} onClick={onClick}>
      <SidebarIcon name={name} filled={active} />
      {badge > 0 && <span className="activity-badge">{badge > 99 ? "99+" : badge}</span>}
    </button>
  );

  const menuBeside = (e: ReactMouseEvent, items: MenuEntry[]) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: rect.right + 8, y: Math.max(8, rect.bottom - 30 - items.length * 26), items });
  };

  const importMenu = (e: ReactMouseEvent) =>
    menuBeside(e, [
      { label: "Import from FileZilla", icon: <FileInput size={14} />, onSelect: () => void importSites("filezilla") },
      { label: "Import from Cyberduck", icon: <FileInput size={14} />, onSelect: () => void importSites("cyberduck") },
    ]);

  const settingsMenu = (e: ReactMouseEvent) =>
    menuBeside(e, [
      {
        label: "Appearance",
        icon: theme === "dark" ? <Moon size={14} /> : <Sun size={14} />,
        detail: theme === "dark" ? "Dark" : "Light",
        submenu: {
          items: (["light", "dark"] as Theme[]).map((t) => ({
            label: t === "dark" ? "Dark" : "Light",
            checked: theme === t,
            onSelect: () => {
              setThemeSwitched(true);
              setTheme(t);
            },
          })),
        },
      },
      {
        label: "File icons",
        icon: <Rainbow size={14} />,
        detail: ICON_SETS.find((set) => set.id === iconSet)?.label,
        submenu: {
          items: ICON_SETS.map((set) => ({ label: set.label, checked: set.id === iconSet, onSelect: () => setIconSet(set.id) })),
        },
      },
      "separator",
      {
        label: "Memes",
        icon: <Cat size={14} />,
        detail: memes ? "On" : "Off",
        submenu: {
          items: [true, false].map((on) => ({
            label: on ? "Enable" : "Disable",
            checked: memes === on,
            onSelect: () => {
              setMemes(on);
              localStorage.setItem(MEMES_KEY, on ? "1" : "0");
            },
          })),
        },
      },
    ]);

  const runningJobs = jobList.filter((j) => j.state === "queued" || j.state === "active" || j.state === "conflict").length;

  return (
    <ThemeContext.Provider value={theme}>
      <IconSetContext.Provider value={iconContext}>
        <div
          className={`app${drag ? " dragging" : ""}${compact ? " compact" : ""}`}
          style={{ ["--side-w" as string]: sitesOpen ? `${sideWidth}px` : "0px" }}
        >
          <header className="titlebar" data-tauri-drag-region>
            <div className="titlebar-left" data-tauri-drag-region>
              <span className="brand" data-tauri-drag-region>
                <BrandMark />
                <span className="brand-name" data-tauri-drag-region>
                  Dispatch
                </span>
              </span>
            </div>
            <div className="connection" data-tauri-drag-region>
              {connecting ? (
                <span className="connection-pill connecting">
                  <LoaderCircle size={13} className="spin" />
                  <span>Connecting to {connecting.name || connecting.host}</span>
                </span>
              ) : session ? (
                <>
                  <span className="connection-pill">
                    <span className="live-dot" />
                    <strong>{session.label}</strong>
                  </span>
                  <span className="proto-tag" data-tauri-drag-region>
                    {protocolLabel(session.protocol)}
                  </span>
                  <span className="connection-where" data-tauri-drag-region>
                    {session.user}@{session.host}
                  </span>
                </>
              ) : (
                <span className="connection-where" data-tauri-drag-region>
                  Not connected
                </span>
              )}
            </div>
            <div className="titlebar-actions">
              {session ? (
                <button type="button" className="button small danger" onClick={() => void disconnect()}>
                  <Unplug size={13} /> Disconnect
                </button>
              ) : (
                selectedSite &&
                !connecting && (
                  <button type="button" className="button small primary" onClick={() => void connectTo(selectedSite)}>
                    <Plug size={13} /> Connect
                  </button>
                )
              )}
              <UpdateButton app="Dispatch SFTP" repo="lakiAlex/dispatch" restartNote="Running transfers stop." notify />
              <WindowSnap />
              <button
                type="button"
                role="switch"
                aria-checked={theme === "dark"}
                className={`theme-switch ${theme}${themeSwitched ? " switched" : ""}`}
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                onClick={() => {
                  setThemeSwitched(true);
                  setTheme((t) => (t === "dark" ? "light" : "dark"));
                }}
              >
                <span className="theme-thumb" />
                <span className="theme-option sun">
                  <Sun size={15} strokeWidth={1.9} />
                </span>
                <span className="theme-option moon">
                  <Moon size={12.5} strokeWidth={1.9} />
                </span>
              </button>
            </div>
          </header>

          <nav className="activity-bar">
            <div className="activity-group">
              {sideButton("sites", "Sites (⌘K)", () => setSitesOpen((o) => !o), sitesOpen)}
              {sideButton("transfers", panel.collapsed ? "Show transfers" : "Hide transfers", () => setPanel((p) => ({ ...p, collapsed: !p.collapsed })), !panel.collapsed, runningJobs)}
            </div>
            <div className="activity-group">
              {sideButton("new", "New site", () => setDialog({ type: "site", site: emptySite() }))}
              {sideButton("import", "Import sites", importMenu)}
            </div>
            <span className="activity-spacer" />
            <div className="activity-group">
              {sideButton("sidebar", compact ? "Expand sidebar" : "Minimize sidebar", toggleCompact)}
              {sideButton("settings", "Settings", settingsMenu)}
            </div>
          </nav>

          <aside className="side-panel">
            {sitesOpen && (
              <div className="side-panel-body">
              <Sidebar
                ref={searchRef}
                sites={sites}
                selectedId={selectedSiteId}
                connectedSiteId={session?.siteId ?? null}
                connectingSiteId={connecting?.id || null}
                onSelect={setSelectedSiteId}
                onConnect={(site) => void connectTo(site)}
                onNew={() => setDialog({ type: "site", site: emptySite() })}
                onClose={() => setSitesOpen(false)}
                onImport={(source) => void importSites(source)}
                onContextMenu={siteMenu}
                onListContextMenu={(e) =>
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: "New site", icon: <Plus size={14} />, onSelect: () => setDialog({ type: "site", site: emptySite() }) },
                      { label: "Import from FileZilla", icon: <FileInput size={14} />, onSelect: () => void importSites("filezilla") },
                        { label: "Import from Cyberduck", icon: <FileInput size={14} />, onSelect: () => void importSites("cyberduck") },
                    ],
                  })
                }
              />
              </div>
            )}
            {sitesOpen && <div className="side-resize" onMouseDown={startSideResize} />}
          </aside>

          <main className="content">
            {memes && <MemeButton />}
            <div className="panes">
              <FilePane
                side="local"
                title="This Mac"
                icon={<Laptop size={14} />}
                model={local}
                home={home}
                showPermissions={false}
                showHidden={showHidden}
                onToggleHidden={() => setShowHidden((v) => !v)}
                onOpenFiles={(entries) => void upload(entries, local.path)}
                onContextMenu={(e, selected) => paneMenu("local", e, selected)}
                onDelete={(entries) => askDelete("local", entries)}
                onRename={(entry) => askRename("local", entry)}
                onNewFolder={() => askNewFolder("local")}
                onStartDrag={(e, entries) => startDrag("local", e, entries)}
                dropTarget={dropTarget}
              />
              <FilePane
                side="remote"
                title={session ? session.label : "Server"}
                icon={<Server size={14} />}
                badge={session ? <span className="proto-tag">{protocolLabel(session.protocol)}</span> : undefined}
                headerActions={
                  connecting && (
                    <button type="button" className="button small stop-button" onClick={() => void api.cancelConnect()}>
                      <Square size={12} /> Stop
                    </button>
                  )
                }
                model={remote}
                home={session?.home ?? ""}
                showPermissions
                showHidden={showHidden}
                onToggleHidden={() => setShowHidden((v) => !v)}
                onOpenFiles={(entries) => void download(entries, remote.path)}
                onContextMenu={(e, selected) => session && paneMenu("remote", e, selected)}
                onDelete={(entries) => askDelete("remote", entries)}
                onRename={(entry) => askRename("remote", entry)}
                onNewFolder={() => askNewFolder("remote")}
                onStartDrag={(e, entries) => startDrag("remote", e, entries)}
                dropTarget={dropTarget}
                placeholder={remotePlaceholder}
              />
            </div>

            <TransferPanel
              jobs={jobList}
              logs={logs}
              policy={policy}
              collapsed={panel.collapsed}
              height={panel.height}
              onToggle={() => setPanel((p) => ({ ...p, collapsed: !p.collapsed }))}
              onResize={(height) => setPanel((p) => ({ ...p, height }))}
              onPolicy={(next) => {
                setPolicy(next);
                queueAction(() => api.queueSetPolicy(next));
              }}
              onCancel={(ids) => queueAction(() => api.queueCancel(ids))}
              onRetry={(ids) => queueAction(() => api.queueRetry(ids))}
              onClear={(states: JobState[]) => queueAction(() => api.queueClear(states))}
              onResolve={(ids, overwrite, all) => {
                if (all) setPolicy(overwrite ? "overwrite" : "skip");
                queueAction(() => api.queueResolve(ids, overwrite, all));
              }}
              onClearLog={() => setLogs([])}
              queueSignal={queueSignal}
            />
          </main>

          {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
          {renderDialog()}

          {drag && (
            <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }}>
              {drag.payload.entries.length === 1 ? drag.payload.entries[0].name : pluralize(drag.payload.entries.length, "item")}
              {dropTarget && (
                <span className="drag-hint">
                  {dropTarget.side !== drag.payload.side ? (dropTarget.side === "remote" ? "Upload" : "Download") : "Move"}
                </span>
              )}
            </div>
          )}

          <div className="toasts">
            {toasts.map((t) => (
              <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
                {t.message}
              </div>
            ))}
          </div>
        </div>
      </IconSetContext.Provider>
    </ThemeContext.Provider>
  );
}
