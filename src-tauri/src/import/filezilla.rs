//! Import of FileZilla's Site Manager (sitemanager.xml, or a file exported from it).

use std::path::PathBuf;

use base64::Engine;
use roxmltree::Node;
use super::ImportedSite;
use crate::error::{AppError, AppResult};
use crate::sites::{AuthMethod, Protocol, Site};

/// Where FileZilla keeps its Site Manager on this machine.
pub fn default_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        candidates.push(PathBuf::from(xdg).join("filezilla/sitemanager.xml"));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".config/filezilla/sitemanager.xml"));
        candidates.push(home.join(".filezilla/sitemanager.xml"));
    }
    if let Some(data) = dirs::data_dir() {
        candidates.push(data.join("FileZilla/sitemanager.xml"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn child<'a>(node: Node<'a, 'a>, tag: &str) -> Option<Node<'a, 'a>> {
    node.children().find(|c| c.has_tag_name(tag))
}

fn child_text(node: Node, tag: &str) -> String {
    child(node, tag).and_then(|c| c.text()).unwrap_or("").trim().to_string()
}

/// First text directly inside an element, used for folder names and for the
/// site name in old files where it sits after the child elements.
fn own_text(node: Node) -> String {
    node.children()
        .filter(|c| c.is_text())
        .filter_map(|c| c.text())
        .map(str::trim)
        .find(|t| !t.is_empty())
        .unwrap_or("")
        .to_string()
}

/// Decodes FileZilla's serialized server path, e.g. "1 0 4 home 3 www" -> "/home/www".
/// The format is: type, prefix length, prefix, then each segment as "length text".
fn parse_server_path(raw: &str) -> Option<String> {
    let chars: Vec<char> = raw.trim().chars().collect();
    if chars.is_empty() {
        return None;
    }
    let mut pos = 0;
    let take_number = |pos: &mut usize| -> Option<usize> {
        let start = *pos;
        while *pos < chars.len() && chars[*pos].is_ascii_digit() {
            *pos += 1;
        }
        let n: usize = chars[start..*pos].iter().collect::<String>().parse().ok()?;
        if *pos < chars.len() && chars[*pos] == ' ' {
            *pos += 1;
        }
        Some(n)
    };
    let _kind = take_number(&mut pos)?;
    let prefix_len = take_number(&mut pos)?;
    pos += prefix_len;
    if prefix_len > 0 && pos < chars.len() && chars[pos] == ' ' {
        pos += 1;
    }
    let mut segments = Vec::new();
    while pos < chars.len() {
        let len = take_number(&mut pos)?;
        let end = pos.checked_add(len).filter(|e| *e <= chars.len())?;
        segments.push(chars[pos..end].iter().collect::<String>());
        pos = end;
        if pos < chars.len() && chars[pos] == ' ' {
            pos += 1;
        }
    }
    Some(format!("/{}", segments.join("/")))
}

fn color_name(index: &str) -> String {
    match index {
        "1" => "red",
        "2" => "green",
        "3" => "blue",
        "4" => "yellow",
        "5" => "cyan",
        "6" => "purple",
        "7" => "orange",
        _ => "",
    }
    .to_string()
}

fn parse_server(node: Node, folder: &str, unsupported: &mut Vec<String>) -> Option<ImportedSite> {
    let host = child_text(node, "Host");
    let mut name = child_text(node, "Name");
    if name.is_empty() {
        name = own_text(node);
    }
    if name.is_empty() {
        name = host.clone();
    }

    let protocol = match child_text(node, "Protocol").as_str() {
        "0" | "" => Protocol::Ftp,
        "1" => Protocol::Sftp,
        "3" => Protocol::Ftps,
        "4" => Protocol::Ftpes,
        "6" => Protocol::FtpPlain,
        _ => {
            unsupported.push(name);
            return None;
        }
    };

    let key_path = child_text(node, "Keyfile");
    let auth = match child_text(node, "Logontype").as_str() {
        "0" => AuthMethod::Anonymous,
        "2" | "3" => AuthMethod::Ask,
        "5" if protocol == Protocol::Sftp && !key_path.is_empty() => AuthMethod::Key,
        _ => AuthMethod::Password,
    };

    let (password, password_encrypted) = match child(node, "Pass") {
        Some(pass) if auth == AuthMethod::Password => {
            let value = pass.text().unwrap_or("").trim();
            match pass.attribute("encoding") {
                Some("base64") => {
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(value)
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok());
                    (decoded, false)
                }
                Some("crypt") => (None, true),
                _ => (Some(value.to_string()).filter(|v| !v.is_empty()), false),
            }
        }
        _ => (None, false),
    };

    let port = child_text(node, "Port").parse().unwrap_or(protocol.default_port());
    let site = Site {
        name,
        folder: folder.to_string(),
        protocol,
        host,
        port,
        user: child_text(node, "User"),
        auth,
        key_path: if auth == AuthMethod::Key { key_path } else { String::new() },
        remote_dir: parse_server_path(&child_text(node, "RemoteDir")).unwrap_or_default(),
        local_dir: child_text(node, "LocalDir"),
        color: color_name(&child_text(node, "Colour")),
        notes: child_text(node, "Comments"),
        ..Default::default()
    };
    // A password encrypted with a FileZilla master password cannot be read.
    Some(ImportedSite { site, password, needs_password: password_encrypted })
}

fn walk(node: Node, folder: &str, out: &mut Vec<ImportedSite>, unsupported: &mut Vec<String>) {
    for c in node.children().filter(|c| c.is_element()) {
        if c.has_tag_name("Server") {
            if let Some(site) = parse_server(c, folder, unsupported) {
                out.push(site);
            }
        } else if c.has_tag_name("Folder") {
            let name = own_text(c);
            let path = if folder.is_empty() { name } else { format!("{folder}/{name}") };
            walk(c, &path, out, unsupported);
        }
    }
}

pub fn parse(xml: &str) -> AppResult<(Vec<ImportedSite>, Vec<String>)> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| AppError::other(format!("Not a valid FileZilla file: {e}")))?;
    let servers = doc
        .descendants()
        .find(|n| n.has_tag_name("Servers"))
        .ok_or_else(|| AppError::other("No <Servers> section found. Is this a FileZilla Site Manager file?"))?;
    let mut sites = Vec::new();
    let mut unsupported = Vec::new();
    walk(servers, "", &mut sites, &mut unsupported);
    Ok((sites, unsupported))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_path() {
        assert_eq!(parse_server_path("1 0 4 home 3 www").as_deref(), Some("/home/www"));
        assert_eq!(parse_server_path("1 0 8 my files 2 ab").as_deref(), Some("/my files/ab"));
        assert_eq!(parse_server_path("1 0").as_deref(), Some("/"));
        assert_eq!(parse_server_path(""), None);
    }

    #[test]
    fn parses_sites_and_folders() {
        let xml = r#"<?xml version="1.0"?>
<FileZilla3 version="3.69.6" platform="mac">
  <Servers>
    <Server>
      <Host>example.com</Host><Port>22</Port><Protocol>1</Protocol><Type>0</Type>
      <User>root</User><Logontype>5</Logontype><Keyfile>/Users/x/.ssh/key</Keyfile>
      <Name>Key site</Name><RemoteDir>1 0 3 var 3 www</RemoteDir>
    </Server>
    <Folder expanded="1">Clients
      <Server>
        <Host>ftp.example.com</Host><Port>21</Port><Protocol>0</Protocol>
        <User>bob</User><Logontype>1</Logontype><Pass encoding="base64">c2VjcmV0</Pass>
        <Name>Bob</Name><Colour>2</Colour>
      </Server>
      <Server>
        <Host>locked.example.com</Host><Protocol>4</Protocol>
        <User>al</User><Logontype>1</Logontype><Pass encoding="crypt" pubkey="x">abc</Pass>
        <Name>Locked</Name>
      </Server>
      <Server><Host>s3.example.com</Host><Protocol>7</Protocol><Name>Bucket</Name></Server>
    </Folder>
  </Servers>
</FileZilla3>"#;
        let (sites, unsupported) = parse(xml).unwrap();
        assert_eq!(sites.len(), 3);
        assert_eq!(unsupported, vec!["Bucket".to_string()]);

        let key = &sites[0];
        assert_eq!(key.site.auth, AuthMethod::Key);
        assert_eq!(key.site.remote_dir, "/var/www");
        assert_eq!(key.site.folder, "");

        let bob = &sites[1];
        assert_eq!(bob.site.folder, "Clients");
        assert_eq!(bob.site.protocol, Protocol::Ftp);
        assert_eq!(bob.password.as_deref(), Some("secret"));
        assert_eq!(bob.site.color, "green");

        let locked = &sites[2];
        assert_eq!(locked.site.port, 21);
        assert!(locked.password.is_none());
        assert!(locked.needs_password);
    }
}
