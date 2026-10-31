use std::time::UNIX_EPOCH;

use suppaftp::async_native_tls::TlsConnector;
use suppaftp::list::File as ListFile;
use suppaftp::list::PosixPexQuery;
use suppaftp::tokio::{AsyncNativeTlsConnector, AsyncNativeTlsFtpStream};
use suppaftp::types::FileType;
use suppaftp::FtpError;

use super::{pump, ConnectParams, Ctx, Entry, Progress, RemoteSide, CONNECT_TIMEOUT};
use crate::error::{AppError, AppResult};
use crate::sites::{AuthMethod, Protocol};

pub struct FtpConn {
    stream: AsyncNativeTlsFtpStream,
    mlsd: bool,
}

fn tls_connector(p: &ConnectParams) -> AsyncNativeTlsConnector {
    AsyncNativeTlsConnector::from(
        TlsConnector::new()
            .danger_accept_invalid_certs(p.insecure_tls)
            .danger_accept_invalid_hostnames(p.insecure_tls),
    )
}

async fn open_plain(p: &ConnectParams) -> AppResult<AsyncNativeTlsFtpStream> {
    match tokio::time::timeout(CONNECT_TIMEOUT, AsyncNativeTlsFtpStream::connect((p.host.as_str(), p.port))).await {
        Ok(r) => Ok(r?),
        Err(_) => Err(AppError::connection(format!("Timed out connecting to {}:{}", p.host, p.port))),
    }
}

fn cert_error(e: FtpError) -> AppError {
    let err = AppError::from(e);
    if err.code == "tls" {
        AppError::new("cert", err.message)
    } else {
        err
    }
}

pub async fn connect(p: &ConnectParams, ctx: &Ctx) -> AppResult<FtpConn> {
    let mut stream = match p.protocol {
        Protocol::Ftps => {
            let fut = AsyncNativeTlsFtpStream::connect_secure_implicit((p.host.as_str(), p.port), tls_connector(p), &p.host);
            match tokio::time::timeout(CONNECT_TIMEOUT, fut).await {
                Ok(r) => r.map_err(cert_error)?,
                Err(_) => return Err(AppError::connection(format!("Timed out connecting to {}:{}", p.host, p.port))),
            }
        }
        Protocol::Ftpes => open_plain(p).await?.into_secure(tls_connector(p), &p.host).await.map_err(cert_error)?,
        Protocol::Ftp => match open_plain(p).await?.into_secure(tls_connector(p), &p.host).await {
            Ok(secure) => secure,
            // The server refused AUTH TLS: fall back to plain FTP like FileZilla does.
            Err(FtpError::UnexpectedResponse(_)) => {
                ctx.log.warn(format!("{} does not support TLS, using plain FTP", p.host));
                open_plain(p).await?
            }
            Err(e) => return Err(cert_error(e)),
        },
        Protocol::FtpPlain | Protocol::Sftp => open_plain(p).await?,
    };

    let (user, pass) = match p.auth {
        AuthMethod::Anonymous => ("anonymous".to_string(), "anonymous@".to_string()),
        _ => {
            let pass = p.password.clone().ok_or_else(|| AppError::new("need_password", "Password required"))?;
            (p.user.clone(), pass)
        }
    };
    stream.login(user.as_str(), pass.as_str()).await.map_err(|e| match AppError::from(e) {
        err if err.code == "error" => AppError::new("auth", err.message),
        err => err,
    })?;

    stream.transfer_type(FileType::Binary).await?;
    stream.set_passive_nat_workaround(true);
    let _ = stream.opts("UTF8", Some("ON")).await;
    let mlsd = match stream.feat().await {
        Ok(features) => features.keys().any(|k| k.eq_ignore_ascii_case("MLST")),
        Err(_) => false,
    };
    if mlsd {
        // Ask for the Unix mode and owner too. Servers ignore facts they do not have.
        let _ = stream.opts("MLST", Some("type;size;modify;perm;unix.mode;unix.owner;")).await;
    }
    Ok(FtpConn { stream, mlsd })
}

/// Parses one MLSD line: "type=file;size=12;modify=20240101120000;unix.mode=0644; name".
/// Only the facts Dispatch shows are read; anything unknown or malformed is ignored.
fn parse_mlsd(line: &str) -> Option<Entry> {
    let (facts, name) = line.split_once(' ')?;
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let mut kind = String::new();
    let mut entry = Entry { name: name.to_string(), is_dir: false, is_link: false, size: 0, modified: None, mode: None, owner: None };
    for pair in facts.split(';') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        match key.to_ascii_lowercase().as_str() {
            "type" => kind = value.to_ascii_lowercase(),
            "size" | "sizd" => entry.size = value.parse().unwrap_or(0),
            "modify" => {
                entry.modified = value
                    .get(..14)
                    .and_then(|v| chrono::NaiveDateTime::parse_from_str(v, "%Y%m%d%H%M%S").ok())
                    .map(|t| t.and_utc().timestamp());
            }
            // Some servers write the mode as "0o644".
            "unix.mode" => entry.mode = u32::from_str_radix(value.trim_start_matches("0o"), 8).ok(),
            "unix.owner" | "unix.ownername" => entry.owner = Some(value.to_string()),
            _ => {}
        }
    }
    match kind.as_str() {
        "cdir" | "pdir" => return None,
        "dir" => entry.is_dir = true,
        k if k.starts_with("os.unix=slink") || k.starts_with("os.unix=symlink") => entry.is_link = true,
        _ => {}
    }
    Some(entry)
}

