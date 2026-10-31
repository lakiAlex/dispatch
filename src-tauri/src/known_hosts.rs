use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// SSH host keys Dispatch has seen, stored as "host:port" -> "algorithm SHA256:fingerprint".
/// A host is trusted the first time it is seen. A different key later is refused
/// until the user accepts it.
pub struct KnownHosts {
    path: PathBuf,
    map: Mutex<BTreeMap<String, String>>,
}

pub enum HostCheck {
    Known,
    New,
    Changed { expected: String },
}

impl KnownHosts {
    pub fn load(path: PathBuf) -> Self {
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, map: Mutex::new(map) }
    }

    pub fn check_and_learn(&self, host_port: &str, fingerprint: &str) -> HostCheck {
        let mut map = self.map.lock().unwrap();
        match map.get(host_port) {
            Some(known) if known == fingerprint => HostCheck::Known,
            Some(known) => HostCheck::Changed { expected: known.clone() },
            None => {
                map.insert(host_port.to_string(), fingerprint.to_string());
                self.persist(&map);
                HostCheck::New
            }
        }
    }

    pub fn trust(&self, host_port: &str, fingerprint: &str) {
        let mut map = self.map.lock().unwrap();
        map.insert(host_port.to_string(), fingerprint.to_string());
        self.persist(&map);
    }

    fn persist(&self, map: &BTreeMap<String, String>) {
        if let Ok(json) = serde_json::to_string_pretty(map) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}
