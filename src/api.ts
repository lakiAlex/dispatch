import { invoke } from "@tauri-apps/api/core";

export type Protocol = "sftp" | "ftp" | "ftpes" | "ftps" | "ftp-plain";
export type AuthMethod = "password" | "ask" | "key" | "agent" | "anonymous";

export interface Site {
  id: string;
  name: string;
  folder: string;
  protocol: Protocol;
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  keyPath: string;
  remoteDir: string;
  localDir: string;
  insecureTls: boolean;
  color: string;
  notes: string;
  passwordSaved: boolean;
  passphraseSaved: boolean;
}

export interface Entry {
  name: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified: number | null;
  mode: number | null;
  owner: string | null;
}

export interface SessionInfo {
  id: string;
  siteId: string | null;
  label: string;
  protocol: Protocol;
  host: string;
  user: string;
  home: string;
  startDir: string;
  localDir: string;
  connKey: string;
}

export interface AppError {
  code: string;
  message: string;
  data?: Record<string, string>;
}

export type JobKind = "upload" | "download" | "mkdir-remote" | "list-remote";
export type JobState = "queued" | "active" | "done" | "failed" | "conflict" | "skipped" | "cancelled";
export type ConflictPolicy = "ask" | "overwrite" | "overwrite-if-different" | "skip";

export interface Job {
  id: number;
  kind: JobKind;
  name: string;
  local: string;
  remote: string;
  size: number;
  transferred: number;
  state: JobState;
  error: string | null;
  conflict: { existingSize: number; newSize: number } | null;
  site: string;
  connKey: string;
  speed: number;
}

export interface JobProgress {
  id: number;
  transferred: number;
  speed: number;
}

export interface ImportReport {
  path: string;
  found: number;
  imported: number;
  alreadyPresent: number;
  unsupported: string[];
  needPassword: string[];
}

export interface LogLine {
  time: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface RemoteItem {
  path: string;
  name: string;
  isDir: boolean;
  isLink?: boolean;
  size?: number;
}

export const PROTOCOLS: { value: Protocol; label: string; port: number }[] = [
  { value: "sftp", label: "SFTP", port: 22 },
  { value: "ftp", label: "FTP", port: 21 },
  { value: "ftpes", label: "FTPES", port: 21 },
  { value: "ftps", label: "FTPS", port: 990 },
  { value: "ftp-plain", label: "FTP (plain)", port: 21 },
];

export function protocolLabel(p: Protocol): string {
  return PROTOCOLS.find((x) => x.value === p)?.label ?? p;
}

export function emptySite(): Site {
  return {
    id: "",
    name: "",
    folder: "",
    protocol: "sftp",
    host: "",
    port: 22,
    user: "",
    auth: "password",
    keyPath: "",
    remoteDir: "",
    localDir: "",
    insecureTls: false,
    color: "",
    notes: "",
    passwordSaved: false,
    passphraseSaved: false,
  };
}

export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as AppError;
  return { code: "error", message: String(e) };
}

export const api = {
  listSites: () => invoke<Site[]>("list_sites"),
  saveSite: (site: Site, password?: string | null, passphrase?: string | null) =>
    invoke<Site>("save_site", { site, password, passphrase }),
  deleteSite: (id: string) => invoke<void>("delete_site", { id }),
  filezillaPath: () => invoke<string | null>("filezilla_path"),
  importFilezilla: (path?: string) => invoke<ImportReport>("import_filezilla", { path }),

  connect: (site: Site, opts: { password?: string; passphrase?: string; remember?: boolean } = {}) =>
    invoke<SessionInfo>("connect", {
      site,
      password: opts.password,
      passphrase: opts.passphrase,
      remember: opts.remember ?? false,
    }),
  cancelConnect: () => invoke<void>("cancel_connect"),
  disconnect: (sessionId: string) => invoke<void>("disconnect", { sessionId }),
  trustHostKey: (hostPort: string, fingerprint: string) => invoke<void>("trust_host_key", { hostPort, fingerprint }),

  remoteList: (sessionId: string, path: string) => invoke<Entry[]>("remote_list", { sessionId, path }),
  remoteMkdir: (sessionId: string, path: string) => invoke<void>("remote_mkdir", { sessionId, path }),
  remoteRename: (sessionId: string, from: string, to: string) => invoke<void>("remote_rename", { sessionId, from, to }),
  remoteDelete: (sessionId: string, items: RemoteItem[]) => invoke<void>("remote_delete", { sessionId, items }),
  remoteChmod: (sessionId: string, paths: string[], mode: number) =>
    invoke<void>("remote_chmod", { sessionId, paths, mode }),

  localHome: () => invoke<string>("local_home"),
  localList: (path: string) => invoke<Entry[]>("local_list", { path }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  localRename: (from: string, to: string) => invoke<void>("local_rename", { from, to }),
  localTrash: (paths: string[]) => invoke<void>("local_trash", { paths }),

  enqueueUpload: (sessionId: string, localPaths: string[], remoteDir: string) =>
    invoke<number>("enqueue_upload", { sessionId, localPaths, remoteDir }),
  enqueueDownload: (sessionId: string, items: RemoteItem[], localDir: string) =>
    invoke<number>("enqueue_download", { sessionId, items, localDir }),
  queueSnapshot: () => invoke<{ jobs: Job[]; policy: ConflictPolicy }>("queue_snapshot"),
  queueCancel: (ids?: number[]) => invoke<void>("queue_cancel", { ids }),
  queueRetry: (ids: number[]) => invoke<void>("queue_retry", { ids }),
  queueClear: (states: JobState[]) => invoke<void>("queue_clear", { states }),
  queueResolve: (ids: number[], overwrite: boolean, applyToAll: boolean) =>
    invoke<void>("queue_resolve", { ids, overwrite, applyToAll }),
  queueSetPolicy: (policy: ConflictPolicy) => invoke<void>("queue_set_policy", { policy }),
};
