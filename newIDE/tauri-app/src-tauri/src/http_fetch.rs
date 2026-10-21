//! `http_fetch` — generic HTTPS request proxy, performed from Rust.
//!
//! Routes GDevelop API/asset calls through Rust instead of the webview's
//! fetch: the webview's CORS policy blocks JS from reading cross-origin
//! responses unless the server allowlists this app's origin, which
//! GDevelop's backends don't. Rust's HTTP client has no CORS concept, so
//! this sidesteps the restriction without server-side changes.
//!
//! Generic (any HTTPS URL, not just GDevelop hosts) since the caller is
//! first-party app JS, not remote script - no capability gained a normal
//! tab wouldn't already have. HTTPS-only is enforced to keep this a plain
//! network proxy.
//!
//! Consumed by one axios adapter (`Utils/Tauri/AxiosTauriAdapter.js`),
//! installed as `axios.defaults.adapter` under Tauri, so every existing
//! `GDevelopServices/*.js` caller gets this with no per-file changes.

use std::collections::HashMap;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};

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

    // Without a timeout, a hung backend freezes the app instead of failing
    // visibly. 30s total; 15s connect so a dead connection is distinguished
    // from a server that connected but never answered (see is_connect()
    // below, and Ipv4PreferringResolver).
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .dns_resolver(ipv4_preferring_resolver())
        .build()
        .map_err(|e| CommandError::new("UNKNOWN", format!("failed to build HTTP client: {e}")))?;
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

    let started = Instant::now();
    let response = builder.send().await.map_err(|e| {
        // reqwest::Error's Display is a generic wrapper; walk .source() for
        // the real cause (DNS, TLS, connect timeout, etc).
        let mut chain = format!("{e}");
        let mut source = std::error::Error::source(&e);
        while let Some(s) = source {
            chain.push_str(&format!(" <- {s}"));
            source = s.source();
        }
        log::warn!(
            "http_fetch: request failed for {} after {:?} (timeout={}, connect={}): {chain} | debug: {e:?}",
            request.url,
            started.elapsed(),
            e.is_timeout(),
            e.is_connect(),
        );
        CommandError::io(format!("request failed: {chain}"))
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

/// Resolves via the OS resolver, then drops IPv6 addresses when an IPv4
/// one is also available. Works around networks where an IPv6 route
/// completes the TCP handshake and then stalls (hyper's Happy Eyeballs
/// only races the initial connect, not what happens after).
#[derive(Debug, Default)]
pub struct Ipv4PreferringResolver;

pub fn ipv4_preferring_resolver() -> Arc<Ipv4PreferringResolver> {
    Arc::new(Ipv4PreferringResolver)
}

impl reqwest::dns::Resolve for Ipv4PreferringResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let started = Instant::now();
            // Port 0: reqwest/hyper overwrite the port with the URL's own.
            let lookup_host = host.clone();
            let resolved: Vec<SocketAddr> = tauri::async_runtime::spawn_blocking(move || {
                (lookup_host.as_str(), 0)
                    .to_socket_addrs()
                    .map(|addrs| addrs.collect::<Vec<_>>())
            })
            .await
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?
            .map_err(|e| {
                log::warn!("http_fetch: DNS lookup failed for {host} after {:?}: {e}", started.elapsed());
                Box::new(e) as Box<dyn std::error::Error + Send + Sync>
            })?;
            let chosen = prefer_ipv4(&resolved);
            log::debug!(
                "http_fetch: resolved {host} in {:?} -> {resolved:?}, using {chosen:?}",
                started.elapsed()
            );
            Ok(Box::new(chosen.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// IPv4 addresses only (in the OS's order) when there are any; otherwise
/// everything unchanged, so an IPv6-only host or network still works.
fn prefer_ipv4(addrs: &[SocketAddr]) -> Vec<SocketAddr> {
    let v4: Vec<SocketAddr> = addrs.iter().copied().filter(SocketAddr::is_ipv4).collect();
    if v4.is_empty() {
        addrs.to_vec()
    } else {
        v4
    }
}

#[cfg(test)]
mod tests {
    use super::prefer_ipv4;
    use std::net::SocketAddr;

    fn a(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn drops_ipv6_when_ipv4_is_available_keeping_os_order() {
        let input = [
            a("[2606:4700:20::681a:941]:0"),
            a("104.26.9.65:0"),
            a("[2606:4700:20::681a:841]:0"),
            a("172.67.74.45:0"),
        ];
        assert_eq!(prefer_ipv4(&input), vec![a("104.26.9.65:0"), a("172.67.74.45:0")]);
    }

    #[test]
    fn keeps_ipv6_for_ipv6_only_hosts() {
        let input = [a("[2606:4700:20::681a:941]:0")];
        assert_eq!(prefer_ipv4(&input), input.to_vec());
    }

    #[test]
    fn ipv4_only_input_is_unchanged() {
        let input = [a("3.162.112.73:0"), a("3.162.112.55:0")];
        assert_eq!(prefer_ipv4(&input), input.to_vec());
    }
}
