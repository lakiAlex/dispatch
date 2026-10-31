use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::AgentClient;
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::Disconnect;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, StatusCode};
use tokio::io::AsyncWriteExt;

use super::{join, pump, ConnectParams, Ctx, Entry, Progress, RemoteSide, CONNECT_TIMEOUT};
use crate::error::{AppError, AppResult};
use crate::known_hosts::HostCheck;
use crate::sites::AuthMethod;

pub struct SftpConn {
    handle: Handle<Client>,
    sftp: SftpSession,
}

enum HostKeyOutcome {
    Changed { expected: String, actual: String },
}

pub struct Client {
    host_port: String,
    ctx: Ctx,
    outcome: Arc<Mutex<Option<HostKeyOutcome>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key_data = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data().clone(),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key().clone(),
        };
        let fingerprint = format!("{} {}", key_data.algorithm(), key_data.fingerprint(HashAlg::Sha256));
        match self.ctx.known_hosts.check_and_learn(&self.host_port, &fingerprint) {
            HostCheck::Known => Ok(true),
            HostCheck::New => {
                self.ctx.log.info(format!("Trusted new host key for {}: {fingerprint}", self.host_port));
                Ok(true)
            }
            HostCheck::Changed { expected } => {
                *self.outcome.lock().unwrap() = Some(HostKeyOutcome::Changed { expected, actual: fingerprint });
                Ok(false)
            }
        }
    }
}

fn expand_tilde(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}

fn load_key(path: &str, passphrase: Option<&str>) -> AppResult<keys::PrivateKey> {
    let path = expand_tilde(path);
    if !path.exists() {
        return Err(AppError::other(format!("Key file not found: {}", path.display())));
    }
    keys::load_secret_key(&path, passphrase).map_err(|e| {
        let encrypted = matches!(e, keys::Error::KeyIsEncrypted) || e.to_string().contains("encrypted");
        match (encrypted, passphrase) {
            (true, None) => AppError::new("need_passphrase", "This key is protected by a passphrase"),
            (_, Some(_)) => AppError::new("need_passphrase", format!("Could not unlock the key: {e}")),
            (false, None) => AppError::other(format!("Could not read key {}: {e}", path.display())),
        }
    })
}

async fn auth_password(handle: &mut Handle<Client>, user: &str, password: &str) -> AppResult<bool> {
    if handle.authenticate_password(user, password).await?.success() {
        return Ok(true);
    }
    // Some servers only allow keyboard-interactive. Answer every prompt with the password.
    let mut response = handle.authenticate_keyboard_interactive_start(user, None::<String>).await?;
    for _ in 0..5 {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                response = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Ok(false)
}

async fn auth_agent(handle: &mut Handle<Client>, user: &str) -> AppResult<bool> {
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| AppError::new("auth", format!("ssh-agent is not available: {e}")))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::new("auth", format!("ssh-agent: {e}")))?;
    for identity in identities {
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        let result = handle
            .authenticate_publickey_with(user, identity.public_key().into_owned(), hash, &mut agent)
            .await;
        if matches!(result, Ok(r) if r.success()) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub async fn connect(p: &ConnectParams, ctx: &Ctx) -> AppResult<SftpConn> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let host_port = format!("{}:{}", p.host, p.port);
    let outcome = Arc::new(Mutex::new(None));
    let handler = Client {
        host_port: host_port.clone(),
        ctx: ctx.clone(),
        outcome: outcome.clone(),
    };

    let connecting = client::connect(config, (p.host.as_str(), p.port), handler);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
        Err(_) => return Err(AppError::connection(format!("Timed out connecting to {host_port}"))),
        Ok(Err(e)) => {
            if let Some(HostKeyOutcome::Changed { expected, actual }) = outcome.lock().unwrap().take() {
                return Err(AppError::new(
                    "hostkey_changed",
                    format!("The host key for {host_port} has changed. Expected {expected}, got {actual}."),
                )
                .with_data(serde_json::json!({ "hostPort": host_port, "expected": expected, "actual": actual })));
            }
            return Err(AppError::connection(e.to_string()));
        }
        Ok(Ok(handle)) => handle,
    };

    let ok = match p.auth {
        AuthMethod::Key => {
            let key = load_key(&p.key_path, p.passphrase.as_deref())?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(p.user.as_str(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
                .success()
        }
        AuthMethod::Agent => auth_agent(&mut handle, &p.user).await?,
        AuthMethod::Anonymous => handle.authenticate_none(p.user.as_str()).await?.success(),
        AuthMethod::Password | AuthMethod::Ask => {
            let password = p.password.as_deref().ok_or_else(|| AppError::new("need_password", "Password required"))?;
            auth_password(&mut handle, &p.user, password).await?
        }
    };
    if !ok {
        return Err(AppError::new("auth", format!("Authentication failed for {}@{}", p.user, p.host)));
    }

    let channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;
    sftp.set_timeout(60);
    Ok(SftpConn { handle, sftp })
}

impl SftpConn {
    pub async fn home(&mut self) -> AppResult<String> {
        Ok(self.sftp.canonicalize(".").await?)
    }

    pub async fn list(&mut self, path: &str) -> AppResult<Vec<Entry>> {
        let mut entries = Vec::new();
        for item in self.sftp.read_dir(path).await? {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = item.metadata();
            let is_link = meta.is_symlink();
            // A link to a directory should open like a directory.
            let is_dir = if is_link {
                self.sftp.metadata(join(path, &name)).await.map(|m| m.is_dir()).unwrap_or(false)
            } else {
                meta.is_dir()
            };
            entries.push(Entry {
                name,
                is_dir,
                is_link,
                size: meta.size.unwrap_or(0),
                modified: meta.mtime.map(i64::from),
                mode: meta.permissions.map(|p| p & 0o7777),
                owner: meta.user.clone(),
            });
        }
        Ok(entries)
    }

    pub async fn mkdir(&mut self, path: &str) -> AppResult<()> {
        Ok(self.sftp.create_dir(path).await?)
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        Ok(self.sftp.rename(from, to).await?)
    }

    pub async fn remove_file(&mut self, path: &str) -> AppResult<()> {
        Ok(self.sftp.remove_file(path).await?)
    }

    pub async fn remove_dir(&mut self, path: &str) -> AppResult<()> {
        Ok(self.sftp.remove_dir(path).await?)
    }

    pub async fn chmod(&mut self, path: &str, mode: u32) -> AppResult<()> {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode & 0o7777);
        Ok(self.sftp.set_metadata(path, attrs).await?)
    }

    pub async fn file_size(&mut self, path: &str) -> AppResult<Option<u64>> {
        match self.sftp.metadata(path).await {
            Ok(meta) => Ok(Some(meta.size.unwrap_or(0))),
            Err(russh_sftp::client::error::Error::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn download(&mut self, remote: &str, file: &mut tokio::fs::File, progress: &Progress) -> AppResult<()> {
        let mut source = self.sftp.open(remote).await?;
        pump(&mut source, file, progress, RemoteSide::Reader).await?;
        let _ = source.shutdown().await;
        Ok(())
    }

    pub async fn upload(&mut self, file: &mut tokio::fs::File, remote: &str, progress: &Progress) -> AppResult<()> {
        let mut target = self.sftp.create(remote).await?;
        pump(file, &mut target, progress, RemoteSide::Writer).await?;
        target.shutdown().await.map_err(|e| AppError::connection(e.to_string()))?;
        Ok(())
    }

    pub async fn close(self) {
        let _ = self.sftp.close().await;
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "en").await;
    }
}
