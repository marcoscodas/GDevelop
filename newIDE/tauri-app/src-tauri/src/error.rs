//! Shared command-level error type. Every command rejection serializes to
//! this shape so `TauriBridge.js` can read `.code` directly instead of
//! parsing a message string (per-file failures go through
//! `FlushExportResult.failures` instead, see `fs_cmds.rs`).

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

    /// Unused today (NOT_FOUND cases here are per-file failures, not
    /// command rejections); kept for the contract's error-code vocabulary.
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
