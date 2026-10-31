use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::import::cyberduck::{self, Bookmark};
use crate::import::filezilla;
use crate::import::{ImportReport, ImportedSite};
use crate::local;
use crate::remote::{join, Conn, ConnectParams, Ctx, Entry};
use crate::sites::{secret_delete, secret_get, secret_set, AuthMethod, Protocol, Secret, Site, SiteStore};
use crate::transfer::{ConflictPolicy, JobKind, JobState, JobView, NewJob, Target, TransferManager};

pub struct AppState {
    pub sites: SiteStore,
    pub ctx: Ctx,
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub transfers: Arc<TransferManager>,
    /// Stops the connection attempt in progress. The number tells attempts apart,
    /// so a finished attempt does not clear the slot of a newer one.
    pub connect_cancel: Mutex<Option<(u64, tokio::sync::oneshot::Sender<()>)>>,
    pub connect_seq: std::sync::atomic::AtomicU64,
}

/// A connected server shown in the remote pane. Browsing uses `conn`;
/// transfers open their own connections from `target`.
pub struct Session {
    pub info: SessionInfo,
    pub target: Arc<Target>,
    pub conn: tokio::sync::Mutex<Option<Conn>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub site_id: Option<String>,
    pub label: String,
    pub protocol: Protocol,
    pub host: String,
    pub user: String,
    pub home: String,
    pub start_dir: String,
    pub local_dir: String,
    pub conn_key: String,
}

impl AppState {
    fn session(&self, id: &str) -> AppResult<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("no_session", "Not connected"))
    }
}

/// Runs an operation on a session's browsing connection. Reconnects and
/// retries once when the connection turns out to be closed, which happens
/// when a server drops an idle FTP or SSH connection.
macro_rules! with_conn {
    ($state:expr, $session:expr, $timeout:expr, |$c:ident| $body:expr) => {{
        let session = $session;
        let mut guard = session.conn.lock().await;
        let mut attempt = 0;
        loop {
            if guard.is_none() {
                $state.ctx.log.info(format!("Reconnecting to {}", session.info.label));
                *guard = Some(Conn::connect(&session.target.params, &$state.ctx).await?);
            }
            let $c = guard.as_mut().expect("connected above");
            let result = match tokio::time::timeout($timeout, $body).await {
                Ok(r) => r,
                Err(_) => Err(AppError::connection("Timed out waiting for the server")),
            };
            match result {
                Err(e) if e.is_connection() => {
                    *guard = None;
                    if attempt == 0 {
                        attempt += 1;
                        continue;
                    }
                    break Err(e);
                }
                other => break other,
            }
        }
    }};
}

const OP_TIMEOUT: Duration = Duration::from_secs(60);
const LONG_TIMEOUT: Duration = Duration::from_secs(30 * 60);

// ---- Sites ----

#[tauri::command]
pub fn list_sites(state: State<AppState>) -> Vec<Site> {
    state.sites.list()
}

/// Saves a site. `password`/`passphrase`: None keeps the stored secret,
/// an empty string removes it, anything else replaces it. The passphrase is
/// stored for the key file, so other sites with the same key get it too.
#[tauri::command]
pub fn save_site(
    state: State<AppState>,
    site: Site,
    password: Option<String>,
    passphrase: Option<String>,
) -> AppResult<Site> {
    let mut site = state.sites.upsert(site)?;
    if let Some(value) = password {
        if value.is_empty() {
            secret_delete(Secret::SitePassword(&site.id));
        } else {
            secret_set(Secret::SitePassword(&site.id), &value)?;
        }
        site.password_saved = !value.is_empty();
        site = state.sites.upsert(site)?;
    }
    if let Some(value) = passphrase.filter(|_| !site.key_path.is_empty()) {
        if value.is_empty() {
            secret_delete(Secret::KeyPassphrase(&site.key_path));
        } else {
            secret_set(Secret::KeyPassphrase(&site.key_path), &value)?;
        }
        state.sites.set_passphrase_saved(&site.key_path, !value.is_empty())?;
        site = state.sites.get(&site.id).unwrap_or(site);
    }
    Ok(site)
}

#[tauri::command]
pub fn delete_site(state: State<AppState>, id: String) -> AppResult<()> {
    secret_delete(Secret::SitePassword(&id));
    state.sites.remove(&id)
}

