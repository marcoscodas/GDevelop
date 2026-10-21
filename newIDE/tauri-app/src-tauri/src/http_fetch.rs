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

    // No timeout at all would mean a hung backend makes the whole app look
    // frozen rather than failing cleanly (e.g. the asset store spinning
    // forever instead of showing an error). 30s matches a generous but
    // bounded wait for a single API call; this isn't the preview server
    // (loopback, instant) or a large asset download, just small JSON/text
    // responses from GDevelop's own APIs.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        // Diagnostic split, not a fix: if the connection itself (TCP + TLS)
        // isn't up within 15s, fail as a *connect* timeout (`is_connect()`)
        // instead of the generic 30s total timeout - so the next real log
        // tells "never connected" apart from "connected, server never
        // answered". See `Ipv4PreferringResolver` for why that matters.
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
        // reqwest::Error's Display impl is a generic one-line wrapper (e.g.
        // "error sending request for url (...)") that hides the actual
        // cause. The first attempt to fix a real Windows failure here
        // (switching to native TLS roots) turned out to be the wrong guess
        // - still failing after that fix shipped - so this walks the full
        // `.source()` chain to get the real underlying error (DNS, TLS
        // handshake, connect timeout, etc.) instead of guessing again.
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

/// DNS resolver for every reqwest client in this app: resolves with the OS
/// resolver (`getaddrinfo`, exactly like reqwest's default), then keeps only
/// the IPv4 addresses whenever there is at least one (IPv6 is used only
/// for IPv6-only hosts/networks), and logs what it resolved.
///
/// Evidence behind this (real Windows log, 2026-10-21): every
/// `resources.gdevelop-app.com` failure lands exactly 30.0s after its
/// "starting new connection" line - i.e. it is the client's own 30s total
/// timeout firing on a connection that silently hangs, not a TLS/cert error
/// (those fail immediately, which is also why switching to native roots
/// changed nothing), not a refusal, and not a WAF block (that would be an
/// HTTP 403 *response*, and Cloudflare serves this host fine to a client
/// with no User-Agent over HTTP/1.1 - checked). The one structural network
/// difference between the two hosts: `api.gdevelop.io` (CloudFront) has
/// NO AAAA records, `resources.gdevelop-app.com` (Cloudflare) has three.
/// So only the failing host ever gives this machine an IPv6 path.
/// hyper's Happy Eyeballs (300ms IPv4 fallback) only covers the TCP
/// connect itself; an IPv6 path that completes the TCP handshake but then
/// stalls (MTU black hole on a tunnel/VPN, a broken IPv6 router) wins that
/// race and then hangs TLS/HTTP until the timeout - the exact symptom.
///
/// This is a theory consistent with the evidence, not a confirmed cause
/// (the sandbox this was written in has no IPv6 at all). If it is wrong,
/// the resolver's debug line plus the connect/total-timeout split in
/// `http_fetch` say what the next run actually saw.
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
