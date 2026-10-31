pub mod ftp;
pub mod sftp;
#[cfg(test)]
mod live_tests;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::known_hosts::KnownHosts;
use crate::log::Logger;
use crate::sites::{AuthMethod, Protocol};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const CHUNK: usize = 256 * 1024;

/// One row in a directory listing, local or remote.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    /// Unix seconds.
    pub modified: Option<i64>,
    pub mode: Option<u32>,
    pub owner: Option<String>,
}

/// Everything needed to open a connection, with secrets already resolved.
#[derive(Debug, Clone)]
pub struct ConnectParams {
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub password: Option<String>,
    pub key_path: String,
    pub passphrase: Option<String>,
    pub insecure_tls: bool,
}

impl ConnectParams {
    /// Connections with the same key can be shared by transfer workers.
    pub fn key(&self) -> String {
        format!("{}://{}@{}:{}", self.protocol.label(), self.user, self.host, self.port)
    }
}

#[derive(Clone)]
pub struct Ctx {
    pub known_hosts: Arc<KnownHosts>,
    pub log: Logger,
}

/// Bytes moved so far and a flag to stop the transfer.
#[derive(Clone, Default)]
pub struct Progress {
    pub transferred: Arc<AtomicU64>,
    pub cancel: Arc<AtomicBool>,
}

pub enum Conn {
    Ftp(ftp::FtpConn),
    Sftp(sftp::SftpConn),
}

impl Conn {
    pub async fn connect(p: &ConnectParams, ctx: &Ctx) -> AppResult<Conn> {
        match p.protocol {
            Protocol::Sftp => Ok(Conn::Sftp(sftp::connect(p, ctx).await?)),
            _ => Ok(Conn::Ftp(ftp::connect(p, ctx).await?)),
        }
    }

    pub async fn home(&mut self) -> AppResult<String> {
        match self {
            Conn::Ftp(c) => c.home().await,
            Conn::Sftp(c) => c.home().await,
        }
    }

    pub async fn list(&mut self, path: &str) -> AppResult<Vec<Entry>> {
        match self {
            Conn::Ftp(c) => c.list(path).await,
            Conn::Sftp(c) => c.list(path).await,
        }
    }

    pub async fn mkdir(&mut self, path: &str) -> AppResult<()> {
        match self {
            Conn::Ftp(c) => c.mkdir(path).await,
            Conn::Sftp(c) => c.mkdir(path).await,
        }
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        match self {
            Conn::Ftp(c) => c.rename(from, to).await,
            Conn::Sftp(c) => c.rename(from, to).await,
        }
    }

    pub async fn remove_file(&mut self, path: &str) -> AppResult<()> {
        match self {
            Conn::Ftp(c) => c.remove_file(path).await,
            Conn::Sftp(c) => c.remove_file(path).await,
        }
    }

    pub async fn remove_dir(&mut self, path: &str) -> AppResult<()> {
        match self {
            Conn::Ftp(c) => c.remove_dir(path).await,
            Conn::Sftp(c) => c.remove_dir(path).await,
        }
    }

    pub async fn chmod(&mut self, path: &str, mode: u32) -> AppResult<()> {
        match self {
            Conn::Ftp(c) => c.chmod(path, mode).await,
            Conn::Sftp(c) => c.chmod(path, mode).await,
        }
    }

    /// Size of a remote file, or None when it does not exist.
    pub async fn file_size(&mut self, path: &str) -> AppResult<Option<u64>> {
        match self {
            Conn::Ftp(c) => c.file_size(path).await,
            Conn::Sftp(c) => c.file_size(path).await,
        }
    }

    pub async fn download(&mut self, remote: &str, local: &Path, progress: &Progress) -> AppResult<()> {
        // Write to a temporary file next to the target so a failed or cancelled
        // download never leaves a half-written file under the real name.
        let file_name = local.file_name().and_then(|n| n.to_str()).unwrap_or("download");
        let part = local.with_file_name(format!(".{file_name}.dispatch-part"));
        let mut file = tokio::fs::File::create(&part).await?;
        let result = match self {
            Conn::Ftp(c) => c.download(remote, &mut file, progress).await,
            Conn::Sftp(c) => c.download(remote, &mut file, progress).await,
        };
        drop(file);
        match result {
            Ok(()) => {
                tokio::fs::rename(&part, local).await?;
                Ok(())
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                Err(e)
            }
        }
    }

    pub async fn upload(&mut self, local: &Path, remote: &str, progress: &Progress) -> AppResult<()> {
        let mut file = tokio::fs::File::open(local).await?;
        match self {
            Conn::Ftp(c) => c.upload(&mut file, remote, progress).await,
            Conn::Sftp(c) => c.upload(&mut file, remote, progress).await,
        }
    }

    /// Deletes a file, or a directory with everything in it. Symlinks are
    /// removed as links and never followed.
    pub async fn remove_tree(&mut self, path: &str, is_dir: bool) -> AppResult<()> {
        if !is_dir {
            return self.remove_file(path).await;
        }
        let mut pending = vec![path.to_string()];
        let mut dirs = Vec::new();
        while let Some(dir) = pending.pop() {
            for entry in self.list(&dir).await? {
                let child = join(&dir, &entry.name);
                if entry.is_dir && !entry.is_link {
                    pending.push(child);
                } else {
                    self.remove_file(&child).await?;
                }
            }
            dirs.push(dir);
        }
        for dir in dirs.iter().rev() {
            self.remove_dir(dir).await?;
        }
        Ok(())
    }

    pub async fn close(self) {
        match self {
            Conn::Ftp(c) => c.close().await,
            Conn::Sftp(c) => c.close().await,
        }
    }
}

/// Which side of a copy talks to the server, so I/O errors there are treated
/// as a broken connection.
#[derive(Clone, Copy, PartialEq)]
pub enum RemoteSide {
    Reader,
    Writer,
}

pub async fn pump<R, W>(reader: &mut R, writer: &mut W, progress: &Progress, remote: RemoteSide) -> AppResult<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let map_err = |side: RemoteSide, e: std::io::Error| {
        if side == remote { AppError::connection(e.to_string()) } else { AppError::other(e.to_string()) }
    };
    let mut buf = vec![0u8; CHUNK];
    loop {
        if progress.cancel.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let n = match tokio::time::timeout(READ_TIMEOUT, reader.read(&mut buf)).await {
            Ok(r) => r.map_err(|e| map_err(RemoteSide::Reader, e))?,
            Err(_) => return Err(AppError::connection("Transfer stalled: no data for 60 seconds")),
        };
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).await.map_err(|e| map_err(RemoteSide::Writer, e))?;
        progress.transferred.fetch_add(n as u64, Ordering::Relaxed);
    }
    writer.flush().await.map_err(|e| map_err(RemoteSide::Writer, e))?;
    Ok(())
}

/// Joins a remote directory and a name with "/".
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

/// Parent of a remote path. "/a/b" -> "/a", "/a" -> "/".
pub fn parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => trimmed[..i].to_string(),
        None => ".".to_string(),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/a", "b"), "/a/b");
        assert_eq!(parent("/a/b"), "/a");
        assert_eq!(parent("/a"), "/");
        assert_eq!(parent("/a/b/"), "/a");
    }
}