#[tauri::command]
pub fn filezilla_path() -> Option<String> {
    filezilla::default_path().map(|p| p.to_string_lossy().into_owned())
}

/// Adds imported sites, skipping ones that are already saved, and saves readable
/// passwords in the Keychain.
fn add_imported(
    state: &AppState,
    source: &'static str,
    path: String,
    found: Vec<ImportedSite>,
    unsupported: Vec<String>,
) -> AppResult<ImportReport> {
    let existing = state.sites.list();
    let mut report = ImportReport {
        source,
        path,
        found: found.len() + unsupported.len(),
        unsupported,
        ..Default::default()
    };
    let mut new_sites: Vec<Site> = Vec::new();
    for item in found {
        if existing.iter().chain(new_sites.iter()).any(|s| s.same_target(&item.site)) {
            report.already_present += 1;
            continue;
        }
        let mut site = item.site;
        site.id = uuid::Uuid::new_v4().to_string();
        if let Some(password) = item.password {
            site.password_saved = secret_set(Secret::SitePassword(&site.id), &password).is_ok();
        }
        if item.needs_password {
            report.need_password.push(site.name.clone());
        }
        new_sites.push(site);
    }
    report.imported = new_sites.len();
    state.sites.add_many(new_sites)?;
    state.ctx.log.info(format!("Imported {} sites from {source} ({})", report.imported, report.path));
    Ok(report)
}

#[tauri::command]
pub async fn import_filezilla(state: State<'_, AppState>, path: Option<String>) -> AppResult<ImportReport> {
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => filezilla::default_path()
            .ok_or_else(|| AppError::new("not_found", "FileZilla's Site Manager file was not found on this Mac"))?,
    };
    let xml = std::fs::read_to_string(&path).map_err(|e| AppError::other(format!("{}: {e}", path.display())))?;
    let (found, unsupported) = filezilla::parse(&xml)?;
    add_imported(&state, "FileZilla", path.to_string_lossy().into_owned(), found, unsupported)
}

/// Imports Cyberduck bookmarks from its bookmark folders, or from the given
/// .duck files and folders (bookmarks dragged out of Cyberduck).
#[tauri::command]
pub async fn import_cyberduck(state: State<'_, AppState>, paths: Option<Vec<String>>) -> AppResult<ImportReport> {
    let sources: Vec<PathBuf> = match paths {
        Some(paths) => paths.into_iter().map(PathBuf::from).collect(),
        None => cyberduck::default_dirs(),
    };
    let files = cyberduck::bookmark_files(&sources);
    if files.is_empty() {
        return Err(AppError::new("not_found", "No Cyberduck bookmarks were found on this Mac"));
    }
    let mut found = Vec::new();
    let mut unsupported = Vec::new();
    for file in &files {
        let parsed = std::fs::read(file).map_err(AppError::from).and_then(|bytes| cyberduck::parse(&bytes));
        match parsed {
            Ok(Bookmark::Site(item)) => found.push(item),
            Ok(Bookmark::Unsupported(name)) => unsupported.push(name),
            Err(e) => state.ctx.log.warn(format!("Skipped {}: {}", file.display(), e.message)),
        }
    }
    let path = sources.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
    add_imported(&state, "Cyberduck", path, found, unsupported)
}

