//! Transfer queue. Each worker keeps its own connections, separate from the
//! browsing connection, so the file panes stay usable during transfers.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::error::AppResult;
use crate::remote::{join, parent, Conn, ConnectParams, Ctx, Progress};

const IDLE_CLOSE: Duration = Duration::from_secs(60);
const MAX_DEPTH: u8 = 40;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JobKind {
    Upload,
    Download,
    /// Create a remote folder (empty folders in an upload).
    MkdirRemote,
    /// List a remote folder and queue its contents for download.
    ListRemote,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JobState {
    Queued,
    Active,
    Done,
    Failed,
    Conflict,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictPolicy {
    Ask,
    Overwrite,
    OverwriteIfDifferent,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Resolution {
    Overwrite,
}

enum Decision {
    Overwrite,
    Skip,
    Ask,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    existing_size: u64,
    new_size: u64,
}

/// The server a job runs against.
pub struct Target {
    pub params: Arc<ConnectParams>,
    pub label: String,
}

pub struct NewJob {
    pub kind: JobKind,
    pub local: PathBuf,
    pub remote: String,
    /// Remote folder the user dropped files into. Folders below it are created as needed.
    pub base: String,
    pub size: u64,
    pub depth: u8,
}

struct Job {
    id: u64,
    kind: JobKind,
    local: PathBuf,
    remote: String,
    base: String,
    size: u64,
    depth: u8,
    state: JobState,
    error: Option<String>,
    conflict: Option<ConflictInfo>,
    resolution: Option<Resolution>,
    target: Arc<Target>,
    progress: Progress,
    speed: f64,
    sample: (Instant, u64),
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    id: u64,
    kind: JobKind,
    name: String,
    local: String,
    remote: String,
    size: u64,
    transferred: u64,
    state: JobState,
    error: Option<String>,
    conflict: Option<ConflictInfo>,
    site: String,
    conn_key: String,
    speed: f64,
}

#[derive(Serialize, Clone)]
struct ProgressView {
    id: u64,
    transferred: u64,
    speed: f64,
}

impl Job {
    fn view(&self) -> JobView {
        let name = match self.kind {
            JobKind::Upload | JobKind::MkdirRemote => {
                self.local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            }
            _ => self.remote.rsplit('/').next().unwrap_or(&self.remote).to_string(),
        };
        JobView {
            id: self.id,
            kind: self.kind,
            name,
            local: self.local.to_string_lossy().into_owned(),
            remote: self.remote.clone(),
            size: self.size,
            transferred: self.progress.transferred.load(Ordering::Relaxed),
            state: self.state,
            error: self.error.clone(),
            conflict: self.conflict.clone(),
            site: self.target.label.clone(),
            conn_key: self.target.params.key(),
            speed: self.speed,
        }
    }
}

/// Copy of a job taken by a worker, so the queue lock is not held during I/O.
struct Task {
    id: u64,
    kind: JobKind,
    local: PathBuf,
    remote: String,
    base: String,
    size: u64,
    depth: u8,
    resolution: Option<Resolution>,
    target: Arc<Target>,
    progress: Progress,
}

enum Outcome {
    Done,
    Skipped,
    Conflict(ConflictInfo),
    Expanded(Vec<NewJob>),
}

struct Queue {
    jobs: Vec<Job>,
    next_id: u64,
    dirty: HashSet<u64>,
    policy: ConflictPolicy,
    /// Remote folders already created in this run, keyed by "connection|path".
    made_dirs: HashSet<String>,
}

pub struct TransferManager {
    queue: Mutex<Queue>,
    notify: Notify,
    app: AppHandle,
    ctx: Ctx,
}

impl TransferManager {
    pub fn new(app: AppHandle, ctx: Ctx) -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(Queue {
                jobs: Vec::new(),
                next_id: 1,
                dirty: HashSet::new(),
                policy: ConflictPolicy::Ask,
                made_dirs: HashSet::new(),
            }),
            notify: Notify::new(),
            app,
            ctx,
        })
    }

    pub fn start(self: &Arc<Self>, workers: usize) {
        for _ in 0..workers {
            tauri::async_runtime::spawn(self.clone().worker());
        }
        tauri::async_runtime::spawn(self.clone().ticker());
    }

    fn new_job(id: u64, job: NewJob, target: Arc<Target>) -> Job {
        Job {
            id,
            kind: job.kind,
            local: job.local,
            remote: job.remote,
            base: job.base,
            size: job.size,
            depth: job.depth,
            state: JobState::Queued,
            error: None,
            conflict: None,
            resolution: None,
            target,
            progress: Progress::default(),
            speed: 0.0,
            sample: (Instant::now(), 0),
        }
    }

    pub fn enqueue(&self, target: Arc<Target>, jobs: Vec<NewJob>) {
        let mut q = self.queue.lock().unwrap();
        for job in jobs {
            let id = q.next_id;
            q.next_id += 1;
            q.jobs.push(Self::new_job(id, job, target.clone()));
            q.dirty.insert(id);
        }
        drop(q);
        self.notify.notify_waiters();
    }

    pub fn snapshot(&self) -> (Vec<JobView>, ConflictPolicy) {
        let q = self.queue.lock().unwrap();
        (q.jobs.iter().map(Job::view).collect(), q.policy)
    }

    pub fn set_policy(&self, policy: ConflictPolicy) {
        self.queue.lock().unwrap().policy = policy;
    }

    /// Cancels the given jobs, or every unfinished job when `ids` is None.
    pub fn cancel(&self, ids: Option<Vec<u64>>) {
        let mut q = self.queue.lock().unwrap();
        let q = &mut *q;
        for job in q.jobs.iter_mut().filter(|j| ids.as_ref().is_none_or(|ids| ids.contains(&j.id))) {
            match job.state {
                JobState::Queued | JobState::Conflict => {
                    job.state = JobState::Cancelled;
                    q.dirty.insert(job.id);
                }
                JobState::Active => job.progress.cancel.store(true, Ordering::Relaxed),
                _ => {}
            }
        }
    }

    pub fn retry(&self, ids: Vec<u64>) {
        let mut guard = self.queue.lock().unwrap();
        let q = &mut *guard;
        for job in q.jobs.iter_mut().filter(|j| ids.contains(&j.id)) {
            if matches!(job.state, JobState::Failed | JobState::Cancelled | JobState::Skipped) {
                job.state = JobState::Queued;
                job.error = None;
                job.conflict = None;
                job.progress = Progress::default();
                q.dirty.insert(job.id);
            }
        }
        drop(guard);
        self.notify.notify_waiters();
    }

    /// Removes finished jobs in the given states from the list.
    pub fn clear(&self, states: Vec<JobState>) {
        let states: Vec<JobState> = states.into_iter().filter(|s| *s != JobState::Active).collect();
        let mut q = self.queue.lock().unwrap();
        let removed: Vec<u64> = q.jobs.iter().filter(|j| states.contains(&j.state)).map(|j| j.id).collect();
        q.jobs.retain(|j| !states.contains(&j.state));
        drop(q);
        let _ = self.app.emit("queue:remove", removed);
    }

    pub fn resolve(&self, ids: Vec<u64>, overwrite: bool, apply_to_all: bool) {
        let mut q = self.queue.lock().unwrap();
        let q = &mut *q;
        if apply_to_all {
            q.policy = if overwrite { ConflictPolicy::Overwrite } else { ConflictPolicy::Skip };
        }
        for job in q.jobs.iter_mut().filter(|j| j.state == JobState::Conflict) {
            if !apply_to_all && !ids.contains(&job.id) {
                continue;
            }
            job.conflict = None;
            if overwrite {
                job.resolution = Some(Resolution::Overwrite);
                job.state = JobState::Queued;
            } else {
                job.state = JobState::Skipped;
            }
            q.dirty.insert(job.id);
        }
        self.notify.notify_waiters();
    }

    fn take_next(&self) -> Option<Task> {
        let mut q = self.queue.lock().unwrap();
        let q = &mut *q;
        let job = q.jobs.iter_mut().find(|j| j.state == JobState::Queued)?;
        job.state = JobState::Active;
        job.progress = Progress::default();
        job.speed = 0.0;
        job.sample = (Instant::now(), 0);
        q.dirty.insert(job.id);
        Some(Task {
            id: job.id,
            kind: job.kind,
            local: job.local.clone(),
            remote: job.remote.clone(),
            base: job.base.clone(),
            size: job.size,
            depth: job.depth,
            resolution: job.resolution,
            target: job.target.clone(),
            progress: job.progress.clone(),
        })
    }

    async fn worker(self: Arc<Self>) {
        let mut conns: HashMap<String, (Conn, Instant)> = HashMap::new();
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let Some(task) = self.take_next() else {
                let _ = tokio::time::timeout(Duration::from_secs(10), notified).await;
                let now = Instant::now();
                let idle: Vec<String> = conns
                    .iter()
                    .filter(|(_, (_, used))| now.duration_since(*used) > IDLE_CLOSE)
                    .map(|(k, _)| k.clone())
                    .collect();
                for key in idle {
                    if let Some((conn, _)) = conns.remove(&key) {
                        conn.close().await;
                    }
                }
                continue;
            };
            let result = self.run(&task, &mut conns).await;
            self.finish(task, result);
        }
    }

    async fn run(&self, task: &Task, conns: &mut HashMap<String, (Conn, Instant)>) -> AppResult<Outcome> {
        let key = task.target.params.key();
        let mut attempt = 0;
        loop {
            let fresh = !conns.contains_key(&key);
            if fresh {
                let conn = Conn::connect(&task.target.params, &self.ctx).await?;
                conns.insert(key.clone(), (conn, Instant::now()));
            }
            let (conn, used) = conns.get_mut(&key).expect("connection inserted above");
            let result = self.execute(task, conn, &key).await;
            *used = Instant::now();
            match result {
                Err(e) if e.is_connection() => {
                    conns.remove(&key);
                    // A cached connection may have been closed by the server while idle. Try once more.
                    if !fresh && attempt == 0 {
                        attempt += 1;
                        task.progress.transferred.store(0, Ordering::Relaxed);
                        continue;
                    }
                    return Err(e);
                }
                Err(e) if e.code == "cancelled" => {
                    // The data connection was cut mid-transfer; start clean next time.
                    conns.remove(&key);
                    return Err(e);
                }
                other => return other,
            }
        }
    }

    fn decide(&self, resolution: Option<Resolution>, existing: u64, new: u64) -> Decision {
        if resolution == Some(Resolution::Overwrite) {
            return Decision::Overwrite;
        }
        match self.queue.lock().unwrap().policy {
            ConflictPolicy::Ask => Decision::Ask,
            ConflictPolicy::Overwrite => Decision::Overwrite,
            ConflictPolicy::Skip => Decision::Skip,
            ConflictPolicy::OverwriteIfDifferent if existing != new => Decision::Overwrite,
            ConflictPolicy::OverwriteIfDifferent => Decision::Skip,
        }
    }

    async fn execute(&self, task: &Task, conn: &mut Conn, key: &str) -> AppResult<Outcome> {
        match task.kind {
            JobKind::Upload => {
                let new_size = tokio::fs::metadata(&task.local).await?.len();
                if let Some(existing) = conn.file_size(&task.remote).await? {
                    match self.decide(task.resolution, existing, new_size) {
                        Decision::Overwrite => {}
                        Decision::Skip => return Ok(Outcome::Skipped),
                        Decision::Ask => {
                            return Ok(Outcome::Conflict(ConflictInfo { existing_size: existing, new_size }));
                        }
                    }
                }
                self.ensure_dirs(conn, key, &task.base, &parent(&task.remote)).await;
                conn.upload(&task.local, &task.remote, &task.progress).await?;
                Ok(Outcome::Done)
            }
            JobKind::Download => {
                if let Ok(meta) = tokio::fs::metadata(&task.local).await {
                    match self.decide(task.resolution, meta.len(), task.size) {
                        Decision::Overwrite => {}
                        Decision::Skip => return Ok(Outcome::Skipped),
                        Decision::Ask => {
                            return Ok(Outcome::Conflict(ConflictInfo { existing_size: meta.len(), new_size: task.size }));
                        }
                    }
                }
                if let Some(dir) = task.local.parent() {
                    tokio::fs::create_dir_all(dir).await?;
                }
                conn.download(&task.remote, &task.local, &task.progress).await?;
                Ok(Outcome::Done)
            }
            JobKind::MkdirRemote => {
                self.ensure_dirs(conn, key, &task.base, &task.remote).await;
                Ok(Outcome::Done)
            }
            JobKind::ListRemote => {
                let entries = conn.list(&task.remote).await?;
                tokio::fs::create_dir_all(&task.local).await?;
                let children = entries
                    .into_iter()
                    .filter(|e| !e.is_dir || task.depth < MAX_DEPTH)
                    .map(|e| NewJob {
                        kind: if e.is_dir { JobKind::ListRemote } else { JobKind::Download },
                        local: task.local.join(&e.name),
                        remote: join(&task.remote, &e.name),
                        base: String::new(),
                        size: e.size,
                        depth: task.depth + 1,
                    })
                    .collect();
                Ok(Outcome::Expanded(children))
            }
        }
    }

    /// Creates the folders between `base` and `dir`. Errors are ignored here:
    /// the folder usually exists already, and a real problem shows up when
    /// the file upload fails.
    async fn ensure_dirs(&self, conn: &mut Conn, key: &str, base: &str, dir: &str) {
        let base = base.trim_end_matches('/');
        let Some(rest) = dir.strip_prefix(base) else { return };
        if !rest.is_empty() && !rest.starts_with('/') {
            return;
        }
        let mut current = base.to_string();
        for segment in rest.split('/').filter(|s| !s.is_empty()) {
            current = format!("{current}/{segment}");
            let cache_key = format!("{key}|{current}");
            if self.queue.lock().unwrap().made_dirs.contains(&cache_key) {
                continue;
            }
            let _ = conn.mkdir(&current).await;
            self.queue.lock().unwrap().made_dirs.insert(cache_key);
        }
    }

    fn finish(&self, task: Task, result: AppResult<Outcome>) {
        let mut removed = Vec::new();
        let mut guard = self.queue.lock().unwrap();
        let q = &mut *guard;
        let Some(index) = q.jobs.iter().position(|j| j.id == task.id) else { return };
        match result {
            Ok(Outcome::Expanded(children)) => {
                q.jobs.remove(index);
                removed.push(task.id);
                for (offset, child) in children.into_iter().enumerate() {
                    let id = q.next_id;
                    q.next_id += 1;
                    q.jobs.insert(index + offset, Self::new_job(id, child, task.target.clone()));
                    q.dirty.insert(id);
                }
            }
            Ok(Outcome::Done) if task.kind == JobKind::MkdirRemote => {
                q.jobs.remove(index);
                removed.push(task.id);
            }
            result => {
                let job = &mut q.jobs[index];
                match result {
                    Ok(Outcome::Done) => {
                        job.state = JobState::Done;
                        job.size = job.size.max(job.progress.transferred.load(Ordering::Relaxed));
                        job.progress.transferred.store(job.size, Ordering::Relaxed);
                    }
                    Ok(Outcome::Skipped) => job.state = JobState::Skipped,
                    Ok(Outcome::Conflict(info)) => {
                        job.state = JobState::Conflict;
                        job.conflict = Some(info);
                    }
                    Err(e) if e.code == "cancelled" => job.state = JobState::Cancelled,
                    Err(e) => {
                        self.ctx.log.error(format!("{}: {}", job.remote, e.message));
                        job.state = JobState::Failed;
                        job.error = Some(e.message);
                    }
                    Ok(Outcome::Expanded(_)) => unreachable!(),
                }
                job.speed = 0.0;
                q.dirty.insert(task.id);
            }
        }
        if !q.jobs.iter().any(|j| matches!(j.state, JobState::Queued | JobState::Active)) {
            q.made_dirs.clear();
        }
        drop(guard);
        if !removed.is_empty() {
            let _ = self.app.emit("queue:remove", removed);
        }
        self.notify.notify_waiters();
    }

    /// Sends changed jobs and live progress to the UI four times a second.
    async fn ticker(self: Arc<Self>) {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        loop {
            interval.tick().await;
            let (upserts, progress) = {
                let mut guard = self.queue.lock().unwrap();
                let q = &mut *guard;
                let now = Instant::now();
                let mut progress = Vec::new();
                for job in q.jobs.iter_mut().filter(|j| j.state == JobState::Active) {
                    let bytes = job.progress.transferred.load(Ordering::Relaxed);
                    let elapsed = now.duration_since(job.sample.0).as_secs_f64();
                    if elapsed >= 0.75 {
                        let rate = bytes.saturating_sub(job.sample.1) as f64 / elapsed;
                        job.speed = if job.speed == 0.0 { rate } else { job.speed * 0.6 + rate * 0.4 };
                        job.sample = (now, bytes);
                    }
                    progress.push(ProgressView { id: job.id, transferred: bytes, speed: job.speed });
                }
                let upserts: Vec<JobView> = if q.dirty.is_empty() {
                    Vec::new()
                } else {
                    let dirty = std::mem::take(&mut q.dirty);
                    q.jobs.iter().filter(|j| dirty.contains(&j.id)).map(Job::view).collect()
                };
                (upserts, progress)
            };
            if !upserts.is_empty() {
                let _ = self.app.emit("queue:upsert", upserts);
            }
            if !progress.is_empty() {
                let _ = self.app.emit("queue:progress", progress);
            }
        }
    }
}
