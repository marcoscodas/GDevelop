//! `http_fetch` — generic HTTPS request proxy, performed from Rust.
//!
//! Added post-MVP (TauriBridge contract v1.1, not in the original frozen
//! v1): the first real Windows run showed GDevelop's own backends (asset
//! store, tutorials, the GDJS runtime fetch preview depends on) all failing
//! together. The leading cause is CORS: the browser blocks the WEBVIEW's JS
//! from *reading* a cross-origin response unless the server's
//! `Access-Control-Allow-Origin` includes this app's origin
//! (`https://tauri.localhost` on WebView2) - the request may well reach the
//! server fine, the browser just refuses to hand the response back to JS.
//! Rust's HTTP client has no concept of CORS at all, so routing these calls
//! through Rust sidesteps the problem regardless of server-side config we
//! don't control.
//!
//! This command is intentionally generic (any HTTPS URL, not just
//! GDevelop's own hosts): the caller is 100% first-party GDevelop JS, not
//! arbitrary remote script, so this grants no capability a normal browser
//! tab running this same code didn't already have (any page's JS can fetch
//! any HTTPS URL - CORS restricts *reading the response*, not *sending the
//! request*). The one restriction enforced here is the scheme itself
//! (HTTPS only), to keep this a plain network proxy and nothing else (no
//! `file://`, no internal Tauri IPC scheme).
//!
//! JS side: `TauriBridge.httpFetch` is consumed by a single custom axios
//! adapter (`Utils/Tauri/AxiosTauriAdapter.js`), installed once as
//! `axios.defaults.adapter` when `isTauri()`, so all ~18 existing
//! `GDevelopServices/*.js` files that already call axios get this for free
//! - no per-file changes, per the additive-only rule.

use std::collections::HashMap;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::CommandError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchRequest {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    /// Base64-encoded request body, or absent for GET/HEAD and other
    /// bodyless requests. JS always base64-encodes so this command never
    /// has to guess text vs. binary.
    pub body_base64: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    /// Base64-encoded response body; JS decides how to interpret it
    /// (text, JSON.parse, or a Blob) based on the request's `responseType`,
    /// mirroring how axios's real adapters hand raw data to its transform
    /// pipeline rather than parsing it themselves.
    pub body_base64: String,
}

#[tauri::command]
pub async fn http_fetch(request: HttpFetchRequest) -> Result<HttpFetchResponse, CommandError> {
    if !request.url.starts_with("https://") {
        return Err(CommandError::out_of_scope(request.url));
    }

    let method = reqwest::Method::from_bytes(request.method.to_uppercase().as_bytes())
        .map_err(|e| CommandError::new("UNKNOWN", format!("invalid HTTP method: {e}")))?;

    let client = reqwest::Client::new();
    let mut builder = client.request(method, &request.url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body_base64) = &request.body_base64 {
        let bytes = BASE64
            .decode(body_base64)
            .map_err(|e| CommandError::new("UNKNOWN", format!("invalid request body: {e}")))?;
        builder = builder.body(bytes);
    }

    log::debug!("http_fetch: {} {}", request.method, request.url);

    let response = builder.send().await.map_err(|e| {
        log::warn!("http_fetch: request failed for {}: {e}", request.url);
        CommandError::io(format!("request failed: {e}"))
    })?;

    let status = response.status().as_u16();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();

    let mut headers = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(value_str) = value.to_str() {
            headers.insert(name.as_str().to_string(), value_str.to_string());
        }
    }

    let bytes = response.bytes().await.map_err(|e| {
        CommandError::io(format!("failed reading response body for {}: {e}", request.url))
    })?;

    log::debug!(
        "http_fetch: {} {} -> {status} ({} bytes)",
        request.method,
        request.url,
        bytes.len()
    );

    Ok(HttpFetchResponse {
        status,
        status_text,
        headers,
        body_base64: BASE64.encode(&bytes),
    })
}