// ---- Connections ----

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    site: Site,
    password: Option<String>,
    passphrase: Option<String>,
    remember: bool,
) -> AppResult<SessionInfo> {
    let stored = (!site.id.is_empty()).then(|| state.sites.get(&site.id)).flatten();
    let provided_password = password.is_some();
    let provided_passphrase = passphrase.is_some();
    let password = password.or_else(|| match &stored {
        Some(s) if s.password_saved && site.auth == AuthMethod::Password => secret_get(Secret::SitePassword(&s.id)),
        _ => None,
    });
    let passphrase = passphrase.or_else(|| {
        (site.auth == AuthMethod::Key && !site.key_path.is_empty())
            .then(|| secret_get(Secret::KeyPassphrase(&site.key_path)))
            .flatten()
    });

    let port = if site.port == 0 { site.protocol.default_port() } else { site.port };
    let params = Arc::new(ConnectParams {
        protocol: site.protocol,
        host: site.host.trim().to_string(),
        port,
        user: site.user.trim().to_string(),
        auth: site.auth,
        password,
        key_path: site.key_path.clone(),
        passphrase,
        insecure_tls: site.insecure_tls,
    });
    let label = if site.name.trim().is_empty() { params.host.clone() } else { site.name.clone() };
    state.ctx.log.info(format!("Connecting to {label} ({}://{}:{})", site.protocol.label(), params.host, port));

    // Starting a new attempt drops the previous sender, which cancels that attempt too.
    let attempt = state.connect_seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    *state.connect_cancel.lock().unwrap() = Some((attempt, cancel_tx));
    let connecting = async {
        let mut conn = Conn::connect(&params, &state.ctx).await?;
        let home = conn.home().await.unwrap_or_else(|_| "/".into());
        Ok::<_, AppError>((conn, home))
    };
    let result = tokio::select! {
        result = connecting => result,
        _ = cancel_rx => Err(AppError::cancelled()),
    };
    {
        let mut slot = state.connect_cancel.lock().unwrap();
        if slot.as_ref().is_some_and(|(id, _)| *id == attempt) {
            *slot = None;
        }
    }
    let (conn, home) = match result {
        Ok(ok) => ok,
        Err(e) if e.code == "cancelled" => {
            state.ctx.log.info(format!("Stopped connecting to {label}"));
            return Err(e);
        }
        Err(e) => {
            state.ctx.log.error(format!("{label}: {}", e.message));
            return Err(e);
        }
    };
    state.ctx.log.info(format!("Connected to {label}"));

    if remember {
        if let (Some(s), Some(pw)) = (&stored, &params.password) {
            if provided_password && site.auth == AuthMethod::Password {
                secret_set(Secret::SitePassword(&s.id), pw)?;
                state.sites.update(&s.id, |s| s.password_saved = true)?;
            }
        }
        if let Some(pp) = &params.passphrase {
            if provided_passphrase && site.auth == AuthMethod::Key {
                secret_set(Secret::KeyPassphrase(&site.key_path), pp)?;
                state.sites.set_passphrase_saved(&site.key_path, true)?;
            }
        }
    }

    let info = SessionInfo {
        id: uuid::Uuid::new_v4().to_string(),
        site_id: stored.map(|s| s.id),
        label: label.clone(),
        protocol: site.protocol,
        host: params.host.clone(),
        user: params.user.clone(),
        start_dir: if site.remote_dir.trim().is_empty() { home.clone() } else { site.remote_dir.trim().to_string() },
        home,
        local_dir: site.local_dir.clone(),
        conn_key: params.key(),
    };
    let session = Session {
        info: info.clone(),
        target: Arc::new(Target { params, label }),
        conn: tokio::sync::Mutex::new(Some(conn)),
    };
    state.sessions.lock().unwrap().insert(info.id.clone(), Arc::new(session));
    Ok(info)
}

#[tauri::command]
pub fn cancel_connect(state: State<AppState>) {
    if let Some((_, cancel)) = state.connect_cancel.lock().unwrap().take() {
        let _ = cancel.send(());
    }
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let session = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(session) = session {
        if let Some(conn) = session.conn.lock().await.take() {
            conn.close().await;
        }
        state.ctx.log.info(format!("Disconnected from {}", session.info.label));
    }
    Ok(())
}

#[tauri::command]
pub fn trust_host_key(state: State<AppState>, host_port: String, fingerprint: String) {
    state.ctx.known_hosts.trust(&host_port, &fingerprint);
    state.ctx.log.info(format!("Trusted new host key for {host_port}: {fingerprint}"));
}

// ---- Remote files ----

#[tauri::command]
pub async fn remote_list(state: State<'_, AppState>, session_id: String, path: String) -> AppResult<Vec<Entry>> {
    let session = state.session(&session_id)?;
    with_conn!(state, session, OP_TIMEOUT, |c| c.list(&path))
}

#[tauri::command]
pub async fn remote_mkdir(state: State<'_, AppState>, session_id: String, path: String) -> AppResult<()> {
    let session = state.session(&session_id)?;
    with_conn!(state, session, OP_TIMEOUT, |c| c.mkdir(&path))
}

#[tauri::command]
pub async fn remote_rename(state: State<'_, AppState>, session_id: String, from: String, to: String) -> AppResult<()> {
    let session = state.session(&session_id)?;
    with_conn!(state, session, OP_TIMEOUT, |c| c.rename(&from, &to))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    #[serde(default)]
    pub is_link: bool,
    #[serde(default)]
    pub size: u64,
}

