use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::local::expand;

const KEYCHAIN_SERVICE: &str = "com.laki.dispatch";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    #[default]
    Sftp,
    /// FTP, upgraded to TLS when the server supports it.
    Ftp,
    /// FTP that requires explicit TLS.
    Ftpes,
    /// Implicit FTP over TLS (usually port 990).
    Ftps,
    /// Plain FTP, never TLS.
    FtpPlain,
}

impl Protocol {
    pub fn default_port(self) -> u16 {
        match self {
            Protocol::Sftp => 22,
            Protocol::Ftps => 990,
            _ => 21,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Protocol::Sftp => "SFTP",
            Protocol::Ftp => "FTP",
            Protocol::Ftpes => "FTPES",
            Protocol::Ftps => "FTPS",
            Protocol::FtpPlain => "FTP (plain)",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMethod {
    #[default]
    Password,
    /// Ask for the password on every connect.
    Ask,
    Key,
    Agent,
    Anonymous,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Site {
    pub id: String,
    pub name: String,
    /// Folder path in the sidebar, segments separated by "/". Empty for the top level.
    pub folder: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub key_path: String,
    pub remote_dir: String,
    pub local_dir: String,
    pub insecure_tls: bool,
    pub color: String,
    pub notes: String,
    pub password_saved: bool,
    pub passphrase_saved: bool,
}

impl Site {
    /// Identity used to spot duplicates when importing.
    pub fn same_target(&self, other: &Site) -> bool {
        self.protocol == other.protocol
            && self.host.eq_ignore_ascii_case(&other.host)
            && self.port == other.port
            && self.user == other.user
            && self.name == other.name
    }
}

pub struct SiteStore {
    path: PathBuf,
    sites: Mutex<Vec<Site>>,
}

impl SiteStore {
    pub fn load(path: PathBuf) -> Self {
        let sites = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Site>>(&s).ok())
            .unwrap_or_default();
        Self { path, sites: Mutex::new(sites) }
    }

    pub fn list(&self) -> Vec<Site> {
        self.sites.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Site> {
        self.sites.lock().unwrap().iter().find(|s| s.id == id).cloned()
    }

    pub fn upsert(&self, mut site: Site) -> AppResult<Site> {
        if site.id.is_empty() {
            site.id = uuid::Uuid::new_v4().to_string();
        }
        if site.port == 0 {
            site.port = site.protocol.default_port();
        }
        let mut sites = self.sites.lock().unwrap();
        match sites.iter_mut().find(|s| s.id == site.id) {
            Some(existing) => *existing = site.clone(),
            None => sites.push(site.clone()),
        }
        self.persist(&sites)?;
        Ok(site)
    }

    pub fn update<F: FnOnce(&mut Site)>(&self, id: &str, f: F) -> AppResult<()> {
        let mut sites = self.sites.lock().unwrap();
        if let Some(site) = sites.iter_mut().find(|s| s.id == id) {
            f(site);
            self.persist(&sites)?;
        }
        Ok(())
    }

    /// Marks every site that uses this key file as having a saved passphrase, or not.
    pub fn set_passphrase_saved(&self, key_path: &str, saved: bool) -> AppResult<()> {
        let key = expand(key_path);
        let mut sites = self.sites.lock().unwrap();
        for site in sites.iter_mut().filter(|s| s.auth == AuthMethod::Key && expand(&s.key_path) == key) {
            site.passphrase_saved = saved;
        }
        self.persist(&sites)
    }

    pub fn remove(&self, id: &str) -> AppResult<()> {
        let mut sites = self.sites.lock().unwrap();
        sites.retain(|s| s.id != id);
        self.persist(&sites)
    }

    pub fn add_many(&self, new_sites: Vec<Site>) -> AppResult<()> {
        let mut sites = self.sites.lock().unwrap();
        sites.extend(new_sites);
        self.persist(&sites)
    }

    fn persist(&self, sites: &[Site]) -> AppResult<()> {
        let json = serde_json::to_string_pretty(sites).map_err(|e| AppError::other(e.to_string()))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// What a Keychain item belongs to. Passwords are saved per site. Key
/// passphrases are saved per key file, so all sites that use the same key
/// share one saved passphrase.
#[derive(Debug, Clone, Copy)]
pub enum Secret<'a> {
    SitePassword(&'a str),
    KeyPassphrase(&'a str),
}

fn keychain_entry(secret: Secret) -> AppResult<keyring::Entry> {
    let account = match secret {
        Secret::SitePassword(site_id) => format!("{site_id}:password"),
        Secret::KeyPassphrase(key_path) => format!("key:{}", expand(key_path).display()),
    };
    keyring::Entry::new(KEYCHAIN_SERVICE, &account).map_err(|e| AppError::other(format!("Keychain: {e}")))
}

pub fn secret_get(secret: Secret) -> Option<String> {
    keychain_entry(secret).ok()?.get_password().ok()
}

pub fn secret_set(secret: Secret, value: &str) -> AppResult<()> {
    keychain_entry(secret)?
        .set_password(value)
        .map_err(|e| AppError::other(format!("Keychain: {e}")))
}

pub fn secret_delete(secret: Secret) {
    if let Ok(entry) = keychain_entry(secret) {
        let _ = entry.delete_credential();
    }
}
