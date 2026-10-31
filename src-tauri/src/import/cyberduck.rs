//! Import of Cyberduck bookmarks. Cyberduck keeps each bookmark as a .duck file,
//! an XML property list. Passwords are not in the file but in the Keychain.

use std::path::PathBuf;

use plist::{Dictionary, Value};

use super::ImportedSite;
use crate::error::{AppError, AppResult};
use crate::sites::{AuthMethod, Protocol, Site};

pub enum Bookmark {
    Site(ImportedSite),
    /// A protocol Dispatch does not support, such as S3 or WebDAV. Holds the bookmark name.
    Unsupported(String),
}

/// Cyberduck's bookmark folders on this machine: the one current versions use,
/// and the one older versions used.
pub fn default_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    [
        "Library/Group Containers/G69SCX94XU.duck/Library/Application Support/duck/Bookmarks",
        "Library/Application Support/Cyberduck/Bookmarks",
    ]
    .iter()
    .map(|dir| home.join(dir))
    .filter(|dir| dir.is_dir())
    .collect()
}

/// The .duck files in the given files and folders.
pub fn bookmark_files(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for path in paths {
        if path.is_dir() {
            let Ok(read) = std::fs::read_dir(path) else { continue };
            let mut found: Vec<PathBuf> = read
                .filter_map(|entry| entry.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|ext| ext == "duck"))
                .collect();
            found.sort();
            files.extend(found);
        } else if path.is_file() {
            files.push(path.clone());
        }
    }
    files
}

fn text(dict: &Dictionary, key: &str) -> String {
    dict.get(key).and_then(Value::as_string).unwrap_or("").trim().to_string()
}

/// A path stored either as a string or, in newer versions, as a dictionary with a "Path" entry.
fn path_value(dict: &Dictionary, key: &str) -> String {
    let direct = text(dict, key);
    if !direct.is_empty() {
        return direct;
    }
    dict.get(&format!("{key} Dictionary"))
        .and_then(Value::as_dictionary)
        .map(|d| text(d, "Path"))
        .unwrap_or_default()
}

pub fn parse(bytes: &[u8]) -> AppResult<Bookmark> {
    let value = Value::from_reader(std::io::Cursor::new(bytes))
        .map_err(|e| AppError::other(format!("Not a Cyberduck bookmark: {e}")))?;
    let dict = value.as_dictionary().ok_or_else(|| AppError::other("Not a Cyberduck bookmark"))?;

    let host = text(dict, "Hostname");
    let nickname = text(dict, "Nickname");
    let name = if nickname.is_empty() { host.clone() } else { nickname };
    // Cyberduck's "ftp" is plain FTP. Dispatch's FTP uses TLS when the server
    // supports it and falls back to plain FTP, so the import keeps working.
    let protocol = match text(dict, "Protocol").as_str() {
        "sftp" => Protocol::Sftp,
        "ftp" => Protocol::Ftp,
        "ftps" => Protocol::Ftpes,
        _ => return Ok(Bookmark::Unsupported(name)),
    };
    let port = match dict.get("Port") {
        Some(Value::Integer(n)) => n.as_unsigned().and_then(|n| u16::try_from(n).ok()),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
    .unwrap_or(protocol.default_port());

    let user = text(dict, "Username");
    let key_path = path_value(dict, "Private Key File");
    let auth = if protocol == Protocol::Sftp && !key_path.is_empty() {
        AuthMethod::Key
    } else if user.eq_ignore_ascii_case("anonymous") {
        AuthMethod::Anonymous
    } else {
        AuthMethod::Password
    };
    let folder = dict
        .get("Labels")
        .and_then(Value::as_array)
        .and_then(|labels| labels.iter().find_map(Value::as_string))
        .unwrap_or("")
        .to_string();

    let site = Site {
        name,
        folder,
        protocol,
        host,
        port,
        user,
        auth,
        key_path: if auth == AuthMethod::Key { key_path } else { String::new() },
        remote_dir: text(dict, "Path"),
        local_dir: path_value(dict, "Download Folder"),
        notes: text(dict, "Notes"),
        ..Default::default()
    };
    Ok(Bookmark::Site(ImportedSite { site, password: None, needs_password: auth == AuthMethod::Password }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bookmark(entries: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>{entries}</dict></plist>"#
        )
        .into_bytes()
    }

    #[test]
    fn sftp_with_key_and_label() {
        let bytes = bookmark(
            "<key>Protocol</key><string>sftp</string><key>Nickname</key><string>Shop</string>\
             <key>Hostname</key><string>shop.example</string><key>Port</key><string>2233</string>\
             <key>Username</key><string>deploy</string><key>Path</key><string>/var/www</string>\
             <key>Private Key File</key><string>~/.ssh/id_ed25519</string>\
             <key>Labels</key><array><string>Clients</string></array>",
        );
        let Bookmark::Site(item) = parse(&bytes).unwrap() else { panic!("expected a site") };
        assert_eq!(item.site.name, "Shop");
        assert_eq!(item.site.protocol, Protocol::Sftp);
        assert_eq!(item.site.port, 2233);
        assert_eq!(item.site.auth, AuthMethod::Key);
        assert_eq!(item.site.key_path, "~/.ssh/id_ed25519");
        assert_eq!(item.site.remote_dir, "/var/www");
        assert_eq!(item.site.folder, "Clients");
        assert!(!item.needs_password);
    }

    #[test]
    fn ftp_with_password_and_integer_port() {
        let bytes = bookmark(
            "<key>Protocol</key><string>ftp</string><key>Hostname</key><string>ftp.example</string>\
             <key>Port</key><integer>21</integer><key>Username</key><string>bob</string>",
        );
        let Bookmark::Site(item) = parse(&bytes).unwrap() else { panic!("expected a site") };
        assert_eq!(item.site.name, "ftp.example");
        assert_eq!(item.site.protocol, Protocol::Ftp);
        assert_eq!(item.site.port, 21);
        assert_eq!(item.site.auth, AuthMethod::Password);
        assert!(item.needs_password);
    }

    #[test]
    fn unsupported_protocol() {
        let bytes = bookmark("<key>Protocol</key><string>s3</string><key>Nickname</key><string>Bucket</string>");
        assert!(matches!(parse(&bytes).unwrap(), Bookmark::Unsupported(name) if name == "Bucket"));
    }

    #[test]
    fn key_path_in_dictionary() {
        let bytes = bookmark(
            "<key>Protocol</key><string>sftp</string><key>Hostname</key><string>h.example</string>\
             <key>Private Key File Dictionary</key><dict><key>Path</key><string>/Users/x/.ssh/key</string></dict>",
        );
        let Bookmark::Site(item) = parse(&bytes).unwrap() else { panic!("expected a site") };
        assert_eq!(item.site.key_path, "/Users/x/.ssh/key");
        assert_eq!(item.site.auth, AuthMethod::Key);
    }
}
