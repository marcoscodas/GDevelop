//! Shared command-level error type.
//!
//! Every command-level rejection (as opposed to a per-file failure recorded inside
//! `FlushExportResult.failures`, see `fs_cmds.rs`) serializes to this shape, so the
//! JS-side `TauriBridge.js` can read `.code` directly instead of parsing a message
//! string. `code` is always one of the `TauriBridgeErrorCode` variants from the
//! contract (NOT_FOUND, PERMISSION_DENIED, OUT_OF_SCOPE, ALREADY_EXISTS, IO,
//! PORT_UNAVAILABLE, WINDOW, UNKNOWN).

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    pub path: Option<String>,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        CommandError {
            code,
            message: message.into(),
            path: None,
        }
    }

    pub fn with_path(code: &'static str, message: impl Into<String>, path: impl Into<String>) -> Self {
        CommandError {
            code,
            message: message.into(),
            path: Some(path.into()),
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new("IO", message)
    }

    /// Not currently used by any command here (NOT_FOUND cases we hit today
    /// — a missing flush_export source, a missing fs_stat_many path — are
    /// handled as `None`/per-file failures, not command-level rejections),
    /// kept for completeness of the contract's error-code vocabulary.
    #[allow(dead_code)]
    pub fn not_found(path: impl Into<String>) -> Self {
        let path = path.into();
        Self::with_path("NOT_FOUND", format!("not found: {path}"), path)
    }

    pub fn out_of_scope(path: impl Into<String>) -> Self {
        let path = path.into();
        Self::with_path(
            "OUT_OF_SCOPE",
            format!("{path} is outside the allowed scope"),
            path,
        )
    }

    pub fn port_unavailable(message: impl Into<String>) -> Self {
        Self::new("PORT_UNAVAILABLE", message)
    }

    pub fn window(message: impl Into<String>) -> Self {
        Self::new("WINDOW", message)
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}