fn entry_from_list(file: &ListFile) -> Entry {
    let mut mode = 0u32;
    for (shift, who) in [(6, PosixPexQuery::Owner), (3, PosixPexQuery::Group), (0, PosixPexQuery::Others)] {
        if file.can_read(who) {
            mode |= 4 << shift;
        }
        if file.can_write(who) {
            mode |= 2 << shift;
        }
        if file.can_execute(who) {
            mode |= 1 << shift;
        }
    }
    let modified = file
        .modified()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
        .filter(|s| *s > 0);
    Entry {
        name: file.name().to_string(),
        is_dir: file.is_directory(),
        is_link: file.is_symlink(),
        size: file.size() as u64,
        modified,
        mode: Some(mode),
        owner: None,
    }
}

impl FtpConn {
    pub async fn home(&mut self) -> AppResult<String> {
        Ok(self.stream.pwd().await?)
    }

    pub async fn list(&mut self, path: &str) -> AppResult<Vec<Entry>> {
        self.stream.cwd(path).await?;
        if self.mlsd {
            return Ok(self.stream.mlsd(None).await?.iter().filter_map(|line| parse_mlsd(line)).collect());
        }
        // "-a" shows dotfiles such as .htaccess on most servers. Servers that do
        // not understand it either fail or return nothing, so retry without it.
        let lines = match self.stream.list(Some("-a")).await {
            Ok(lines) if !lines.is_empty() => lines,
            Ok(_) | Err(FtpError::UnexpectedResponse(_)) => self.stream.list(None).await?,
            Err(e) => return Err(e.into()),
        };
        Ok(lines
            .iter()
            .filter_map(|line| ListFile::try_from(line.as_str()).ok())
            .filter(|f| f.name() != "." && f.name() != "..")
            .map(|f| entry_from_list(&f))
            .collect())
    }

    pub async fn mkdir(&mut self, path: &str) -> AppResult<()> {
        Ok(self.stream.mkdir(path).await?)
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        Ok(self.stream.rename(from, to).await?)
    }

    pub async fn remove_file(&mut self, path: &str) -> AppResult<()> {
        Ok(self.stream.rm(path).await?)
    }

    pub async fn remove_dir(&mut self, path: &str) -> AppResult<()> {
        Ok(self.stream.rmdir(path).await?)
    }

    pub async fn chmod(&mut self, path: &str, mode: u32) -> AppResult<()> {
        self.stream.site(format!("CHMOD {:o} {}", mode & 0o7777, path)).await?;
        Ok(())
    }

    pub async fn file_size(&mut self, path: &str) -> AppResult<Option<u64>> {
        match self.stream.size(path).await {
            Ok(size) => Ok(Some(size as u64)),
            Err(FtpError::UnexpectedResponse(resp)) if resp.status.code() == 550 => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn download(&mut self, remote: &str, file: &mut tokio::fs::File, progress: &Progress) -> AppResult<()> {
        let mut data = self.stream.retr_as_stream(remote).await?;
        pump(&mut data, file, progress, RemoteSide::Reader).await?;
        data.finish().await?;
        Ok(())
    }

    pub async fn upload(&mut self, file: &mut tokio::fs::File, remote: &str, progress: &Progress) -> AppResult<()> {
        let mut data = self.stream.put_with_stream(remote).await?;
        pump(file, &mut data, progress, RemoteSide::Writer).await?;
        data.finish().await?;
        Ok(())
    }

    pub async fn close(mut self) {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), self.stream.quit()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::parse_mlsd;

    #[test]
    fn parses_mlsd_lines() {
        let file = parse_mlsd("type=file;size=12;modify=20240102030405.123;UNIX.mode=0644;unix.owner=www; my file.php").unwrap();
        assert_eq!(file.name, "my file.php");
        assert_eq!(file.size, 12);
        assert_eq!(file.mode, Some(0o644));
        assert_eq!(file.owner.as_deref(), Some("www"));
        assert_eq!(file.modified, Some(1_704_164_645));
        assert!(!file.is_dir);

        let dir = parse_mlsd("type=dir;modify=20240102030405;unix.mode=0o755; uploads").unwrap();
        assert!(dir.is_dir);
        assert_eq!(dir.mode, Some(0o755));

        let link = parse_mlsd("type=OS.unix=slink:/var/www;size=8; current").unwrap();
        assert!(link.is_link);

        assert!(parse_mlsd("type=cdir;modify=20240102030405; /home").is_none());
        assert!(parse_mlsd("type=pdir; ..").is_none());
        assert!(parse_mlsd("garbage-without-space").is_none());
    }
}
