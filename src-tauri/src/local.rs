use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::remote::Entry;

pub fn home() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into())
}

pub fn expand(path: &str) -> PathBuf {
    if path == "~" {
        return PathBuf::from(home());
    }
    match path.strip_prefix("~/") {
        Some(rest) => PathBuf::from(home()).join(rest),
        None => PathBuf::from(path),
    }
}

fn entry_for(path: &Path, name: String) -> Option<Entry> {
    let link_meta = std::fs::symlink_metadata(path).ok()?;
    let is_link = link_meta.file_type().is_symlink();
    // Follow links so a link to a folder opens like a folder. Broken links fall back to the link itself.
    let meta = if is_link { std::fs::metadata(path).unwrap_or(link_meta) } else { link_meta };
    Some(Entry {
        name,
        is_dir: meta.is_dir(),
        is_link,
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64),
        mode: Some(meta.permissions().mode() & 0o7777),
        owner: None,
    })
}

pub fn list(path: &str) -> AppResult<Vec<Entry>> {
    let dir = expand(path);
    let read = std::fs::read_dir(&dir).map_err(|e| AppError::other(format!("{}: {e}", dir.display())))?;
    Ok(read
        .filter_map(|item| item.ok())
        .filter_map(|item| entry_for(&item.path(), item.file_name().to_string_lossy().into_owned()))
        .collect())
}

pub fn mkdir(path: &str) -> AppResult<()> {
    Ok(std::fs::create_dir(expand(path))?)
}

pub fn rename(from: &str, to: &str) -> AppResult<()> {
    let to = expand(to);
    if to.exists() {
        return Err(AppError::other(format!("{} already exists", to.display())));
    }
    Ok(std::fs::rename(expand(from), to)?)
}

/// Moves files to the macOS Trash instead of deleting them.
pub fn trash(paths: &[String]) -> AppResult<()> {
    let paths: Vec<PathBuf> = paths.iter().map(|p| expand(p)).collect();
    trash::delete_all(paths).map_err(|e| AppError::other(e.to_string()))
}

/// A file found while walking a local folder for upload.
pub struct WalkItem {
    pub path: PathBuf,
    /// Path relative to the folder the walk started from, with "/" separators.
    pub relative: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Lists a file or a folder tree for upload. Symlinked folders are not followed.
pub fn walk(root: &Path) -> AppResult<Vec<WalkItem>> {
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let meta = std::fs::metadata(root)?;
    let mut items = vec![WalkItem { path: root.to_path_buf(), relative: name.clone(), is_dir: meta.is_dir(), size: meta.len() }];
    if !meta.is_dir() {
        return Ok(items);
    }
    let mut stack = vec![(root.to_path_buf(), name)];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        let mut children: Vec<_> = read.filter_map(|e| e.ok()).collect();
        children.sort_by_key(|e| e.file_name());
        for child in children {
            let path = child.path();
            let child_rel = format!("{rel}/{}", child.file_name().to_string_lossy());
            let Ok(link_meta) = std::fs::symlink_metadata(&path) else { continue };
            if link_meta.file_type().is_symlink() {
                match std::fs::metadata(&path) {
                    Ok(m) if m.is_file() => {
                        items.push(WalkItem { path, relative: child_rel, is_dir: false, size: m.len() })
                    }
                    _ => {}
                }
                continue;
            }
            if link_meta.is_dir() {
                items.push(WalkItem { path: path.clone(), relative: child_rel.clone(), is_dir: true, size: 0 });
                stack.push((path, child_rel));
            } else if link_meta.is_file() {
                items.push(WalkItem { path, relative: child_rel, is_dir: false, size: link_meta.len() });
            }
        }
    }
    Ok(items)
}
