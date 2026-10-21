//! `fs_stat_many` and `flush_export`. See TauriBridge-contract.md §0/§1/§3.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::error::CommandError;

// --- fs_stat_many ------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub is_file: bool,
    pub is_directory: bool,
    pub size: u64,
    /// ms since epoch; 0 if the OS doesn't report it.
    pub mtime_ms: u64,
}

fn stat_path(path: &str) -> Option<FileStat> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(FileStat {
        is_file: meta.is_file(),
        is_directory: meta.is_dir(),
        size: meta.len(),
        mtime_ms,
    })
}

/// Batched stat, same order as input; `None` for missing (or otherwise
/// unreadable, e.g. out-of-scope) paths. One IPC round-trip instead of N.
#[tauri::command]
pub fn fs_stat_many(paths: Vec<String>) -> Vec<Option<FileStat>> {
    paths.iter().map(|p| stat_path(p)).collect()
}

// --- flush_export --------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileEntry {
    pub dest: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFileEntry {
    pub source: String,
    pub dest: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFileEntry {
    pub url: String,
    pub dest: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub output_dir: String,
    pub clear_output_dir: bool,
    pub text_files: Vec<TextFileEntry>,
    pub files_to_copy: Vec<CopyFileEntry>,
    pub files_to_download: Vec<DownloadFileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFailure {
    pub dest: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlushExportResult {
    pub written: u32,
    pub copied: u32,
    pub downloaded: u32,
    pub failures: Vec<FileFailure>,
}

/// Resolves `dest` to a canonical path that is guaranteed to be inside
/// `canonical_output_dir`, creating missing parent directories along the way.
/// Returns a `FileFailure` (never aborts the whole flush) if `dest` escapes
/// `outputDir`, or if its parent directory cannot be created/canonicalized.
fn resolve_dest_in_scope(
    canonical_output_dir: &Path,
    dest: &str,
) -> Result<PathBuf, FileFailure> {
    let dest_path = PathBuf::from(dest);

    let file_name = match dest_path.file_name() {
        Some(name) => name.to_owned(),
        None => {
            return Err(FileFailure {
                dest: dest.to_string(),
                code: "IO".to_string(),
                message: "dest has no file name".to_string(),
            })
        }
    };

    let parent = dest_path.parent().unwrap_or_else(|| Path::new("."));

    if let Err(e) = std::fs::create_dir_all(parent) {
        return Err(FileFailure {
            dest: dest.to_string(),
            code: "IO".to_string(),
            message: format!("failed to create parent directory {}: {e}", parent.display()),
        });
    }

    let canonical_parent = match std::fs::canonicalize(parent) {
        Ok(p) => p,
        Err(e) => {
            return Err(FileFailure {
                dest: dest.to_string(),
                code: "IO".to_string(),
                message: format!("failed to canonicalize {}: {e}", parent.display()),
            })
        }
    };

    if !canonical_parent.starts_with(canonical_output_dir) {
        return Err(FileFailure {
            dest: dest.to_string(),
            code: "OUT_OF_SCOPE".to_string(),
            message: format!(
                "{dest} resolves to {} which is outside outputDir {}",
                canonical_parent.display(),
                canonical_output_dir.display()
            ),
        });
    }

    Ok(canonical_parent.join(file_name))
}

fn write_text_files(
    canonical_output_dir: &Path,
    entries: Vec<TextFileEntry>,
    result: &mut FlushExportResult,
) {
    for entry in entries {
        let resolved = match resolve_dest_in_scope(canonical_output_dir, &entry.dest) {
            Ok(p) => p,
            Err(failure) => {
                result.failures.push(failure);
                continue;
            }
        };

        match std::fs::write(&resolved, entry.text.as_bytes()) {
            Ok(()) => result.written += 1,
            Err(e) => result.failures.push(FileFailure {
                dest: entry.dest,
                code: "IO".to_string(),
                message: format!("failed to write text file: {e}"),
            }),
        }
    }
}

fn copy_local_files(
    canonical_output_dir: &Path,
    entries: Vec<CopyFileEntry>,
    result: &mut FlushExportResult,
) {
    for entry in entries {
        let resolved = match resolve_dest_in_scope(canonical_output_dir, &entry.dest) {
            Ok(p) => p,
            Err(failure) => {
                result.failures.push(failure);
                continue;
            }
        };

        if !Path::new(&entry.source).exists() {
            result.failures.push(FileFailure {
                dest: entry.dest,
                code: "NOT_FOUND".to_string(),
                message: format!("source not found: {}", entry.source),
            });
            continue;
        }

        match std::fs::copy(&entry.source, &resolved) {
            Ok(_) => result.copied += 1,
            Err(e) => result.failures.push(FileFailure {
                dest: entry.dest,
                code: "IO".to_string(),
                message: format!("failed to copy {}: {e}", entry.source),
            }),
        }
    }
}

/// Downloads `entries` with bounded concurrency (fixed-size chunks run
/// concurrently, chunks run one after another) using a plain `reqwest`
/// client. Per-file failures are recorded, never propagated.
async fn download_files(
    canonical_output_dir: &Path,
    entries: Vec<DownloadFileEntry>,
    result: &mut FlushExportResult,
) {
    const CONCURRENCY: usize = 4;

    // Resolve + validate destinations up front (cheap, sync) so only genuinely
    // in-scope downloads get spawned.
    let mut to_download: Vec<(DownloadFileEntry, PathBuf)> = Vec::new();
    for entry in entries {
        match resolve_dest_in_scope(canonical_output_dir, &entry.dest) {
            Ok(resolved) => to_download.push((entry, resolved)),
            Err(failure) => result.failures.push(failure),
        }
    }

    if to_download.is_empty() {
        return;
    }

    // Same IPv4-preferring resolver as http_fetch (see
    // `http_fetch::Ipv4PreferringResolver`): export downloads come from the
    // same resources.gdevelop-app.com host that http_fetch can't reach on
    // the tester's Windows machine (suspected broken IPv6 path).
    let client = reqwest::Client::builder()
        .dns_resolver(crate::http_fetch::ipv4_preferring_resolver())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    for chunk in to_download.chunks(CONCURRENCY) {
        let handles: Vec<_> = chunk
            .iter()
            .cloned()
            .map(|(entry, resolved)| {
                let client = client.clone();
                tauri::async_runtime::spawn(async move {
                    let outcome = async {
                        let response = client
                            .get(&entry.url)
                            .send()
                            .await
                            .map_err(|e| format!("request failed: {e}"))?;

                        if !response.status().is_success() {
                            return Err(format!("HTTP {}", response.status()));
                        }

                        let bytes = response
                            .bytes()
                            .await
                            .map_err(|e| format!("failed to read response body: {e}"))?;

                        std::fs::write(&resolved, &bytes)
                            .map_err(|e| format!("failed to write downloaded file: {e}"))?;

                        Ok::<(), String>(())
                    }
                    .await;

                    (entry.dest, outcome)
                })
            })
            .collect();

        for handle in handles {
            match handle.await {
                Ok((dest, Ok(()))) => {
                    let _ = dest;
                    result.downloaded += 1;
                }
                Ok((dest, Err(message))) => result.failures.push(FileFailure {
                    dest,
                    code: "IO".to_string(),
                    message,
                }),
                Err(join_err) => result.failures.push(FileFailure {
                    dest: "<unknown>".to_string(),
                    code: "UNKNOWN".to_string(),
                    message: format!("download task panicked: {join_err}"),
                }),
            }
        }
    }
}

/// Writes text files, copies local files and downloads URL files in one IPC
/// call. Canonicalizes every `dest` and rejects anything resolving outside
/// `outputDir` (as a per-file `OUT_OF_SCOPE` failure, not a whole-command
/// rejection: a single bad/missing resource must not kill a preview or a
/// save-as resource copy). Only a failure to prepare `outputDir` itself is a
/// command-level error.
#[tauri::command]
pub async fn flush_export(manifest: ExportManifest) -> Result<FlushExportResult, CommandError> {
    let output_dir = PathBuf::from(&manifest.output_dir);

    std::fs::create_dir_all(&output_dir).map_err(|e| {
        CommandError::with_path(
            "IO",
            format!("failed to create outputDir: {e}"),
            manifest.output_dir.clone(),
        )
    })?;

    if manifest.clear_output_dir {
        for entry in std::fs::read_dir(&output_dir).map_err(|e| {
            CommandError::io(format!("failed to read outputDir for clearing: {e}"))
        })? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            let remove_result = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            // Best-effort: an entry we can't remove will simply be
            // overwritten (files) or left alongside (dirs) below.
            let _ = remove_result;
        }
    }

    let canonical_output_dir = std::fs::canonicalize(&output_dir).map_err(|e| {
        CommandError::with_path(
            "IO",
            format!("failed to canonicalize outputDir: {e}"),
            manifest.output_dir.clone(),
        )
    })?;

    let mut result = FlushExportResult::default();

    write_text_files(&canonical_output_dir, manifest.text_files, &mut result);
    copy_local_files(&canonical_output_dir, manifest.files_to_copy, &mut result);
    download_files(&canonical_output_dir, manifest.files_to_download, &mut result).await;

    Ok(result)
}
