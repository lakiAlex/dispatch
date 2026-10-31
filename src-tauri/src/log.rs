use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct LogLine {
    time: i64,
    level: &'static str,
    message: String,
}

/// Sends connection and transfer messages to the Log tab in the UI.
#[derive(Clone)]
pub struct Logger {
    app: Option<AppHandle>,
}

impl Logger {
    pub fn new(app: AppHandle) -> Self {
        Self { app: Some(app) }
    }

    /// A logger that prints to stderr, for tests.
    #[cfg(test)]
    pub fn stderr() -> Self {
        Self { app: None }
    }

    fn emit(&self, level: &'static str, message: String) {
        match &self.app {
            Some(app) => {
                let line = LogLine { time: chrono::Utc::now().timestamp_millis(), level, message };
                let _ = app.emit("log", line);
            }
            None => eprintln!("[{level}] {message}"),
        }
    }

    pub fn info(&self, message: impl Into<String>) {
        self.emit("info", message.into());
    }

    pub fn warn(&self, message: impl Into<String>) {
        self.emit("warn", message.into());
    }

    pub fn error(&self, message: impl Into<String>) {
        self.emit("error", message.into());
    }
}
