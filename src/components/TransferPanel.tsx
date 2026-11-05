import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, FolderOpen, RotateCw, TriangleAlert, X } from "./icons";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { ConflictPolicy, Job, JobState, LogLine } from "../api";
import { formatSize, formatSpeed } from "../lib/format";

type Tab = "queue" | "failed" | "done" | "log";

const QUEUE_STATES: JobState[] = ["active", "queued", "conflict"];
const DONE_STATES: JobState[] = ["done", "skipped", "cancelled"];
const MAX_ROWS = 400;

interface TransferPanelProps {
  jobs: Job[];
  logs: LogLine[];
  policy: ConflictPolicy;
  collapsed: boolean;
  height: number;
  onToggle: () => void;
  onResize: (height: number) => void;
  onPolicy: (policy: ConflictPolicy) => void;
  onCancel: (ids?: number[]) => void;
  onRetry: (ids: number[]) => void;
  onClear: (states: JobState[]) => void;
  onResolve: (ids: number[], overwrite: boolean, applyToAll: boolean) => void;
  onClearLog: () => void;
  /** Changes when transfers are added, to bring the Transfers tab forward. */
  queueSignal: number;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// Log highlighting. Each group maps to a Tokyo Night color class, in this order:
// fingerprint, URL scheme, protocol name, host (with optional port), path, number.
const LOG_TOKEN =
  /(SHA256:[A-Za-z0-9+/=]+)|(\b[A-Za-z]+(?: \(plain\))?:\/\/)|(\b(?:SFTP|FTPES|FTPS|FTP)\b)|((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)|((?:~|\/)(?:[^\s,()]*[^\s,():.])?)|(\b\d+(?:\.\d+)?\b)/gi;
const TOKEN_CLASSES = ["tn-magenta", "tn-blue", "tn-blue", "tn-teal", "tn-cyan", "tn-orange"];
const LOG_VERBS: [RegExp, string][] = [
  [/^(Connected|Imported|Trusted new host key)\b/, "tn-green"],
  [/^(Connecting|Reconnecting)\b/, "tn-blue"],
  [/^(Disconnected|Stopped connecting)\b/, "tn-yellow"],
  [/^Deleted\b/, "tn-orange"],
];

function highlightLog(message: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let rest = message;
  for (const [pattern, className] of LOG_VERBS) {
    const match = pattern.exec(rest);
    if (match) {
      parts.push(<span key="verb" className={className}>{match[0]}</span>);
      rest = rest.slice(match[0].length);
      break;
    }
  }
  let last = 0;
  for (const match of rest.matchAll(LOG_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(rest.slice(last, index));
    const group = match.slice(1).findIndex((g) => g !== undefined);
    parts.push(
      <span key={index} className={TOKEN_CLASSES[group]}>
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < rest.length) parts.push(rest.slice(last));
  return parts;
}

function JobRow({ job, actions }: { job: Job; actions: ReactNode }) {
  const upload = job.kind === "upload" || job.kind === "mkdir-remote";
  const percent = job.size > 0 ? Math.min(100, (job.transferred / job.size) * 100) : job.state === "done" ? 100 : 0;
  const from = upload ? job.local : job.remote;
  const to = upload ? job.remote : job.local;
  return (
    <div className={`job-row state-${job.state}`}>
      <span className={`job-kind ${upload ? "up" : "down"}`}>
        {job.kind === "list-remote" ? <FolderOpen size={13} /> : upload ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
      </span>
      <div className="job-main">
        <div className="job-name">
          <span className="job-name-text">{job.kind === "list-remote" ? `Listing ${job.name}` : job.name}</span>
          <span className="job-site">{job.site}</span>
        </div>
        {job.state === "failed" && job.error ? (
          <div className="job-error" title={job.error}>
            {job.error}
          </div>
        ) : job.state === "conflict" && job.conflict ? (
          <div className="job-conflict">
            Already exists ({formatSize(job.conflict.existingSize)}). New file is {formatSize(job.conflict.newSize)}.
          </div>
        ) : (
          <div className="job-path" title={`${from} → ${to}`}>
            {from} <span className="arrow">→</span> {to}
          </div>
        )}
      </div>
      <div className="job-status">
        {job.state === "active" ? (
          <>
            <div className="progress">
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="job-numbers">
              {formatSize(job.transferred)}
              {job.size > 0 && ` of ${formatSize(job.size)}`}
              {job.speed > 0 && <span className="job-speed"> · {formatSpeed(job.speed)}</span>}
            </div>
          </>
        ) : (
          <div className="job-numbers">
            <span className={`state-label ${job.state}`}>{job.state === "queued" ? "Waiting" : job.state}</span>
            {job.size > 0 && job.kind !== "list-remote" && ` · ${formatSize(job.size)}`}
          </div>
        )}
      </div>
      <div className="job-actions">{actions}</div>
    </div>
  );
}

export function TransferPanel(props: TransferPanelProps) {
  const { jobs, logs } = props;
  const [tab, setTab] = useState<Tab>("log");
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const groups = useMemo(() => {
    const queue = jobs.filter((j) => QUEUE_STATES.includes(j.state));
    queue.sort((a, b) => (a.state === "active" ? 0 : 1) - (b.state === "active" ? 0 : 1) || a.id - b.id);
    return {
      queue,
      failed: jobs.filter((j) => j.state === "failed"),
      done: jobs.filter((j) => DONE_STATES.includes(j.state)).reverse(),
      active: jobs.filter((j) => j.state === "active"),
      conflicts: jobs.filter((j) => j.state === "conflict"),
    };
  }, [jobs]);

  const totalSpeed = groups.active.reduce((sum, j) => sum + j.speed, 0);
  const queuedBytes = groups.queue.reduce((sum, j) => sum + Math.max(0, j.size - j.transferred), 0);

  useEffect(() => {
    if (props.queueSignal > 0) setTab("queue");
  }, [props.queueSignal]);

  useEffect(() => {
    if (tab === "log" && logRef.current && stickToBottom.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, tab]);

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = props.height;
    const move = (ev: MouseEvent) => {
      const max = window.innerHeight * 0.7;
      props.onResize(Math.min(max, Math.max(140, startHeight + (startY - ev.clientY))));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const tabButton = (id: Tab, label: string, count?: number, tone?: string) => (
    <button
      type="button"
      className={`tab${tab === id && !props.collapsed ? " active" : ""}`}
      onClick={() => {
        setTab(id);
        if (props.collapsed) props.onToggle();
      }}
    >
      {label}
      {count !== undefined && count > 0 && <span className={`tab-count ${tone ?? ""}`}>{count}</span>}
    </button>
  );

  const list = tab === "queue" ? groups.queue : tab === "failed" ? groups.failed : groups.done;

  return (
    <section className={`transfer-panel${props.collapsed ? " collapsed" : ""}`} style={{ height: props.collapsed ? undefined : props.height }}>
      {!props.collapsed && <div className="resize-handle" onMouseDown={startResize} />}
      <header className="panel-header">
        <div className="tabs">
          {tabButton("log", "Log")}
          {tabButton("queue", "Transfers", groups.queue.length, groups.active.length ? "accent" : "")}
          {tabButton("done", "Finished", groups.done.length)}
          {tabButton("failed", "Failed", groups.failed.length, "danger")}
        </div>
        <div className="panel-summary">
          {groups.active.length > 0 && (
            <span>
              {formatSpeed(totalSpeed)} · {formatSize(queuedBytes)} left
            </span>
          )}
        </div>
        <div className="panel-actions">
          {!props.collapsed && tab === "queue" && (
            <>
              <label className="policy">
                <span>If file exists</span>
                <select value={props.policy} onChange={(e) => props.onPolicy(e.target.value as ConflictPolicy)}>
                  <option value="ask">Ask</option>
                  <option value="overwrite">Overwrite</option>
                  <option value="overwrite-if-different">Overwrite if size differs</option>
                  <option value="skip">Skip</option>
                </select>
              </label>
              <button type="button" className="button small" disabled={groups.queue.length === 0} onClick={() => props.onCancel()}>
                Cancel all
              </button>
            </>
          )}
          {!props.collapsed && tab === "failed" && (
            <>
              <button
                type="button"
                className="button small"
                disabled={groups.failed.length === 0}
                onClick={() => props.onRetry(groups.failed.map((j) => j.id))}
              >
                Retry all
              </button>
              <button type="button" className="button small" disabled={groups.failed.length === 0} onClick={() => props.onClear(["failed"])}>
                Clear
              </button>
            </>
          )}
          {!props.collapsed && tab === "done" && (
            <button type="button" className="button small" disabled={groups.done.length === 0} onClick={() => props.onClear(DONE_STATES)}>
              Clear
            </button>
          )}
          {!props.collapsed && tab === "log" && (
            <button type="button" className="button small" disabled={logs.length === 0} onClick={props.onClearLog}>
              Clear
            </button>
          )}
          <button type="button" className="icon-button" title={props.collapsed ? "Show transfers" : "Hide transfers"} onClick={props.onToggle}>
            {props.collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </header>

      {!props.collapsed && (
        <div className="panel-body">
          {tab === "queue" && groups.conflicts.length > 0 && (
            <div className="conflict-banner">
              <TriangleAlert size={14} />
              <span>
                {groups.conflicts.length === 1 ? "1 file already exists" : `${groups.conflicts.length} files already exist`} at the
                destination.
              </span>
              <span className="spacer" />
              <button type="button" className="button small" onClick={() => props.onResolve([], false, true)}>
                Skip all
              </button>
              <button type="button" className="button small primary" onClick={() => props.onResolve([], true, true)}>
                Overwrite all
              </button>
            </div>
          )}

          {tab === "log" ? (
            <div
              ref={logRef}
              className="log-list"
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
            >
              {logs.length === 0 && <div className="panel-empty">Connection messages appear here.</div>}
              {logs.map((line, i) => (
                <div key={i} className={`log-line ${line.level}`}>
                  <span className="log-time">{timeFormat.format(new Date(line.time))}</span>
                  <span className="log-level">{line.level === "error" ? "ERR" : line.level.toUpperCase()}</span>
                  <span className="log-message">{highlightLog(line.message)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="job-list">
              {list.length === 0 && (
                <div className="panel-empty">
                  {tab === "queue"
                    ? "Drag files between the panes, or double-click a file, to transfer it."
                    : tab === "failed"
                      ? "No failed transfers."
                      : "Finished transfers appear here."}
                </div>
              )}
              {list.slice(0, MAX_ROWS).map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  actions={
                    job.state === "conflict" ? (
                      <>
                        <button type="button" className="button small" onClick={() => props.onResolve([job.id], false, false)}>
                          Skip
                        </button>
                        <button type="button" className="button small primary" onClick={() => props.onResolve([job.id], true, false)}>
                          Overwrite
                        </button>
                      </>
                    ) : job.state === "active" || job.state === "queued" ? (
                      <button type="button" className="icon-button" title="Cancel" onClick={() => props.onCancel([job.id])}>
                        <X size={14} />
                      </button>
                    ) : job.state === "failed" || job.state === "cancelled" ? (
                      <button type="button" className="icon-button" title="Retry" onClick={() => props.onRetry([job.id])}>
                        <RotateCw size={13} />
                      </button>
                    ) : null
                  }
                />
              ))}
              {list.length > MAX_ROWS && <div className="panel-more">and {list.length - MAX_ROWS} more</div>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