#[tauri::command]
pub async fn remote_delete(state: State<'_, AppState>, session_id: String, items: Vec<RemoteItem>) -> AppResult<()> {
    let session = state.session(&session_id)?;
    for item in items {
        let is_dir = item.is_dir && !item.is_link;
        with_conn!(state, session.clone(), LONG_TIMEOUT, |c| c.remove_tree(&item.path, is_dir))?;
        state.ctx.log.info(format!("Deleted {}", item.path));
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_chmod(state: State<'_, AppState>, session_id: String, paths: Vec<String>, mode: u32) -> AppResult<()> {
    let session = state.session(&session_id)?;
    for path in paths {
        with_conn!(state, session.clone(), OP_TIMEOUT, |c| c.chmod(&path, mode))?;
    }
    Ok(())
}

// ---- Local files ----

fn join_error(e: tokio::task::JoinError) -> AppError {
    AppError::other(e.to_string())
}

#[tauri::command]
pub fn local_home() -> String {
    local::home()
}

#[tauri::command]
pub async fn local_list(path: String) -> AppResult<Vec<Entry>> {
    tokio::task::spawn_blocking(move || local::list(&path)).await.map_err(join_error)?
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> AppResult<()> {
    local::mkdir(&path)
}

#[tauri::command]
pub async fn local_rename(from: String, to: String) -> AppResult<()> {
    local::rename(&from, &to)
}

#[tauri::command]
pub async fn local_trash(paths: Vec<String>) -> AppResult<()> {
    tokio::task::spawn_blocking(move || local::trash(&paths)).await.map_err(join_error)?
}

// ---- Transfers ----

#[tauri::command]
pub async fn enqueue_upload(
    state: State<'_, AppState>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> AppResult<usize> {
    let target = state.session(&session_id)?.target.clone();
    let items = tokio::task::spawn_blocking(move || {
        let mut all = Vec::new();
        for path in local_paths {
            all.extend(local::walk(&local::expand(&path))?);
        }
        Ok::<_, AppError>(all)
    })
    .await
    .map_err(join_error)??;
    let jobs: Vec<NewJob> = items
        .into_iter()
        .map(|item| NewJob {
            kind: if item.is_dir { JobKind::MkdirRemote } else { JobKind::Upload },
            remote: join(&remote_dir, &item.relative),
            local: item.path,
            base: remote_dir.clone(),
            size: item.size,
            depth: 0,
        })
        .collect();
    let count = jobs.len();
    state.transfers.enqueue(target, jobs);
    Ok(count)
}

#[tauri::command]
pub async fn enqueue_download(
    state: State<'_, AppState>,
    session_id: String,
    items: Vec<RemoteItem>,
    local_dir: String,
) -> AppResult<usize> {
    let target = state.session(&session_id)?.target.clone();
    let local_dir = local::expand(&local_dir);
    let jobs: Vec<NewJob> = items
        .into_iter()
        .map(|item| NewJob {
            kind: if item.is_dir { JobKind::ListRemote } else { JobKind::Download },
            local: local_dir.join(&item.name),
            remote: item.path,
            base: String::new(),
            size: item.size,
            depth: 0,
        })
        .collect();
    let count = jobs.len();
    state.transfers.enqueue(target, jobs);
    Ok(count)
}

#[derive(Serialize)]
pub struct QueueSnapshot {
    jobs: Vec<JobView>,
    policy: ConflictPolicy,
}

#[tauri::command]
pub fn queue_snapshot(state: State<AppState>) -> QueueSnapshot {
    let (jobs, policy) = state.transfers.snapshot();
    QueueSnapshot { jobs, policy }
}

#[tauri::command]
pub fn queue_cancel(state: State<AppState>, ids: Option<Vec<u64>>) {
    state.transfers.cancel(ids);
}

#[tauri::command]
pub fn queue_retry(state: State<AppState>, ids: Vec<u64>) {
    state.transfers.retry(ids);
}

#[tauri::command]
pub fn queue_clear(state: State<AppState>, states: Vec<JobState>) {
    state.transfers.clear(states);
}

#[tauri::command]
pub fn queue_resolve(state: State<AppState>, ids: Vec<u64>, overwrite: bool, apply_to_all: bool) {
    state.transfers.resolve(ids, overwrite, apply_to_all);
}

#[tauri::command]
pub fn queue_set_policy(state: State<AppState>, policy: ConflictPolicy) {
    state.transfers.set_policy(policy);
}
