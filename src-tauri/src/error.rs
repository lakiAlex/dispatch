use serde::Serialize;
use suppaftp::FtpError;

/// Error returned to the frontend. `code` lets the UI react (prompt for a
/// password, offer to trust a host key) instead of only showing the message.
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new("error", message)
    }

    pub fn connection(message: impl Into<String>) -> Self {
        Self::new("connection", message)
    }

    pub fn cancelled() -> Self {
        Self::new("cancelled", "Cancelled")
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    /// The connection is broken and should be dropped and opened again.
    pub fn is_connection(&self) -> bool {
        self.code == "connection"
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::other(e.to_string())
    }
}

impl From<FtpError> for AppError {
    fn from(e: FtpError) -> Self {
        match e {
            FtpError::ConnectionError(err) => Self::connection(err.to_string()),
            FtpError::BadResponse => Self::connection("The server sent an invalid response"),
            FtpError::SecureError(msg) => Self::new("tls", format!("TLS error: {msg}")),
            FtpError::UnexpectedResponse(resp) => {
                let code = resp.status.code();
                let text = resp.as_string().unwrap_or_default();
                let message = format!("{code} {}", text.trim_start_matches(&code.to_string()).trim());
                match code {
                    421 => Self::connection(message),
                    530 => Self::new("auth", message),
                    _ => Self::other(message),
                }
            }
            other => Self::other(other.to_string()),
        }
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        Self::connection(e.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        use russh_sftp::client::error::Error as E;
        match e {
            E::Status(status) => {
                let msg = status.error_message.trim();
                if msg.is_empty() {
                    Self::other(status.status_code.to_string())
                } else {
                    Self::other(msg.to_string())
                }
            }
            E::IO(msg) => Self::connection(msg),
            E::Timeout => Self::connection("Timed out waiting for the server"),
            E::UnexpectedPacket | E::UnexpectedBehavior(_) => Self::connection(e.to_string()),
            E::Limited(msg) => Self::other(msg),
        }
    }
}
