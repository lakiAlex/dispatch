//! Import of saved sites from other FTP clients.

pub mod cyberduck;
pub mod filezilla;

use serde::Serialize;

use crate::sites::Site;

pub struct ImportedSite {
    pub site: Site,
    /// The password, when the other app stores it in a form Dispatch can read.
    pub password: Option<String>,
    /// The site uses a password that could not be imported. Dispatch asks for it on the first connect.
    pub needs_password: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// "FileZilla" or "Cyberduck".
    pub source: &'static str,
    pub path: String,
    pub found: usize,
    pub imported: usize,
    pub already_present: usize,
    /// Sites using a protocol Dispatch does not support (S3, WebDAV, ...).
    pub unsupported: Vec<String>,
    /// Imported sites whose password could not be imported.
    pub need_password: Vec<String>,
}
