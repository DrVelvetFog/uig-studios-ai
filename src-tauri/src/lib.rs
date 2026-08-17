use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager, State};

// ── Per-stream cancel tokens ──────────────────────────────────────────────────
// One flag per active stream (keyed by event_id) so concurrent sessions can
// stream independently and aborting one never touches the others.
pub struct StreamCancelMap(std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>);

impl StreamCancelMap {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(std::collections::HashMap::new()))
    }
}

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

// ── Filesystem helpers ────────────────────────────────────────────────────────

/// Home directory that works on unix (HOME) and Windows (USERPROFILE).
fn home_dir_var() -> Result<String, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "No home directory: neither HOME nor USERPROFILE is set".to_string())
}

/// App config/state dir: ~/.uigai (formerly ~/.tonyai — migrated once at startup, see migrate_legacy_dirs).
const APP_DIR: &str = ".uigai";
const LEGACY_APP_DIR: &str = ".tonyai";
/// User-facing folders live under ~/UIG-AI/<Name> (formerly ~/TonyAI-<Name>).
const USER_ROOT: &str = "UIG-AI";

fn tonyai_dir() -> Result<PathBuf, String> {
    let home = home_dir_var()?;
    let dir = PathBuf::from(home).join(APP_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// ~/UIG-AI/<name> (created on demand).
fn user_dir(name: &str) -> Result<PathBuf, String> {
    let home = home_dir_var()?;
    let dir = PathBuf::from(home).join(USER_ROOT).join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// One-time, idempotent move of the legacy layout to the current one. Never overwrites:
/// a rename happens only when the new location does not exist yet. Leaves a symlink at
/// the old location so scripts and shell habits keep working. The Python sandbox is NOT
/// moved (a relocated venv breaks); it is recreated on first use.
fn migrate_legacy_dirs() -> Vec<String> {
    let mut moved = Vec::new();
    let Ok(home) = home_dir_var() else { return moved; };
    let home = PathBuf::from(home);
    let mut pairs: Vec<(PathBuf, PathBuf)> = vec![(home.join(LEGACY_APP_DIR), home.join(APP_DIR))];
    for name in ["Projects", "Exports", "Documents", "Images"] {
        pairs.push((home.join(format!("TonyAI-{name}")), home.join(USER_ROOT).join(name)));
    }
    for (old, new) in pairs {
        let old_is_link = std::fs::symlink_metadata(&old).map(|m| m.file_type().is_symlink()).unwrap_or(false);
        if old_is_link || !old.exists() || new.exists() { continue; }
        if let Some(parent) = new.parent() { let _ = std::fs::create_dir_all(parent); }
        if std::fs::rename(&old, &new).is_ok() {
            #[cfg(unix)]
            { let _ = std::os::unix::fs::symlink(&new, &old); }
            moved.push(format!("{} → {}", old.display(), new.display()));
        }
    }
    moved
}

#[tauri::command]
fn migrate_legacy_layout() -> Result<String, String> {
    Ok(serde_json::to_string(&migrate_legacy_dirs()).unwrap_or_else(|_| "[]".into()))
}

/// ── General Knowledge Base ───────────────────────────────────────────────────
/// Separate from the code RAG index. Reads any text-based file recursively
/// from a user-configured directory (default: ~/UIG-AI/Documents/).

#[tauri::command]
fn read_knowledge_index() -> Result<String, String> {
    let path = tonyai_dir()?.join("knowledge-index.json");
    if !path.exists() { return Ok("null".to_string()); }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_knowledge_index(data: String) -> Result<(), String> {
    let path = tonyai_dir()?.join("knowledge-index.json");
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

/// Recursively reads all text-based files from a directory.
/// Supports: txt, md, py, ts, js, jsx, tsx, rs, json, yaml, yml,
///           toml, csv, sh, sql, html, xml, swift, kt, go, c, cpp, h
/// Skips: binary files, files > 500 KB, hidden dirs (.git, node_modules, etc.)
#[tauri::command]
fn read_knowledge_files(dir: String) -> Result<Vec<(String, String)>, String> {
    use std::path::PathBuf;

    const SKIP_DIRS: &[&str] = &[
        "node_modules", ".git", "target", "__pycache__", ".venv", "venv",
        "dist", "build", ".next", ".turbo", ".cache",
    ];
    const TEXT_EXTS: &[&str] = &[
        "txt", "md", "py", "ts", "js", "jsx", "tsx", "rs", "json",
        "yaml", "yml", "toml", "csv", "sh", "sql", "html", "xml",
        "swift", "kt", "go", "c", "cpp", "h", "java", "rb", "php",
        "mjs", "cjs", "env", "conf", "cfg", "ini", "log",
    ];

    let base = PathBuf::from(&dir);
    if !base.exists() {
        return Err(format!("Directory not found: {}", dir));
    }

    let mut files = Vec::new();
    let mut stack = vec![base.clone()];

    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e, Err(_) => continue,
        };
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();

            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    subdirs.push(path);
                }
                continue;
            }

            // Check extension
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !TEXT_EXTS.contains(&ext.as_str()) { continue; }

            // Skip large files (> 500 KB)
            if let Ok(meta) = std::fs::metadata(&path) {
                if meta.len() > 524_288 { continue; }
            }

            // Read — skip binary/unreadable
            if let Ok(content) = std::fs::read_to_string(&path) {
                // Build a relative path from the base dir for display
                let rel = path.strip_prefix(&base)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| name);
                files.push((rel, content));
            }
        }
        subdirs.sort();
        for d in subdirs.into_iter().rev() { stack.push(d); }
    }

    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

/// Returns (relative_path, byte_size) for all knowledge files — used for stale detection.
#[tauri::command]
fn stat_knowledge_files(dir: String) -> Result<Vec<(String, u64)>, String> {
    use std::path::PathBuf;

    const SKIP_DIRS: &[&str] = &[
        "node_modules", ".git", "target", "__pycache__", ".venv", "venv",
        "dist", "build", ".next", ".turbo", ".cache",
    ];
    const TEXT_EXTS: &[&str] = &[
        "txt", "md", "py", "ts", "js", "jsx", "tsx", "rs", "json",
        "yaml", "yml", "toml", "csv", "sh", "sql", "html", "xml",
        "swift", "kt", "go", "c", "cpp", "h", "java", "rb", "php",
        "mjs", "cjs", "env", "conf", "cfg", "ini", "log",
    ];

    let base = PathBuf::from(&dir);
    if !base.exists() { return Err(format!("Directory not found: {}", dir)); }

    let mut files = Vec::new();
    let mut stack = vec![base.clone()];

    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e, Err(_) => continue,
        };
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') { subdirs.push(path); }
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !TEXT_EXTS.contains(&ext.as_str()) { continue; }
            if let Ok(meta) = std::fs::metadata(&path) {
                let rel = path.strip_prefix(&base).map(|p| p.to_string_lossy().to_string()).unwrap_or(name);
                files.push((rel, meta.len()));
            }
        }
        subdirs.sort();
        for d in subdirs.into_iter().rev() { stack.push(d); }
    }
    Ok(files)
}

#[tauri::command]
fn read_rag_index() -> Result<String, String> {
    let path = tonyai_dir()?.join("rag-index.json");
    if !path.exists() { return Ok("null".to_string()); }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_rag_index(data: String) -> Result<(), String> {
    let path = tonyai_dir()?.join("rag-index.json");
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_source_files(dir: String) -> Result<Vec<(String, String)>, String> {
    let base = PathBuf::from(&dir);
    if !base.exists() { return Err(format!("Directory not found: {}", dir)); }
    let mut files = Vec::new();
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "ts" || ext == "js" || ext == "rs" || ext == "py" || ext == "move" {
                    if let (Some(name), Ok(content)) = (
                        path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()),
                        std::fs::read_to_string(&path),
                    ) {
                        files.push((name, content));
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

#[tauri::command]
fn stat_source_files(dir: String) -> Result<Vec<(String, u64)>, String> {
    let base = PathBuf::from(&dir);
    if !base.exists() { return Err(format!("Directory not found: {}", dir)); }
    let mut files = Vec::new();
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ["ts", "js", "rs", "py", "move"].iter().any(|e| ext == *e) {
                    if let (Some(name), Ok(meta)) = (
                        path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()),
                        std::fs::metadata(&path),
                    ) {
                        files.push((name, meta.len()));
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

#[tauri::command]
fn read_memory() -> Result<String, String> {
    let path = tonyai_dir()?.join("memory.md");
    if !path.exists() { return Ok(String::new()); }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_memory(content: String) -> Result<(), String> {
    let path = tonyai_dir()?.join("memory.md");
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ── Session store ─────────────────────────────────────────────────────────────
// One JSON file per session in ~/.tonyai/sessions/ — replaces localStorage,
// which silently loses data past its ~5MB quota. Generated images are extracted
// to ~/.tonyai/session-images/ and referenced by path.

fn session_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() < 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[tauri::command]
fn save_session(id: String, data: String) -> Result<(), String> {
    if !session_id_ok(&id) { return Err("invalid session id".into()); }
    let dir = tonyai_dir()?.join("sessions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.json", id)), data).map_err(|e| e.to_string())
}

/// Read every stored session, returned as a JSON array sorted by id (= creation time).
#[tauri::command]
fn read_sessions() -> Result<String, String> {
    let dir = tonyai_dir()?.join("sessions");
    if !dir.exists() { return Ok("[]".into()); }
    let mut named: Vec<(String, serde_json::Value)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                named.push((stem, v));
            }
        }
    }
    named.sort_by(|a, b| {
        let na = a.0.parse::<u64>().unwrap_or(0);
        let nb = b.0.parse::<u64>().unwrap_or(0);
        na.cmp(&nb)
    });
    let items: Vec<serde_json::Value> = named.into_iter().map(|(_, v)| v).collect();
    serde_json::to_string(&items).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_session_file(id: String) -> Result<(), String> {
    if !session_id_ok(&id) { return Err("invalid session id".into()); }
    let path = tonyai_dir()?.join("sessions").join(format!("{}.json", id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove all extracted images belonging to a session (files named "<id>_*.png"
/// in ~/.tonyai/session-images/). Called alongside delete_session_file.
#[tauri::command]
fn delete_session_images(id: String) -> Result<u32, String> {
    if !session_id_ok(&id) { return Err("invalid session id".into()); }
    let dir = tonyai_dir()?.join("session-images");
    if !dir.exists() { return Ok(0); }
    let prefix = format!("{}_", id);
    let mut removed = 0u32;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Save a generated image out of a session into ~/.tonyai/session-images/.
/// Returns the absolute path for by-reference storage in the session JSON.
#[tauri::command]
fn save_session_image(name: String, base64: String) -> Result<String, String> {
    if !session_id_ok(&name) { return Err("invalid image name".into()); }
    let dir = tonyai_dir()?.join("session-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let b64_data = if let Some(pos) = base64.find(',') {
        base64[pos + 1..].trim().to_string()
    } else {
        base64.trim().to_string()
    };
    use ::base64::{Engine as _, engine::general_purpose::STANDARD};
    let bytes = STANDARD.decode(&b64_data).map_err(|e| format!("base64 decode: {e}"))?;
    let path = dir.join(format!("{}.png", name));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Read a session image back as a data URI (only from the session-images dir).
#[tauri::command]
fn read_session_image(path: String) -> Result<String, String> {
    let allowed = tonyai_dir()?.join("session-images");
    let p = PathBuf::from(&path);
    if !p.starts_with(&allowed) {
        return Err("Access denied: not a session image".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    use ::base64::{Engine as _, engine::general_purpose::STANDARD};
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(&bytes)))
}

#[cfg(test)]
mod session_store_tests {
    use super::*;

    #[test]
    fn save_read_delete_roundtrip() {
        let id = format!("99999999{}", std::process::id());
        save_session(id.clone(), r#"{"id":1,"title":"t","messages":[]}"#.into()).unwrap();
        let all = read_sessions().unwrap();
        assert!(all.contains("\"title\":\"t\"") || all.contains("\"title\": \"t\""));
        delete_session_file(id.clone()).unwrap();
        assert!(save_session("../evil".into(), "{}".into()).is_err());
    }

    #[test]
    fn session_image_roundtrip() {
        // 1x1 transparent PNG
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let name = format!("imgtest{}", std::process::id());
        let path = save_session_image(name, format!("data:image/png;base64,{png_b64}")).unwrap();
        let back = read_session_image(path.clone()).unwrap();
        assert!(back.starts_with("data:image/png;base64,"));
        assert!(read_session_image("/etc/passwd".into()).is_err());
        let _ = std::fs::remove_file(path);
    }
}

// ── Secret storage ────────────────────────────────────────────────────────────
// API keys live in ~/.tonyai/secret-<key>.txt (mode 0600), NOT in the webview's
// localStorage — so untrusted page content rendered in the agent cannot scrape them.
// One file per key; key charset is restricted to block path traversal.
fn secret_key_ok(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
fn save_secret(key: String, value: String) -> Result<(), String> {
    if !secret_key_ok(&key) { return Err("invalid secret key".to_string()); }
    let path = tonyai_dir()?.join(format!("secret-{}.txt", key));
    std::fs::write(&path, value).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn read_secret(key: String) -> Result<String, String> {
    if !secret_key_ok(&key) { return Err("invalid secret key".to_string()); }
    let path = tonyai_dir()?.join(format!("secret-{}.txt", key));
    if !path.exists() { return Ok(String::new()); }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ── Diagnostic log ────────────────────────────────────────────────────────────
// Appends a single pre-formatted line to ~/.uigai/logs/tonyai.log. Rotates to
// tonyai.log.1 once the file exceeds 2 MB so it can't grow unbounded.
#[tauri::command]
fn append_log(line: String) -> Result<(), String> {
    use std::io::Write;
    let dir = tonyai_dir()?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("tonyai.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 2 * 1024 * 1024 {
            let _ = std::fs::rename(&path, dir.join("tonyai.log.1"));
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true).append(true).open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line).map_err(|e| e.to_string())
}

// ── Self-update from source ──────────────────────────────────────────────────
// No public release host exists for this app, so "auto-update" means: rebuild
// the local source tree and reinstall to /Applications. Runs detached so the
// build survives the app being replaced; output goes to ~/.tonyai/logs/update.log.

#[tauri::command]
fn launch_self_update(source_dir: String) -> Result<String, String> {
    let home = home_dir_var()?;
    if !source_dir.starts_with(&home) {
        return Err("Source directory must be under $HOME".into());
    }
    let script = PathBuf::from(&source_dir).join("scripts").join("update-app.sh");
    if !script.is_file() {
        return Err(format!("Update script not found: {}", script.display()));
    }
    let log_dir = tonyai_dir()?.join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log = log_dir.join("update.log");

    #[cfg(windows)]
    {
        let _ = (&script, &log);
        return Err("Self-update is macOS-only for now — on Windows, git pull and rebuild manually.".into());
    }
    #[cfg(not(windows))]
    std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "nohup zsh '{}' > '{}' 2>&1 &",
            script.display(), log.display()
        ))
        .spawn()
        .map_err(|e| format!("Could not start update: {e}"))?;

    Ok(format!(
        "Update started in the background — tests, build, install (~3-5 min). \
         Progress: {} . Quit and relaunch UIG Studios AI when it finishes.",
        log.display()
    ))
}

// ── Agent telemetry ───────────────────────────────────────────────────────────
// One JSON line per agent run in ~/.tonyai/telemetry.jsonl — model, loops,
// tool calls, stop rejections, outcome, duration. Rotates at 5 MB.

#[tauri::command]
fn append_telemetry(line: String) -> Result<(), String> {
    use std::io::Write;
    let dir = tonyai_dir()?;
    let path = dir.join("telemetry.jsonl");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = std::fs::rename(&path, dir.join("telemetry.jsonl.1"));
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true).append(true).open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line.replace('\n', " ")).map_err(|e| e.to_string())
}

/// One JSON line per blind-comparison vote in ~/.tonyai/compare-votes.jsonl.
#[tauri::command]
fn append_compare_vote(line: String) -> Result<(), String> {
    use std::io::Write;
    let dir = tonyai_dir()?;
    let path = dir.join("compare-votes.jsonl");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 2 * 1024 * 1024 {
            let _ = std::fs::rename(&path, dir.join("compare-votes.jsonl.1"));
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true).append(true).open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line.replace('\n', " ")).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_telemetry() -> Result<String, String> {
    let path = tonyai_dir()?.join("telemetry.jsonl");
    if !path.exists() { return Ok(String::new()); }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Read all memory .md files from ~/UIG-AI/Projects/memory/.
/// Returns JSON object: { "global": "...", "chat": "...", ... }
#[tauri::command]
fn read_memory_files() -> Result<String, String> {
    let home = home_dir_var()?;
    let dir = PathBuf::from(&home).join(USER_ROOT).join("Projects").join("memory");
    if !dir.exists() {
        return Ok("{}".to_string());
    }
    let mut map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("md") {
            let name = p.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if !name.is_empty() {
                let content = std::fs::read_to_string(&p).unwrap_or_default();
                map.insert(name, content);
            }
        }
    }
    serde_json::to_string(&map).map_err(|e| e.to_string())
}

/// Write a single memory .md file to ~/UIG-AI/Projects/memory/{name}.md.
/// name must be alphanumeric (e.g. "global", "chat", "code").
#[tauri::command]
fn save_memory_file(name: String, content: String) -> Result<(), String> {
    let home = home_dir_var()?;
    let dir = PathBuf::from(&home).join(USER_ROOT).join("Projects").join("memory");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Sanitise name — alphanumeric and underscores only
    let safe: String = name.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
    if safe.is_empty() { return Err("Invalid memory file name".into()); }
    std::fs::write(dir.join(format!("{}.md", safe)), content).map_err(|e| e.to_string())
}

// ── Inbox (background monitor findings) ──────────────────────────────────────

#[tauri::command]
fn read_inbox() -> Result<String, String> {
    let path = tonyai_dir()?.join("inbox.json");
    if !path.exists() { return Ok("[]".to_string()); }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_inbox(data: String) -> Result<(), String> {
    let path = tonyai_dir()?.join("inbox.json");
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

// ── Ops console (portfolio check state written by scripts/ops.mjs) ───────────

#[tauri::command]
fn read_ops_state() -> Result<String, String> {
    let path = tonyai_dir()?.join("ops-state.json");
    if !path.exists() { return Ok("{}".to_string()); }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ── Ollama native commands (bypass WKWebView network stack) ──────────────────

const OLLAMA_URL: &str = "http://127.0.0.1:11434";

/// Returns raw JSON from GET /api/tags (model list + health check).
#[tauri::command]
async fn ollama_tags() -> Result<String, String> {
    reqwest::Client::new()
        .get(format!("{}/api/tags", OLLAMA_URL))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())
}

/// Pull (or update) a model from the Ollama registry.
/// Returns a status string indicating whether the model was updated, already
/// up to date, or failed. Uses the /api/pull endpoint with stream=false so
/// the entire pull completes before returning.
#[tauri::command]
async fn ollama_pull(model: String) -> Result<String, String> {
    let body = serde_json::json!({ "name": model.clone(), "stream": false }).to_string();
    let resp = reqwest::Client::new()
        .post(format!("{}/api/pull", OLLAMA_URL))
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(600)) // 10 min — large models take time
        .body(body)
        .send()
        .await
        .map_err(|e| format!("pull request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("pull failed [{}]: {}", status, text));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    // Parse last line of stream to determine final status
    let last_line = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(last_line) {
        if let Some(status) = json.get("status").and_then(|s| s.as_str()) {
            return Ok(format!("{}: {}", model, status));
        }
    }
    Ok(format!("{}: pulled", model))
}

/// Non-streaming POST — used for /api/embed and any other Ollama JSON calls.
#[tauri::command]
async fn ollama_post(path: String, body: String) -> Result<String, String> {
    reqwest::Client::new()
        .post(format!("{}{}", OLLAMA_URL, path))
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(120))
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())
}

/// Streaming POST to /api/chat.
/// Each raw ndjson chunk is emitted as "ollama-chunk-{event_id}".
/// Fires "ollama-done-{event_id}" when the stream ends.
#[tauri::command]
async fn ollama_chat(
    app: AppHandle,
    cancel: State<'_, StreamCancelMap>,
    body: String,
    event_id: String,
) -> Result<(), String> {
    // Register a fresh cancel flag for this stream
    let cancel_flag = Arc::new(AtomicBool::new(false));
    cancel.0.lock().unwrap().insert(event_id.clone(), Arc::clone(&cancel_flag));

    // Ensure the flag is removed from the registry on every exit path
    struct CancelCleanup<'a>(&'a StreamCancelMap, String);
    impl<'a> Drop for CancelCleanup<'a> {
        fn drop(&mut self) {
            self.0.0.lock().unwrap().remove(&self.1);
        }
    }
    let _cleanup = CancelCleanup(&cancel, event_id.clone());

    let response = reqwest::Client::new()
        .post(format!("{}/api/chat", OLLAMA_URL))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Ollama {}: {}", status, text));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }
        let bytes = chunk.map_err(|e| e.to_string())?;
        if let Ok(text) = String::from_utf8(bytes.to_vec()) {
            buffer.push_str(&text);
        }
        // Emit when a frame's worth of time has passed (~60fps) or buffer is large
        if last_emit.elapsed().as_millis() >= 16 || buffer.len() >= 512 {
            if !buffer.is_empty() {
                let _ = app.emit(&format!("ollama-chunk-{}", event_id), std::mem::take(&mut buffer));
                last_emit = std::time::Instant::now();
            }
        }
    }
    // Flush any remaining buffered content
    if !buffer.is_empty() {
        let _ = app.emit(&format!("ollama-chunk-{}", event_id), buffer);
    }

    let _ = app.emit(&format!("ollama-done-{}", event_id), "");
    Ok(())
}

/// Signals a stream to stop after the current chunk.
/// event_id targets one stream; None aborts all active streams (legacy behavior).
#[tauri::command]
fn ollama_abort(cancel: State<'_, StreamCancelMap>, event_id: Option<String>) {
    let map = cancel.0.lock().unwrap();
    match event_id {
        Some(id) => {
            if let Some(flag) = map.get(&id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        None => {
            for flag in map.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

// ── Cloud providers (OpenRouter + OpenAI, Chat Completions wire format) ──────
// The frontend keeps speaking Ollama's ndjson chunk shape; these commands
// translate OpenAI-style SSE into it, so the agent loop is provider-agnostic.

/// Base URL of the user's custom OpenAI-compatible endpoint (stored via save_secret("custom-url")),
/// e.g. http://localhost:1234/v1 (LM Studio), http://localhost:8000/v1 (vLLM / llama.cpp),
/// https://router.huggingface.co/v1 (Hugging Face Inference Providers).
fn custom_endpoint_base() -> Result<String, String> {
    let path = tonyai_dir()?.join("secret-custom-url.txt");
    let v = std::fs::read_to_string(&path).unwrap_or_default().trim().trim_end_matches('/').to_string();
    if v.is_empty() { return Err("No custom endpoint configured — set the base URL in ⚙ settings".into()); }
    if !(v.starts_with("http://") || v.starts_with("https://")) { return Err("custom endpoint must start with http:// or https://".into()); }
    Ok(v)
}

fn cloud_endpoint(provider: &str) -> Result<(String, &'static str), String> {
    match provider {
        "openrouter" => Ok(("https://openrouter.ai/api/v1/chat/completions".to_string(), "openrouter")),
        "openai"     => Ok(("https://api.openai.com/v1/chat/completions".to_string(), "openai")),
        "custom"     => Ok((format!("{}/chat/completions", custom_endpoint_base()?), "custom")),
        _ => Err(format!("unknown cloud provider: {provider}")),
    }
}

fn read_secret_value(key: &str) -> Result<String, String> {
    if !secret_key_ok(key) { return Err("invalid secret key".into()); }
    let path = tonyai_dir()?.join(format!("secret-{}.txt", key));
    let v = std::fs::read_to_string(&path).unwrap_or_default();
    let v = v.trim().to_string();
    if v.is_empty() {
        return Err(format!("No API key stored for {key} — add it in ⚙ Search settings"));
    }
    Ok(v)
}

fn cloud_request(provider: &str, url: &str, body: String, timeout_s: u64) -> Result<reqwest::RequestBuilder, String> {
    // Local OpenAI-compatible servers (LM Studio, llama.cpp, vLLM) usually need no key.
    let key = match read_secret_value(provider) { Ok(k) => k, Err(e) if provider == "custom" => { let _ = e; String::new() } Err(e) => return Err(e) };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_s))
        .build().map_err(|e| e.to_string())?;
    let mut req = client.post(url)
        .header("Content-Type", "application/json");
    if !key.is_empty() { req = req.header("Authorization", format!("Bearer {}", key)); }
    if provider == "openrouter" {
        req = req
            .header("HTTP-Referer", "https://github.com/DrVelvetFog/uig-studios-ai")
            .header("X-Title", "UIG Studios AI");
    }
    Ok(req.body(body))
}

/// Accumulates streamed OpenAI tool-call fragments (arguments arrive in pieces).
#[derive(Default)]
struct ToolCallAccum {
    id:   String,
    name: String,
    args: String,
}

/// Translate one SSE `data:` payload into Ollama-shaped ndjson (returned),
/// accumulating tool-call fragments and usage along the way. Pure — testable.
fn translate_sse_data(
    data: &str,
    tool_calls: &mut StdHashMap<u64, ToolCallAccum>,
    usage_line: &mut Option<String>,
) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;

    if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
        *usage_line = Some(format!("{}\n", serde_json::json!({ "cloud_usage": u })));
    }

    let delta = v.pointer("/choices/0/delta")?;

    if let Some(frags) = delta.get("tool_calls").and_then(|t| t.as_array()) {
        for frag in frags {
            let idx = frag.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            let acc = tool_calls.entry(idx).or_default();
            if let Some(id) = frag.get("id").and_then(|i| i.as_str()) {
                if !id.is_empty() { acc.id = id.to_string(); }
            }
            if let Some(name) = frag.pointer("/function/name").and_then(|n| n.as_str()) {
                acc.name.push_str(name);
            }
            if let Some(args) = frag.pointer("/function/arguments").and_then(|a| a.as_str()) {
                acc.args.push_str(args);
            }
        }
    }

    let content = delta.get("content").and_then(|c| c.as_str()).filter(|c| !c.is_empty())?;
    Some(format!("{}\n", serde_json::json!({ "message": { "content": content } })))
}

/// Final chunk for any reassembled tool calls, in Ollama's shape.
fn finalize_tool_calls(tool_calls: &StdHashMap<u64, ToolCallAccum>) -> Option<String> {
    if tool_calls.is_empty() { return None; }
    let mut indices: Vec<&u64> = tool_calls.keys().collect();
    indices.sort();
    let calls: Vec<serde_json::Value> = indices.iter().map(|i| {
        let acc = &tool_calls[i];
        let args: serde_json::Value = serde_json::from_str(&acc.args)
            .unwrap_or(serde_json::Value::String(acc.args.clone()));
        serde_json::json!({
            "id": if acc.id.is_empty() { format!("call_{}", i) } else { acc.id.clone() },
            "function": { "name": acc.name, "arguments": args }
        })
    }).collect();
    Some(format!("{}\n", serde_json::json!({ "message": { "tool_calls": calls } })))
}

#[cfg(test)]
mod mcp_secret_key_tests {
    use super::*;

    #[test]
    fn ordinary_ids_pass_through() {
        assert_eq!(mcp_secret_key("github"), "mcp-github");
        assert_eq!(mcp_secret_key("my-server_2"), "mcp-my-server_2");
    }

    #[test]
    fn path_traversal_cannot_escape_the_secrets_dir() {
        // Server ids come from the user; a raw id here would write outside ~/.tonyai.
        assert_eq!(mcp_secret_key("../../etc/passwd"), "mcp-______etc_passwd");
        assert!(secret_key_ok(&mcp_secret_key("../../etc/passwd")));
    }

    #[test]
    fn every_produced_key_is_accepted_by_the_secret_store() {
        for id in ["a b", "sürüm", "x/y\\z", "", "🙂", "tab\there"] {
            assert!(secret_key_ok(&mcp_secret_key(id)), "rejected key for id {id:?}");
        }
    }
}

#[cfg(test)]
mod cloud_sse_tests {
    use super::*;

    #[test]
    fn translates_content_deltas() {
        let mut tc = StdHashMap::new();
        let mut usage = None;
        let out = translate_sse_data(
            r#"{"choices":[{"delta":{"content":"Hello"}}]}"#, &mut tc, &mut usage,
        ).unwrap();
        let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(v.pointer("/message/content").unwrap(), "Hello");
    }

    #[test]
    fn reassembles_fragmented_tool_calls() {
        let mut tc = StdHashMap::new();
        let mut usage = None;
        // OpenAI streams the call name first, then argument string fragments
        translate_sse_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"list_dir","arguments":""}}]}}]}"#, &mut tc, &mut usage);
        translate_sse_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pa"}}]}}]}"#, &mut tc, &mut usage);
        translate_sse_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"/tmp\"}"}}]}}]}"#, &mut tc, &mut usage);

        let out = finalize_tool_calls(&tc).unwrap();
        let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        let call = &v["message"]["tool_calls"][0];
        assert_eq!(call["id"], "call_abc");
        assert_eq!(call["function"]["name"], "list_dir");
        assert_eq!(call["function"]["arguments"]["path"], "/tmp");
    }

    #[test]
    fn captures_usage_and_ignores_garbage() {
        let mut tc = StdHashMap::new();
        let mut usage = None;
        translate_sse_data(
            r#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.0012}}"#,
            &mut tc, &mut usage,
        );
        assert!(usage.as_deref().unwrap().contains("\"cost\":0.0012"));
        assert!(translate_sse_data("not json", &mut tc, &mut usage).is_none());
        assert!(finalize_tool_calls(&StdHashMap::new()).is_none());
    }
}

/// Streaming chat against a cloud provider. Emits the same
/// "ollama-chunk-{event_id}" / "ollama-done-{event_id}" events as ollama_chat,
/// with chunks translated to Ollama's ndjson message shape. Usage (tokens +
/// cost when the provider reports it) is emitted as a {"cloud_usage": ...} line.
#[tauri::command]
async fn cloud_chat(
    app: AppHandle,
    cancel: State<'_, StreamCancelMap>,
    provider: String,
    body: String,
    event_id: String,
) -> Result<(), String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    cancel.0.lock().unwrap().insert(event_id.clone(), Arc::clone(&cancel_flag));
    struct CancelCleanup<'a>(&'a StreamCancelMap, String);
    impl<'a> Drop for CancelCleanup<'a> {
        fn drop(&mut self) { self.0.0.lock().unwrap().remove(&self.1); }
    }
    let _cleanup = CancelCleanup(&cancel, event_id.clone());

    let (url, _) = cloud_endpoint(&provider)?;
    let response = cloud_request(&provider, &url, body, 600)?
        .send().await
        .map_err(|e| format!("{provider} connection failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("{provider} {}: {}", status, text.chars().take(400).collect::<String>()));
    }

    let mut stream = response.bytes_stream();
    let mut line_buf = String::new();      // partial SSE line carry-over
    let mut out_buf  = String::new();      // translated ndjson awaiting emit
    let mut last_emit = std::time::Instant::now();
    let mut tool_calls: StdHashMap<u64, ToolCallAccum> = StdHashMap::new();
    let mut usage_line: Option<String> = None;

    'outer: while let Some(chunk) = stream.next().await {
        if cancel_flag.load(Ordering::Relaxed) { break; }
        let bytes = chunk.map_err(|e| e.to_string())?;
        line_buf.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(nl) = line_buf.find('\n') {
            let line: String = line_buf.drain(..=nl).collect();
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" { break 'outer; }
            if let Some(ndjson) = translate_sse_data(data, &mut tool_calls, &mut usage_line) {
                out_buf.push_str(&ndjson);
            }
        }

        if !out_buf.is_empty() && (last_emit.elapsed().as_millis() >= 16 || out_buf.len() >= 512) {
            let _ = app.emit(&format!("ollama-chunk-{}", event_id), std::mem::take(&mut out_buf));
            last_emit = std::time::Instant::now();
        }
    }

    // Reassembled tool calls → one Ollama-shaped chunk
    if let Some(calls_line) = finalize_tool_calls(&tool_calls) {
        out_buf.push_str(&calls_line);
    }
    if let Some(u) = usage_line { out_buf.push_str(&u); }
    if !out_buf.is_empty() {
        let _ = app.emit(&format!("ollama-chunk-{}", event_id), out_buf);
    }
    let _ = app.emit(&format!("ollama-done-{}", event_id), "");
    Ok(())
}

/// Non-streaming cloud completion (subagents, compaction summaries).
/// Returns an Ollama-shaped response: {"message":{"content","tool_calls"?},"cloud_usage"?}.
#[tauri::command]
async fn cloud_post(provider: String, body: String) -> Result<String, String> {
    let (url, _) = cloud_endpoint(&provider)?;
    let resp = cloud_request(&provider, &url, body, 300)?
        .send().await
        .map_err(|e| format!("{provider} connection failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("{provider} {}: {}", status, text.chars().take(400).collect::<String>()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let msg = v.pointer("/choices/0/message").cloned().unwrap_or(serde_json::json!({}));

    let mut out_msg = serde_json::json!({
        "content": msg.get("content").and_then(|c| c.as_str()).unwrap_or(""),
    });
    if let Some(calls) = msg.get("tool_calls").and_then(|t| t.as_array()) {
        let converted: Vec<serde_json::Value> = calls.iter().map(|c| {
            let args_str = c.pointer("/function/arguments").and_then(|a| a.as_str()).unwrap_or("{}");
            let args: serde_json::Value = serde_json::from_str(args_str)
                .unwrap_or(serde_json::Value::String(args_str.to_string()));
            serde_json::json!({
                "id": c.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "function": {
                    "name": c.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or(""),
                    "arguments": args
                }
            })
        }).collect();
        out_msg["tool_calls"] = serde_json::Value::Array(converted);
    }

    let mut out = serde_json::json!({ "message": out_msg });
    if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
        out["cloud_usage"] = u.clone();
    }
    Ok(out.to_string())
}

/// List available model ids from a cloud provider (frontend curates the list).
#[tauri::command]
async fn cloud_list_models(provider: String) -> Result<String, String> {
    let url = match provider.as_str() {
        "openrouter" => "https://openrouter.ai/api/v1/models".to_string(),
        "openai"     => "https://api.openai.com/v1/models".to_string(),
        "custom"     => format!("{}/models", custom_endpoint_base()?),
        _ => return Err(format!("unknown cloud provider: {provider}")),
    };
    let key = match read_secret_value(&provider) { Ok(k) => k, Err(_) if provider == "custom" => String::new(), Err(e) => return Err(e) };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build().map_err(|e| e.to_string())?;
    let mut get = client.get(&url);
    if !key.is_empty() { get = get.header("Authorization", format!("Bearer {}", key)); }
    let resp = get.send().await
        .map_err(|e| format!("{provider} models fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{provider} models HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let ids: Vec<String> = v.get("data").and_then(|d| d.as_array())
        .map(|arr| arr.iter()
            .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
            .collect())
        .unwrap_or_default();
    serde_json::to_string(&ids).map_err(|e| e.to_string())
}

// ── Agent tool commands ───────────────────────────────────────────────────────

/// Strip HTML tags, scripts, styles, and comments from a string.
fn strip_html(html: &str) -> String {
    let lower_html = html.to_ascii_lowercase();
    let chars_vec: Vec<(usize, char)> = html.char_indices().collect();
    let n = chars_vec.len();
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0;

    while i < n {
        let (byte_pos, ch) = chars_vec[i];
        if ch != '<' {
            out.push(ch);
            i += 1;
            continue;
        }
        let rest_lower = &lower_html[byte_pos..];
        // HTML comment
        if rest_lower.starts_with("<!--") {
            if let Some(rel) = rest_lower.find("-->") {
                let end_byte = byte_pos + rel + 3;
                while i < n && chars_vec[i].0 < end_byte { i += 1; }
                out.push(' ');
                continue;
            }
        }
        // <script> block
        if rest_lower.len() > 6 && &rest_lower[1..7] == "script" {
            if let Some(rel) = rest_lower.find("</script>") {
                let end_byte = byte_pos + rel + 9;
                while i < n && chars_vec[i].0 < end_byte { i += 1; }
                out.push(' ');
                continue;
            }
        }
        // <style> block
        if rest_lower.len() > 5 && &rest_lower[1..6] == "style" {
            if let Some(rel) = rest_lower.find("</style>") {
                let end_byte = byte_pos + rel + 8;
                while i < n && chars_vec[i].0 < end_byte { i += 1; }
                out.push(' ');
                continue;
            }
        }
        // Regular tag — skip to closing >
        if let Some(rel) = rest_lower.find('>') {
            let end_byte = byte_pos + rel + 1;
            while i < n && chars_vec[i].0 < end_byte { i += 1; }
            out.push(' ');
            continue;
        }
        out.push(ch);
        i += 1;
    }

    // Collapse whitespace
    let mut result = String::new();
    let mut prev_ws = true;
    for ch in out.chars() {
        if ch.is_whitespace() {
            if !prev_ws { result.push(' '); }
            prev_ws = true;
        } else {
            result.push(ch);
            prev_ws = false;
        }
    }

    result
        .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&apos;", "'").replace("&nbsp;", " ")
        .replace("&#39;", "'").replace("&#34;", "\"").replace("&#160;", " ")
}

/// Scrape real search results from DuckDuckGo HTML (no API key required).
fn ddg_html_scrape(html: &str, query: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut results: Vec<String> = Vec::new();
    let mut pos = 0;

    while results.len() < 6 {
        // Each result block contains "result__body"
        let body = match lower[pos..].find("result__body") {
            Some(i) => pos + i,
            None => break,
        };

        // Title: look for result__a after body start
        let ta = match lower[body..].find("result__a") {
            Some(i) => body + i,
            None => { pos = body + 1; continue; }
        };
        let t_open = match html[ta..].find('>') {
            Some(i) => ta + i + 1,
            None => { pos = body + 1; continue; }
        };
        let t_close = match html[t_open..].find("</a>") {
            Some(i) => t_open + i,
            None => { pos = body + 1; continue; }
        };
        let title = strip_html(&html[t_open..t_close]).trim().to_string();

        // URL: result__url span
        let ua = match lower[body..].find("result__url") {
            Some(i) => body + i,
            None => { pos = body + 1; continue; }
        };
        let u_open = match html[ua..].find('>') {
            Some(i) => ua + i + 1,
            None => { pos = body + 1; continue; }
        };
        let u_close = match html[u_open..].find('<') {
            Some(i) => u_open + i,
            None => { pos = body + 1; continue; }
        };
        let url = html[u_open..u_close].trim().to_string();

        // Snippet: result__snippet
        let sa = match lower[body..].find("result__snippet") {
            Some(i) => body + i,
            None => { pos = body + 1; continue; }
        };
        let s_open = match html[sa..].find('>') {
            Some(i) => sa + i + 1,
            None => { pos = body + 1; continue; }
        };
        let s_close = match html[s_open..].find("</a>") {
            Some(i) => s_open + i,
            None => { pos = body + 1; continue; }
        };
        let snippet = strip_html(&html[s_open..s_close]).trim().to_string();

        if !title.is_empty() {
            let display_url = if url.is_empty() { "?".to_string() } else { url };
            results.push(format!("[{}] {}\n    URL: {}\n    {}", results.len() + 1, title, display_url, snippet));
        }
        pos = s_close;
    }

    if results.is_empty() {
        format!("DuckDuckGo returned a page with no parseable results for '{}'. This may mean the query genuinely has no hits, or that the result markup changed — treat the web as UNCHECKED rather than empty. Adding a Serper.dev or Brave API key gives reliable search.", query)
    } else {
        results.join("\n\n")
    }
}

/// Detect DuckDuckGo's rate-limit challenge page.
///
/// This is the trap: DDG serves the "are you a bot" CAPTCHA under **HTTP 202**, which
/// is a 2xx, so `is_success()` is true, the scraper runs against it, finds none of its
/// selectors, and reports "no results". That is a completely different claim from "the
/// search did not run" — and the model reasons from it as fact, answering from stale
/// knowledge while believing it checked. Measured: unkeyed requests start getting 202
/// after a single query.
///
/// We deliberately do NOT try to solve the challenge — defeating bot detection is not
/// something this app does. We just tell the truth about what happened.
fn ddg_is_challenge(status: u16, html: &str) -> bool {
    status == 202
        || html.contains("anomaly-modal")
        || html.contains("Please complete the following challenge")
}

fn ddg_challenge_message(query: &str) -> String {
    format!(
        "SEARCH DID NOT RUN — DuckDuckGo rate-limited this request with a bot challenge. \
         No information about '{}' was retrieved. This is NOT a statement that no results exist: \
         the web is UNCHECKED for this query, so do not answer as though you had searched. \
         Either say the search was blocked, or retry later. \
         A Serper.dev or Brave API key (Settings) avoids this entirely.",
        query
    )
}

/// No-key search via DuckDuckGo HTML, with graceful, descriptive failure.
/// Used both as the no-key path and as the fallback when a keyed provider errors.
async fn ddg_search(client: &reqwest::Client, query: &str) -> String {
    match client
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", query)])
        .header("Accept-Language", "en-US,en;q=0.9")
        .send().await
    {
        Ok(resp) if resp.status().is_success() => {
            let status = resp.status().as_u16();
            match resp.text().await {
                Ok(html) if ddg_is_challenge(status, &html) => ddg_challenge_message(query),
                Ok(html) => ddg_html_scrape(&html, query),
                Err(e)   => format!("SEARCH DID NOT RUN — DuckDuckGo read error: {}. The web is UNCHECKED for '{}'; do not answer as though you had searched.", e, query),
            }
        }
        Ok(resp) => format!("SEARCH DID NOT RUN — DuckDuckGo HTTP {}. The web is UNCHECKED for '{}'; do not answer as though you had searched. Add a Serper.dev or Brave API key for reliable search.", resp.status(), query),
        Err(e)   => format!("SEARCH DID NOT RUN — DuckDuckGo unreachable: {}. The web is UNCHECKED for '{}'; do not answer as though you had searched. Add a Serper.dev or Brave API key for reliable search.", e, query),
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn scrapes_title_url_snippet() {
        let html = r#"
            <div class="result__body">
              <a class="result__a" href="x">Rust Async Book</a>
              <span class="result__url">rust-lang.github.io</span>
              <a class="result__snippet">Learn async Rust here.</a>
            </div>"#;
        let out = ddg_html_scrape(html, "rust async");
        assert!(out.contains("[1] Rust Async Book"), "got: {out}");
        assert!(out.contains("rust-lang.github.io"), "got: {out}");
        assert!(out.contains("Learn async Rust here."), "got: {out}");
    }

    #[test]
    fn empty_html_reports_unchecked_not_empty() {
        let out = ddg_html_scrape("<html><body>nothing here</body></html>", "q");
        // Must not let the model conclude the topic has no results.
        assert!(out.contains("UNCHECKED"), "got: {out}");
    }

    #[test]
    fn http_202_is_treated_as_a_challenge_despite_being_2xx() {
        assert!(ddg_is_challenge(202, "<html>anything</html>"));
        assert!(!ddg_is_challenge(200, "<html>ordinary results</html>"));
    }

    #[test]
    fn challenge_markup_is_caught_even_on_http_200() {
        // Real body observed when rate-limited (DDG served this under 202, but the
        // markers are what actually identify it if the status ever changes).
        let body = r#"<div class="anomaly-modal__body">Please complete the following challenge</div>"#;
        assert!(ddg_is_challenge(200, body));
    }

    #[test]
    fn challenge_message_denies_the_no_results_reading() {
        let m = ddg_challenge_message("sui gas price");
        assert!(m.contains("SEARCH DID NOT RUN"), "got: {m}");
        assert!(m.contains("NOT a statement that no results exist"), "got: {m}");
        assert!(m.contains("sui gas price"), "got: {m}");
    }
}

/// Web search: auto-detects provider from API key format.
/// - Key starts with "BSA" → Brave Search API
/// - Any other non-empty key → Serper.dev (Google results, serper.dev)
/// - No key → DuckDuckGo HTML scrape (no signup required, ~6 results)
/// - SearXNG local: set key to "searxng" and run: docker run -d -p 8080:8080 searxng/searxng
#[tauri::command]
async fn tool_web_search(query: String, brave_api_key: String) -> Result<String, String> {
    let key = brave_api_key.trim().to_string();
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // ── SearXNG local ────────────────────────────────────────────────────────────
    if key == "searxng" {
        let resp = client
            .get("http://localhost:8080/search")
            .query(&[("q", query.as_str()), ("format", "json"), ("language", "en")])
            .send().await
            .map_err(|e| format!("SearXNG not reachable (is it running?): {}", e))?;
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let mut results = Vec::new();
        if let Some(items) = json.get("results").and_then(|r| r.as_array()) {
            for (i, item) in items.iter().take(6).enumerate() {
                let title   = item.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                let url     = item.get("url").and_then(|v| v.as_str()).unwrap_or("?");
                let snippet = item.get("content").and_then(|v| v.as_str()).unwrap_or("");
                results.push(format!("[{}] {}\n    URL: {}\n    {}", i+1, title, url, snippet));
            }
        }
        return Ok(if results.is_empty() { "SearXNG returned no results.".into() } else { results.join("\n\n") });
    }

    // ── Brave Search API (key starts with "BSA") ─────────────────────────────────
    // On any failure (network, HTTP error, quota, empty/unparseable) we degrade to
    // DuckDuckGo rather than hard-failing, so search keeps working.
    if key.starts_with("BSA") {
        if let Ok(resp) = client
            .get("https://api.search.brave.com/res/v1/web/search")
            .query(&[("q", query.as_str()), ("count", "6"), ("text_decorations", "0")])
            .header("Accept", "application/json")
            .header("X-Subscription-Token", key.as_str())
            .send().await
        {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    let mut results = Vec::new();
                    if let Some(items) = json.get("web").and_then(|w| w.get("results")).and_then(|r| r.as_array()) {
                        for (i, item) in items.iter().take(6).enumerate() {
                            let title   = item.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                            let url     = item.get("url").and_then(|v| v.as_str()).unwrap_or("?");
                            let snippet = item.get("description").and_then(|v| v.as_str()).unwrap_or("");
                            results.push(format!("[{}] {}\n    URL: {}\n    {}", i+1, title, url, snippet));
                        }
                    }
                    if !results.is_empty() { return Ok(results.join("\n\n")); }
                }
            }
        }
        return Ok(ddg_search(&client, &query).await);
    }

    // ── Serper.dev (any other non-empty key = Google results) ────────────────────
    // Same graceful-degradation behaviour as Brave.
    if !key.is_empty() {
        let body = serde_json::json!({ "q": query, "num": 6 });
        if let Ok(resp) = client
            .post("https://google.serper.dev/search")
            .header("X-API-KEY", key.as_str())
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send().await
        {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    let mut results = Vec::new();
                    if let Some(items) = json.get("organic").and_then(|r| r.as_array()) {
                        for (i, item) in items.iter().take(6).enumerate() {
                            let title   = item.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                            let url     = item.get("link").and_then(|v| v.as_str()).unwrap_or("?");
                            let snippet = item.get("snippet").and_then(|v| v.as_str()).unwrap_or("");
                            results.push(format!("[{}] {}\n    URL: {}\n    {}", i+1, title, url, snippet));
                        }
                    }
                    if !results.is_empty() { return Ok(results.join("\n\n")); }
                }
            }
        }
        return Ok(ddg_search(&client, &query).await);
    }

    // ── No key: DuckDuckGo ───────────────────────────────────────────────────────
    Ok(ddg_search(&client, &query).await)
}

/// Fetch a URL and return its readable text content (HTML stripped).
#[tauri::command]
async fn tool_fetch_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} fetching {}", resp.status(), url));
    }
    let html = resp.text().await.map_err(|e| e.to_string())?;
    let text = strip_html(&html);
    let chars: Vec<char> = text.chars().collect();
    let limit = 12000;
    if chars.len() > limit {
        Ok(format!("{}\n\n[...truncated at {} chars]", chars[..limit].iter().collect::<String>(), limit))
    } else {
        Ok(text)
    }
}

/// Read a file from disk (home directory only), optionally windowed.
///
/// A long file is returned one `limit`-sized window at a time. The truncation
/// marker names the exact `offset` that continues the read — without it the model
/// only learns that it saw *some* prefix, and silently reasons over a partial file.
const READ_FILE_WINDOW: usize = 20000;

#[tauri::command]
fn tool_read_file(path: String, offset: Option<usize>, limit: Option<usize>) -> Result<String, String> {
    let home = home_dir_var().unwrap_or_default();
    let allowed_prefixes = [home.as_str(), "/tmp"];
    if !allowed_prefixes.iter().any(|p| path.starts_with(p)) {
        return Err(format!("Access denied: only files under $HOME or /tmp are readable"));
    }
    let p = std::path::Path::new(&path);
    if !p.exists() { return Err(format!("Not found: {}", path)); }
    if p.is_dir()  { return Err(format!("'{}' is a directory — use list_dir instead", path)); }
    let content = std::fs::read_to_string(p).map_err(|e| e.to_string())?;

    // Char-indexed (not byte-indexed) so an offset can never split a UTF-8 sequence.
    let chars: Vec<char> = content.chars().collect();
    let total  = chars.len();
    let start  = offset.unwrap_or(0);
    let window = limit.unwrap_or(READ_FILE_WINDOW).clamp(1, 200_000);

    if start >= total && total > 0 {
        return Ok(format!("[offset {} is past the end of {} — the file is {} chars]", start, path, total));
    }
    let end   = start.saturating_add(window).min(total);
    let slice: String = chars[start..end].iter().collect();

    let mut out = String::new();
    if start > 0 {
        out.push_str(&format!("[resuming {} at char {} of {}]\n\n", path, start, total));
    }
    out.push_str(&slice);
    if end < total {
        out.push_str(&format!(
            "\n\n[...truncated at char {} — {} of {} chars remain. Continue with read_file(path, offset={})]",
            end, total - end, total, end
        ));
    }
    Ok(out)
}

/// Return the current user's home directory.
#[tauri::command]
fn get_home_dir() -> String {
    home_dir_var().unwrap_or_default()
}

/// Hardware facts for model-fit estimation: total RAM + chip name.
#[tauri::command]
fn get_hardware_info() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let read_sysctl = |key: &str| -> String {
            std::process::Command::new("sysctl")
                .args(["-n", key])
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default()
        };
        let ram_bytes: u64 = read_sysctl("hw.memsize").parse().unwrap_or(0);
        let chip = read_sysctl("machdep.cpu.brand_string");
        Ok(serde_json::json!({ "ram_bytes": ram_bytes, "chip": chip }).to_string())
    }
    #[cfg(windows)]
    {
        let read_ps = |query: &str| -> String {
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", query])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default()
        };
        let ram_bytes: u64 = read_ps("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory")
            .parse().unwrap_or(0);
        let chip = read_ps("(Get-CimInstance Win32_Processor).Name");
        Ok(serde_json::json!({ "ram_bytes": ram_bytes, "chip": chip }).to_string())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Ok(serde_json::json!({ "ram_bytes": 0u64, "chip": "" }).to_string())
    }
}

/// Search file contents by regex pattern across a directory tree (grep -rn style).
/// Returns matching lines as "path:line_num: content". Skips binary files,
/// node_modules, .git, target, and files > 512 KB.
#[tauri::command]
fn tool_search_files(
    dir: String,
    pattern: String,
    extensions: Option<String>, // comma-separated, e.g. "py,ts,js" — all text files if omitted
    max_results: Option<usize>,
) -> Result<String, String> {
    use regex::Regex;
    use std::path::PathBuf;

    let home = home_dir_var().unwrap_or_default();
    if !dir.starts_with(&home) && !dir.starts_with("/tmp") {
        return Err("Access denied: only dirs under $HOME are searchable".into());
    }

    let re = Regex::new(&pattern)
        .map_err(|e| format!("Invalid regex pattern '{}': {}", pattern, e))?;

    let ext_filter: Option<Vec<String>> = extensions.map(|s| {
        s.split(',')
            .map(|e| e.trim().trim_start_matches('.').to_lowercase())
            .filter(|e| !e.is_empty())
            .collect()
    });

    let max = max_results.unwrap_or(60).min(200);

    // Directories to skip entirely — avoids multi-GB scans
    const SKIP_DIRS: &[&str] = &[
        "node_modules", ".git", "target", "__pycache__", ".venv", "venv",
        "dist", "build", ".next", ".turbo", "coverage", ".cache",
    ];

    let mut results: Vec<String> = Vec::new();
    let mut files_searched: u32 = 0;

    // Iterative DFS — avoids stack overflow on deep trees
    let mut stack: Vec<PathBuf> = vec![PathBuf::from(&dir)];

    'outer: while let Some(current) = stack.pop() {
        let read = match std::fs::read_dir(&current) {
            Ok(r)  => r,
            Err(_) => continue,
        };

        let mut subdirs: Vec<PathBuf> = Vec::new();

        for entry in read.flatten() {
            let p = entry.path();
            let name = p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            if p.is_dir() {
                if !SKIP_DIRS.contains(&name) {
                    subdirs.push(p);
                }
                continue;
            }

            // Extension filter
            if let Some(ref exts) = ext_filter {
                let file_ext = p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .unwrap_or_default();
                if !exts.contains(&file_ext) {
                    continue;
                }
            }

            // Skip large files (> 512 KB)
            if let Ok(meta) = std::fs::metadata(&p) {
                if meta.len() > 524_288 { continue; }
            }

            // read_to_string fails on binary files — use that as binary detection
            let content = match std::fs::read_to_string(&p) {
                Ok(c)  => c,
                Err(_) => continue,
            };

            files_searched += 1;

            // Make path relative to the search root for compact output
            let display = p.strip_prefix(&dir)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|_| p.to_string_lossy().to_string());

            for (idx, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    let trimmed = line.trim();
                    let snippet = if trimmed.len() > 200 { &trimmed[..200] } else { trimmed };
                    results.push(format!("{}:{}: {}", display, idx + 1, snippet));
                    if results.len() >= max {
                        break 'outer;
                    }
                }
            }
        }

        // Push subdirs in reverse-sorted order so they process alphabetically
        subdirs.sort();
        for d in subdirs.into_iter().rev() {
            stack.push(d);
        }
    }

    if results.is_empty() {
        return Ok(format!("No matches for '{}' in {}", pattern, dir));
    }

    let truncated = results.len() >= max;
    let summary = format!(
        "\n[{} match{} across {} file{} searched{}]",
        results.len(),
        if results.len() == 1 { "" } else { "es" },
        files_searched,
        if files_searched == 1 { "" } else { "s" },
        if truncated { " — truncated at limit" } else { "" }
    );
    results.push(summary);
    Ok(results.join("\n"))
}

/// Write content to a file (home directory or /tmp only).
/// Creates parent directories if they don't exist.
#[tauri::command]
fn tool_write_file(path: String, content: String) -> Result<String, String> {
    let home = home_dir_var().unwrap_or_default();
    let allowed_prefixes = [home.as_str(), "/tmp"];
    if !allowed_prefixes.iter().any(|p| path.starts_with(p)) {
        return Err("Access denied: only files under $HOME or /tmp are writable".into());
    }
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir -p failed: {e}"))?;
    }
    std::fs::write(p, &content).map_err(|e| e.to_string())?;
    Ok(format!("Written {} bytes to {}", content.len(), path))
}

/// Surgical search/replace edit on an existing file (home directory or /tmp only).
/// old_string must match the file content exactly. If it matches more than once,
/// the edit is rejected unless replace_all is set — prevents ambiguous edits.
#[tauri::command]
fn tool_edit_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<String, String> {
    let home = home_dir_var().unwrap_or_default();
    let allowed_prefixes = [home.as_str(), "/tmp"];
    if !allowed_prefixes.iter().any(|p| path.starts_with(p)) {
        return Err("Access denied: only files under $HOME or /tmp are editable".into());
    }
    if old_string.is_empty() {
        return Err("old_string is empty — provide the exact text to replace".into());
    }
    if old_string == new_string {
        return Err("old_string and new_string are identical — nothing to change".into());
    }
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Not found: {} — use write_file to create new files", path));
    }
    let content = std::fs::read_to_string(p)
        .map_err(|e| format!("Cannot read {}: {}", path, e))?;
    let count = content.matches(&old_string).count();
    if count == 0 {
        return Err(format!(
            "old_string not found in {}. Read the file first and copy the exact text, including whitespace and indentation.",
            path
        ));
    }
    let all = replace_all.unwrap_or(false);
    if count > 1 && !all {
        return Err(format!(
            "old_string matches {} times in {} — include more surrounding lines to make it unique, or set replace_all=true to change every occurrence.",
            count, path
        ));
    }
    let updated = if all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };
    std::fs::write(p, &updated).map_err(|e| e.to_string())?;
    let n = if all { count } else { 1 };
    Ok(format!("Replaced {} occurrence{} in {}", n, if n == 1 { "" } else { "s" }, path))
}

#[cfg(test)]
mod read_file_tests {
    use super::*;

    fn tmp_file(name: &str, content: &str) -> String {
        let path = format!("/tmp/tonyai_test_{}", name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn short_file_returns_bare_content_with_no_markers() {
        let p = tmp_file("read_short.txt", "alpha\nbeta\n");
        let r = tool_read_file(p, None, None).unwrap();
        assert_eq!(r, "alpha\nbeta\n");
    }

    #[test]
    fn truncation_marker_names_the_resuming_offset() {
        let p = tmp_file("read_long.txt", &"x".repeat(50));
        let r = tool_read_file(p, None, Some(20)).unwrap();
        assert!(r.starts_with(&"x".repeat(20)));
        assert!(r.contains("30 of 50 chars remain"), "{r}");
        assert!(r.contains("offset=20"), "{r}");
    }

    #[test]
    fn offset_resumes_exactly_where_the_previous_window_stopped() {
        let p = tmp_file("read_resume.txt", "0123456789");
        let first  = tool_read_file(p.clone(), None, Some(4)).unwrap();
        let second = tool_read_file(p, Some(4), Some(4)).unwrap();
        assert!(first.starts_with("0123"));
        assert!(second.contains("4567"), "{second}");
        assert!(second.contains("at char 4 of 10"), "{second}");
    }

    #[test]
    fn final_window_carries_no_truncation_marker() {
        let p = tmp_file("read_tail.txt", "0123456789");
        let r = tool_read_file(p, Some(8), Some(4)).unwrap();
        assert!(r.ends_with("89"), "{r}");
        assert!(!r.contains("truncated"), "{r}");
    }

    #[test]
    fn offset_past_eof_explains_itself_instead_of_returning_empty() {
        let p = tmp_file("read_past.txt", "short");
        let r = tool_read_file(p, Some(999), None).unwrap();
        assert!(r.contains("past the end"), "{r}");
        assert!(r.contains("5 chars"), "{r}");
    }

    #[test]
    fn multibyte_content_is_split_on_char_boundaries() {
        // Byte-indexing "日本語テキスト" at 4 would panic mid-sequence; char-indexing must not.
        let p = tmp_file("read_utf8.txt", "日本語テキスト");
        let r = tool_read_file(p, Some(2), Some(2)).unwrap();
        assert!(r.contains("語テ"), "{r}");
    }
}

#[cfg(test)]
mod edit_file_tests {
    use super::*;

    fn tmp_file(name: &str, content: &str) -> String {
        let path = format!("/tmp/tonyai_test_{}", name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn replaces_unique_match() {
        let p = tmp_file("unique.txt", "alpha\nbeta\ngamma\n");
        let r = tool_edit_file(p.clone(), "beta".into(), "BETA".into(), None);
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "alpha\nBETA\ngamma\n");
    }

    #[test]
    fn rejects_ambiguous_match() {
        let p = tmp_file("ambig.txt", "x\nx\n");
        let r = tool_edit_file(p, "x".into(), "y".into(), None);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("2 times"));
    }

    #[test]
    fn replace_all_changes_every_occurrence() {
        let p = tmp_file("all.txt", "x\nx\n");
        let r = tool_edit_file(p.clone(), "x".into(), "y".into(), Some(true));
        assert!(r.is_ok());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "y\ny\n");
    }

    #[test]
    fn rejects_missing_old_string() {
        let p = tmp_file("missing.txt", "hello\n");
        let r = tool_edit_file(p, "nope".into(), "y".into(), None);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("not found"));
    }

    #[test]
    fn rejects_path_outside_home_and_tmp() {
        let r = tool_edit_file("/etc/hosts".into(), "a".into(), "b".into(), None);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("Access denied"));
    }
}

/// List contents of a directory (home directory only).
#[tauri::command]
fn tool_list_dir(path: String) -> Result<String, String> {
    let home = home_dir_var().unwrap_or_default();
    if !path.starts_with(&home) && !path.starts_with("/tmp") {
        return Err("Access denied: only dirs under $HOME are listable".into());
    }
    let mut entries: Vec<String> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
            if p.is_dir() { format!("{}/", name) } else { name }
        })
        .collect();
    entries.sort();
    Ok(entries.join("\n"))
}

/// Save a base64-encoded PNG image plus a JSON sidecar to ~/TonyAI-Images/<subdir>/
/// Returns the full saved path, e.g. "/Users/tony/TonyAI-Images/2026-05-29/143022_neon-city.png"
#[tauri::command]
fn save_generated_image(
    base64: String,
    filename_stem: String,
    subdir: String,
    meta_json: String,
) -> Result<String, String> {
    use std::io::Write;

    let home = home_dir_var()?;

    // Sanitise inputs — no path traversal
    let safe_subdir = subdir.replace(['/', '\\', '.'], "-");
    let safe_stem   = filename_stem.replace(['/', '\\'], "-");

    let dir = std::path::PathBuf::from(&home)
        .join(USER_ROOT).join("Images")
        .join(&safe_subdir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;

    // Decode base64 (strip data URI prefix if present)
    let b64_data = if let Some(pos) = base64.find(',') {
        base64[pos + 1..].trim().to_string()
    } else {
        base64.trim().to_string()
    };
    use ::base64::{Engine as _, engine::general_purpose::STANDARD};
    let png_bytes = STANDARD.decode(&b64_data)
        .map_err(|e| format!("base64 decode error: {e}"))?;

    // Write PNG
    let png_path = dir.join(format!("{safe_stem}.png"));
    let mut f = std::fs::File::create(&png_path).map_err(|e| e.to_string())?;
    f.write_all(&png_bytes).map_err(|e| e.to_string())?;

    // Write JSON sidecar
    let json_path = dir.join(format!("{safe_stem}.json"));
    std::fs::write(&json_path, &meta_json).map_err(|e| e.to_string())?;

    Ok(png_path.to_string_lossy().to_string())
}

/// Open a file or folder in Finder (macOS open command).
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let home = home_dir_var().unwrap_or_default();
    // Only allow paths under HOME for safety
    if !path.starts_with(&home) && !path.starts_with("/tmp") {
        return Err("Access denied".into());
    }
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(windows)]
    let opener = "explorer";
    #[cfg(not(any(target_os = "macos", windows)))]
    let opener = "xdg-open";
    std::process::Command::new(opener)
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Git-native tools (read-only) ─────────────────────────────────────────────
// Write ops (commit/push/reset/checkout) intentionally NOT included — those
// must go through tool_run_command which has the permission gate.

async fn run_git(args: Vec<&str>, repo_path: &str) -> Result<String, String> {
    let home = home_dir_var().unwrap_or_default();
    if !repo_path.starts_with(&home) && !repo_path.starts_with("/tmp") {
        return Err("Access denied: repo must be under $HOME or /tmp".into());
    }
    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(repo_path);
    for a in &args { cmd.arg(a); }
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        cmd.output(),
    ).await
    .map_err(|_| "git timed out after 15s".to_string())?
    .map_err(|e| format!("git failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&result.stdout).to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).to_string();
    let code   = result.status.code().unwrap_or(-1);
    if code != 0 {
        return Err(format!("git {} failed [{}]: {}", args.join(" "), code, stderr.trim()));
    }

    // Cap output at 6000 chars
    let chars: Vec<char> = stdout.chars().collect();
    Ok(if chars.len() > 6000 {
        chars[..6000].iter().collect::<String>() + "\n[...truncated]"
    } else {
        stdout
    })
}

/// Compact git status: branch + ahead/behind + staged/unstaged/untracked file lists.
#[tauri::command]
async fn tool_git_status(repo_path: String) -> Result<String, String> {
    // Branch + tracking info
    let branch = run_git(vec!["status", "--branch", "--short"], &repo_path).await?;
    let mut out = format!("=== Status ===\n{}", branch.trim());

    // Stash count for awareness
    if let Ok(stash) = run_git(vec!["stash", "list"], &repo_path).await {
        let n = stash.lines().count();
        if n > 0 { out.push_str(&format!("\n\n=== Stashes: {} ===\n{}", n, stash.trim())); }
    }
    Ok(out)
}

/// Show git diff. Optionally for staged changes only.
#[tauri::command]
async fn tool_git_diff(repo_path: String, staged: Option<bool>, file: Option<String>) -> Result<String, String> {
    let mut args = vec!["diff", "--no-color"];
    if staged.unwrap_or(false) { args.push("--staged"); }
    if let Some(ref f) = file { args.push(f); }
    let diff = run_git(args, &repo_path).await?;
    Ok(if diff.trim().is_empty() {
        format!("No {}changes.", if staged.unwrap_or(false) { "staged " } else { "" })
    } else {
        diff
    })
}

/// Recent commit history, one-line format.
#[tauri::command]
async fn tool_git_log(repo_path: String, max_count: Option<u32>, file: Option<String>) -> Result<String, String> {
    let max = max_count.unwrap_or(15).min(100).to_string();
    let mut args = vec!["log", "--oneline", "--decorate", "-n", &max];
    if let Some(ref f) = file { args.push("--"); args.push(f); }
    run_git(args, &repo_path).await
}

/// Git blame for a file, optionally limited to a line range.
#[tauri::command]
async fn tool_git_blame(repo_path: String, file: String, line_start: Option<u32>, line_end: Option<u32>) -> Result<String, String> {
    let mut args: Vec<String> = vec!["blame".into(), "--no-color".into()];
    if let (Some(s), Some(e)) = (line_start, line_end) {
        args.push("-L".into());
        args.push(format!("{},{}", s, e));
    }
    args.push(file);
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(args_ref, &repo_path).await
}

/// Execute Python code in a sandboxed environment (~/UIG-AI/Sandbox/).
/// - Code runs in an isolated directory, not the user's project tree
/// - Optional pip packages auto-installed into a dedicated venv on first use
/// - Configurable timeout (default 60s, max 300s)
/// - Output capped at 8KB
/// - Each invocation gets a unique filename (timestamp + counter)
#[tauri::command]
async fn tool_python_exec(
    code: String,
    packages: Option<String>,    // comma-separated pip packages (optional)
    timeout_seconds: Option<u64>,
) -> Result<String, String> {
    let home = home_dir_var()?;
    let sandbox = std::path::PathBuf::from(&home).join(USER_ROOT).join("Sandbox");
    std::fs::create_dir_all(&sandbox).map_err(|e| format!("mkdir sandbox: {e}"))?;

    let venv_dir = sandbox.join(".venv");
    #[cfg(not(windows))]
    let (venv_bin, py_exe, pip_exe, sys_python) = ("bin", "python3", "pip", "python3");
    #[cfg(windows)]
    let (venv_bin, py_exe, pip_exe, sys_python) = ("Scripts", "python.exe", "pip.exe", "python");
    let venv_python = venv_dir.join(venv_bin).join(py_exe);
    let venv_pip = venv_dir.join(venv_bin).join(pip_exe);

    // Bootstrap venv on first use
    if !venv_python.exists() {
        let bootstrap = tokio::process::Command::new(sys_python)
            .arg("-m").arg("venv").arg(&venv_dir)
            .output().await
            .map_err(|e| format!("venv bootstrap failed: {e}"))?;
        if !bootstrap.status.success() {
            return Err(format!("Could not create venv: {}",
                String::from_utf8_lossy(&bootstrap.stderr)));
        }
    }

    // Install requested pip packages (if any)
    if let Some(pkgs) = packages.as_ref().filter(|s| !s.trim().is_empty()) {
        let pkg_list: Vec<&str> = pkgs.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        if !pkg_list.is_empty() {
            let mut cmd = tokio::process::Command::new(&venv_pip);
            cmd.arg("install").arg("--quiet").arg("--disable-pip-version-check");
            for p in &pkg_list { cmd.arg(p); }
            let install = tokio::time::timeout(
                std::time::Duration::from_secs(120),
                cmd.output(),
            ).await.map_err(|_| "pip install timed out".to_string())?
              .map_err(|e| format!("pip exec failed: {e}"))?;
            if !install.status.success() {
                return Err(format!("pip install failed:\n{}",
                    String::from_utf8_lossy(&install.stderr)));
            }
        }
    }

    // Write code to a unique file in the sandbox
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let script_path = sandbox.join(format!("run_{ts}.py"));
    std::fs::write(&script_path, &code)
        .map_err(|e| format!("write script: {e}"))?;

    let timeout_s = timeout_seconds.unwrap_or(60).min(300);

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_s),
        tokio::process::Command::new(&venv_python)
            .arg(&script_path)
            .current_dir(&sandbox)
            .output(),
    ).await
    .map_err(|_| format!("Python execution timed out after {timeout_s}s"))?
    .map_err(|e| format!("Failed to run python: {}", e))?;

    let stdout = String::from_utf8_lossy(&result.stdout).to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).to_string();
    let code_n = result.status.code().unwrap_or(-1);

    let mut out = String::new();
    out.push_str(&format!("Script: {}\n", script_path.display()));
    if !stdout.trim().is_empty() { out.push_str(&format!("STDOUT:\n{}\n", stdout.trim())); }
    if !stderr.trim().is_empty() { out.push_str(&format!("STDERR:\n{}\n", stderr.trim())); }
    out.push_str(&format!("[exit {}]", code_n));

    let chars: Vec<char> = out.chars().collect();
    Ok(if chars.len() > 8000 {
        chars[..8000].iter().collect::<String>() + "\n[...truncated]"
    } else {
        out
    })
}

/// Run a shell command and return its output.
/// timeout_seconds: default 30, max 600 — raise it for builds / test suites.
#[tauri::command]
async fn tool_run_command(command: String, timeout_seconds: Option<u64>) -> Result<String, String> {
    let timeout_s = timeout_seconds.unwrap_or(30).clamp(1, 600);
    #[cfg(not(windows))]
    let mut shell = {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(&command);
        c
    };
    #[cfg(windows)]
    let mut shell = {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(&command);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_s),
        shell.output(),
    ).await
    .map_err(|_| format!("Command timed out after {}s. For servers or watch tasks use run_background instead; for long builds pass a larger timeout_seconds (max 600).", timeout_s))?
    .map_err(|e| format!("Failed to run command: {}", e))?;

    let stdout = String::from_utf8_lossy(&result.stdout).to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).to_string();
    let code   = result.status.code().unwrap_or(-1);

    let mut out = String::new();
    if !stdout.trim().is_empty() { out.push_str(stdout.trim()); }
    if !stderr.trim().is_empty() { out.push_str(&format!("\nSTDERR: {}", stderr.trim())); }
    out.push_str(&format!("\n[exit {}]", code));

    let chars: Vec<char> = out.chars().collect();
    Ok(if chars.len() > 8000 {
        chars[..8000].iter().collect::<String>() + "\n[...truncated]"
    } else {
        out
    })
}

// ── Per-project instructions (TONYAI.md) ─────────────────────────────────────
// Walk up from a path the agent is working in, looking for a TONYAI.md file —
// standing instructions for that project (conventions, run commands, gotchas).
// Returns {"path": ..., "content": ...} as JSON, or "null" when none found.

#[tauri::command]
fn find_project_instructions(path: String) -> Result<String, String> {
    let home = home_dir_var().unwrap_or_default();
    if home.is_empty() || (!path.starts_with(&home) && !path.starts_with("/tmp")) {
        return Ok("null".into());
    }
    let mut dir = PathBuf::from(&path);
    if dir.is_file() || dir.extension().is_some() { dir.pop(); }

    let home_path = PathBuf::from(&home);
    loop {
        let candidate = if dir.join("UIGAI.md").exists() { dir.join("UIGAI.md") } else { dir.join("TONYAI.md") };
        if candidate.is_file() {
            let mut content = std::fs::read_to_string(&candidate).unwrap_or_default();
            if content.chars().count() > 8000 {
                content = content.chars().take(8000).collect::<String>() + "\n[...truncated]";
            }
            let json = serde_json::json!({
                "path": candidate.to_string_lossy(),
                "content": content,
            });
            return Ok(json.to_string());
        }
        // Stop after checking the home dir / tmp root themselves
        if dir == home_path || dir == PathBuf::from("/tmp") { break; }
        if !dir.pop() { break; }
    }
    Ok("null".into())
}

#[cfg(test)]
mod project_instructions_tests {
    use super::*;

    #[test]
    fn finds_tonyai_md_walking_up() {
        let root = format!("/tmp/tonyai_proj_test_{}", std::process::id());
        let sub  = format!("{root}/src/deep");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(format!("{root}/TONYAI.md"), "Use tabs. Run `make test`.").unwrap();

        let raw = find_project_instructions(format!("{sub}/main.py")).unwrap();
        assert_ne!(raw, "null");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(v["path"].as_str().unwrap().ends_with("TONYAI.md"));
        assert!(v["content"].as_str().unwrap().contains("make test"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn returns_null_when_absent_or_out_of_bounds() {
        assert_eq!(find_project_instructions("/tmp".into()).unwrap_or_default().len() <= 4, true);
        assert_eq!(find_project_instructions("/etc/hosts".into()).unwrap(), "null");
    }
}

// ── File checkpoints (agent-turn rewind) ─────────────────────────────────────
// Before the agent mutates a file, snapshot the original under
// ~/.tonyai/checkpoints/<turn_id>/. A manifest maps backups to original paths
// so one revert call restores every file the turn touched (and deletes files
// the turn created). Keeps the most recent 20 turn checkpoints.

fn checkpoints_dir() -> Result<PathBuf, String> {
    Ok(tonyai_dir()?.join("checkpoints"))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CheckpointEntry {
    path:   String,           // original absolute path
    action: String,           // "modified" | "created"
    backup: Option<String>,   // backup filename inside the checkpoint dir
}

fn read_manifest(dir: &std::path::Path) -> Vec<CheckpointEntry> {
    std::fs::read_to_string(dir.join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &std::path::Path, entries: &[CheckpointEntry]) -> Result<(), String> {
    let json = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("manifest.json"), json).map_err(|e| e.to_string())
}

fn prune_checkpoints(base: &std::path::Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    let mut dirs: Vec<PathBuf> = entries.flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort(); // turn ids are ckpt_<millis> — lexicographic == chronological
    while dirs.len() > keep {
        let oldest = dirs.remove(0);
        let _ = std::fs::remove_dir_all(oldest);
    }
}

fn ckpt_id_ok(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Snapshot `path` into checkpoint `turn_id` before it gets mutated.
/// Idempotent per (turn_id, path) — only the first call snapshots.
#[tauri::command]
fn checkpoint_file(turn_id: String, path: String) -> Result<String, String> {
    if !ckpt_id_ok(&turn_id) { return Err("invalid checkpoint id".into()); }
    let home = home_dir_var().unwrap_or_default();
    if !path.starts_with(&home) && !path.starts_with("/tmp") {
        return Err("Access denied: only files under $HOME or /tmp are checkpointable".into());
    }

    let base = checkpoints_dir()?;
    let dir  = base.join(&turn_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut entries = read_manifest(&dir);
    if entries.iter().any(|e| e.path == path) {
        return Ok("already checkpointed".into());
    }

    let src = std::path::Path::new(&path);
    if src.exists() {
        let backup_name = format!("{}.bak", entries.len());
        std::fs::copy(src, dir.join(&backup_name))
            .map_err(|e| format!("backup copy failed: {e}"))?;
        entries.push(CheckpointEntry { path, action: "modified".into(), backup: Some(backup_name) });
    } else {
        entries.push(CheckpointEntry { path, action: "created".into(), backup: None });
    }
    write_manifest(&dir, &entries)?;
    prune_checkpoints(&base, 20);
    Ok("checkpointed".into())
}

/// Restore every file recorded in checkpoint `turn_id` to its pre-turn state.
#[tauri::command]
fn checkpoint_revert(turn_id: String) -> Result<String, String> {
    if !ckpt_id_ok(&turn_id) { return Err("invalid checkpoint id".into()); }
    let dir = checkpoints_dir()?.join(&turn_id);
    if !dir.exists() { return Err(format!("Checkpoint {} not found (pruned?)", turn_id)); }

    let entries = read_manifest(&dir);
    if entries.is_empty() { return Err("Checkpoint has no recorded files".into()); }

    let mut restored = 0usize;
    let mut deleted  = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for e in &entries {
        match (e.action.as_str(), &e.backup) {
            ("modified", Some(b)) => {
                match std::fs::copy(dir.join(b), &e.path) {
                    Ok(_)  => restored += 1,
                    Err(err) => failures.push(format!("{}: {}", e.path, err)),
                }
            }
            ("created", _) => {
                match std::fs::remove_file(&e.path) {
                    Ok(_) => deleted += 1,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => deleted += 1,
                    Err(err) => failures.push(format!("{}: {}", e.path, err)),
                }
            }
            _ => failures.push(format!("{}: malformed manifest entry", e.path)),
        }
    }

    let mut msg = format!("Reverted: {} file(s) restored, {} created file(s) removed", restored, deleted);
    if !failures.is_empty() {
        msg.push_str(&format!("; {} failure(s): {}", failures.len(), failures.join("; ")));
    }
    Ok(msg)
}

#[cfg(test)]
mod checkpoint_tests {
    use super::*;

    #[test]
    fn checkpoint_and_revert_modified_and_created() {
        let id = format!("ckpt_test_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let modified = format!("/tmp/tonyai_ckpt_mod_{id}.txt");
        let created  = format!("/tmp/tonyai_ckpt_new_{id}.txt");

        std::fs::write(&modified, "original").unwrap();

        // Snapshot before mutation
        checkpoint_file(id.clone(), modified.clone()).unwrap();
        checkpoint_file(id.clone(), created.clone()).unwrap(); // doesn't exist yet → "created"

        // Idempotent per path
        assert_eq!(checkpoint_file(id.clone(), modified.clone()).unwrap(), "already checkpointed");

        // Mutate
        std::fs::write(&modified, "agent overwrote this").unwrap();
        std::fs::write(&created, "agent made this").unwrap();

        // Revert
        let msg = checkpoint_revert(id.clone()).unwrap();
        assert!(msg.contains("1 file(s) restored"), "{msg}");
        assert!(msg.contains("1 created file(s) removed"), "{msg}");
        assert_eq!(std::fs::read_to_string(&modified).unwrap(), "original");
        assert!(!std::path::Path::new(&created).exists());

        // Cleanup
        let _ = std::fs::remove_file(&modified);
        let _ = std::fs::remove_dir_all(checkpoints_dir().unwrap().join(&id));
    }

    #[test]
    fn rejects_bad_ids_and_paths() {
        assert!(checkpoint_file("../evil".into(), "/tmp/x".into()).is_err());
        assert!(checkpoint_file("ok_id".into(), "/etc/hosts".into()).is_err());
        assert!(checkpoint_revert("does_not_exist_xyz".into()).is_err());
    }
}

// ── Background process registry ──────────────────────────────────────────────
// Long-running commands (dev servers, builds, watch tasks) that outlive the
// 30s run_command window. Each process gets a capped output buffer fed by
// reader tasks; status checks reap exited children via try_wait().

const BG_OUTPUT_CAP: usize = 64_000; // chars kept per process (tail wins)

struct BgProcess {
    command:   String,
    pid:       u32, // process-group leader (spawned with process_group(0), so pgid == pid)
    output:    Arc<std::sync::Mutex<String>>,
    exit_code: Arc<std::sync::Mutex<Option<i32>>>,
    child:     Arc<TokioMutex<Option<tokio::process::Child>>>,
    started:   std::time::SystemTime,
}

pub struct ProcessManager {
    procs: Arc<TokioMutex<StdHashMap<String, BgProcess>>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self { procs: Arc::new(TokioMutex::new(StdHashMap::new())) }
    }
}

// ── Process-group signalling ──────────────────────────────────────────────────
// Each background command runs as the leader of its own process group, so one
// signal to -pgid reaches the wrapper shell AND everything it forked (npm
// scripts, dev-server workers, …) — no surviving grandchildren.

#[cfg(unix)]
fn signal_group(pid: u32, sig: i32) {
    if pid == 0 { return; } // never signal our own group
    unsafe { libc::kill(-(pid as i32), sig); }
}

#[cfg(unix)]
async fn kill_group_graceful(pid: u32) {
    signal_group(pid, libc::SIGTERM);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    signal_group(pid, libc::SIGKILL);
}

// Windows has no process groups in the unix sense; `taskkill /T` walks the
// child tree instead, which is the same end: no surviving grandchildren.
#[cfg(windows)]
async fn kill_group_graceful(pid: u32) {
    if pid == 0 { return; }
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output();
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 { return false; }
    #[cfg(unix)]
    { unsafe { libc::kill(pid as i32, 0) == 0 } }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
            .unwrap_or(false)
    }
}

/// Guard against PID reuse: confirm `pid` is still running (a prefix of) the
/// command we recorded before treating it as our orphan.
fn pid_runs_command(pid: u32, command: &str) -> bool {
    #[cfg(unix)]
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output();
    #[cfg(windows)]
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command",
            &format!("(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine")])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output();
    let Ok(out) = out else { return false };
    let ps_cmd = String::from_utf8_lossy(&out.stdout);
    let prefix: String = command.chars().take(40).collect();
    let prefix = prefix.trim();
    !prefix.is_empty() && ps_cmd.contains(prefix)
}

// ── Persistent process registry (~/.tonyai/processes.json) ───────────────────
// Mirror of the in-memory registry, so a restart can find processes the
// previous instance left running (crash, force-quit) and offer to kill them.

fn proc_registry_path() -> Result<PathBuf, String> {
    Ok(tonyai_dir()?.join("processes.json"))
}

fn load_proc_registry() -> StdHashMap<String, serde_json::Value> {
    proc_registry_path().ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_proc_registry(map: &StdHashMap<String, serde_json::Value>) {
    if let Ok(p) = proc_registry_path() {
        let _ = std::fs::write(p, serde_json::to_string(map).unwrap_or_else(|_| "{}".into()));
    }
}

fn registry_add(id: &str, pid: u32, command: &str) {
    let mut map = load_proc_registry();
    map.insert(id.to_string(), serde_json::json!({
        "pid": pid,
        "command": command,
        "started_epoch": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
    }));
    save_proc_registry(&map);
}

fn registry_remove(id: &str) {
    let mut map = load_proc_registry();
    if map.remove(id).is_some() {
        save_proc_registry(&map);
    }
}

/// Called once at JS bootstrap: prune dead registry entries, return live
/// orphans (processes a previous app instance started and never killed).
#[tauri::command]
fn reconcile_orphan_processes() -> Result<String, String> {
    let map = load_proc_registry();
    let mut kept = StdHashMap::new();
    let mut orphans = Vec::new();
    for (id, v) in map {
        let pid = v.get("pid").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
        let command = v.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string();
        if pid_alive(pid) && pid_runs_command(pid, &command) {
            orphans.push(serde_json::json!({
                "id": id, "pid": pid, "command": command,
                "started_epoch": v.get("started_epoch").cloned().unwrap_or(serde_json::json!(0)),
            }));
            kept.insert(id, v);
        }
        // dead or reused pid → drop from the registry
    }
    save_proc_registry(&kept);
    serde_json::to_string(&orphans).map_err(|e| e.to_string())
}

/// Kill an orphan from a previous app instance (whole process group).
#[tauri::command]
async fn kill_orphan_process(id: String, pid: u32) -> Result<String, String> {
    kill_group_graceful(pid).await;
    registry_remove(&id);
    Ok(format!("Killed orphan {} (pgid {})", id, pid))
}

fn bg_append(buf: &Arc<std::sync::Mutex<String>>, line: &str) {
    if let Ok(mut s) = buf.lock() {
        s.push_str(line);
        s.push('\n');
        if s.len() > BG_OUTPUT_CAP {
            let cut = s.len() - BG_OUTPUT_CAP;
            // Cut on a char boundary at or after the byte offset
            let cut = s.char_indices().map(|(i, _)| i).find(|&i| i >= cut).unwrap_or(0);
            s.drain(..cut);
        }
    }
}

/// Update exit_code from the child if it has exited (reaps the process).
/// `id` lets us drop naturally-exited processes from the persistent registry —
/// they can no longer become orphans.
async fn bg_refresh_exit(id: &str, p: &BgProcess) {
    let mut guard = p.child.lock().await;
    if let Some(child) = guard.as_mut() {
        if let Ok(Some(status)) = child.try_wait() {
            *p.exit_code.lock().unwrap() = Some(status.code().unwrap_or(-1));
            *guard = None; // reaped — drop the handle
            registry_remove(id);
        }
    }
}

#[cfg(test)]
mod proc_registry_tests {
    use super::*;

    // Single test — the registry is one shared file, so parallel test
    // functions would race each other's load-modify-save cycles.
    #[test]
    fn registry_roundtrip_and_reconcile() {
        // Add/remove roundtrip
        let rt = format!("bg_rt_{}", std::process::id());
        registry_add(&rt, 12345, "echo hi");
        assert!(load_proc_registry().contains_key(&rt));
        registry_remove(&rt);
        assert!(!load_proc_registry().contains_key(&rt));

        // pid 1 = launchd: alive but running a different command → must be
        // pruned as a PID-reuse mismatch, never reported as our orphan.
        let id = format!("bg_test_{}", std::process::id());
        registry_add(&id, 1, "definitely-not-a-real-tonyai-command-xyz");
        let orphans = reconcile_orphan_processes().unwrap();
        assert!(!orphans.contains(&id), "mismatched pid must not be an orphan: {orphans}");
        assert!(!load_proc_registry().contains_key(&id), "entry must be pruned");
    }
}

/// Start a long-running shell command in the background. Returns its process id.
#[tauri::command]
async fn tool_run_background(
    state: tauri::State<'_, ProcessManager>,
    command: String,
) -> Result<String, String> {
    #[cfg(not(windows))]
    let mut cmd = tokio::process::Command::new("sh");
    #[cfg(not(windows))]
    cmd.arg("-c");
    #[cfg(windows)]
    let mut cmd = tokio::process::Command::new("cmd");
    #[cfg(windows)]
    {
        cmd.arg("/C");
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.arg(&command)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Own process group: pgid == child pid, so a group signal reaches every fork
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start: {}", e))?;
    let pid = child.id().unwrap_or(0);

    let id = format!("bg_{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    registry_add(&id, pid, &command);
    let output: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));

    // Reader tasks — stream stdout/stderr lines into the capped buffer
    if let Some(stdout) = child.stdout.take() {
        let buf = Arc::clone(&output);
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await { bg_append(&buf, &line); }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let buf = Arc::clone(&output);
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await { bg_append(&buf, &line); }
        });
    }

    state.procs.lock().await.insert(id.clone(), BgProcess {
        command: command.clone(),
        pid,
        output,
        exit_code: Arc::new(std::sync::Mutex::new(None)),
        child: Arc::new(TokioMutex::new(Some(child))),
        started: std::time::SystemTime::now(),
    });

    Ok(format!(
        "Started background process {} — `{}`. Use process_status(\"{}\") to read its output, process_kill(\"{}\") to stop it.",
        id, command, id, id
    ))
}

/// Status + recent output of a background process.
#[tauri::command]
async fn tool_process_status(
    state: tauri::State<'_, ProcessManager>,
    id: String,
    tail_chars: Option<usize>,
) -> Result<String, String> {
    let procs = state.procs.lock().await;
    let p = procs.get(&id).ok_or_else(|| format!("No such process: {}", id))?;
    bg_refresh_exit(&id, p).await;

    let exit = *p.exit_code.lock().unwrap();
    let out  = p.output.lock().unwrap().clone();
    let n    = tail_chars.unwrap_or(4000).min(BG_OUTPUT_CAP);
    let tail: String = if out.chars().count() > n {
        let skip = out.chars().count() - n;
        format!("[...earlier output omitted]\n{}", out.chars().skip(skip).collect::<String>())
    } else { out };

    let secs = p.started.elapsed().map(|d| d.as_secs()).unwrap_or(0);
    let status = match exit {
        Some(code) => format!("EXITED [exit {}]", code),
        None       => "RUNNING".to_string(),
    };
    Ok(format!("{} · `{}` · {}s elapsed\n--- output ---\n{}", status, p.command, secs, tail))
}

/// Kill a background process and remove it from the registry.
#[tauri::command]
async fn tool_process_kill(
    state: tauri::State<'_, ProcessManager>,
    id: String,
) -> Result<String, String> {
    let mut procs = state.procs.lock().await;
    let p = procs.get(&id).ok_or_else(|| format!("No such process: {}", id))?;
    let pid = p.pid;
    let mut guard = p.child.lock().await;
    let was_running = if let Some(child) = guard.as_mut() {
        // Signal the whole group so forked grandchildren die too, then reap.
        kill_group_graceful(pid).await;
        let _ = child.wait().await;
        true
    } else { false };
    drop(guard);
    procs.remove(&id);
    registry_remove(&id);
    Ok(if was_running {
        format!("Killed {} (process group {})", id, pid)
    } else {
        format!("{} had already exited — removed from registry", id)
    })
}

/// List background processes as JSON: [{id, command, status, exit_code, elapsed_s}]
#[tauri::command]
async fn tool_process_list(
    state: tauri::State<'_, ProcessManager>,
) -> Result<String, String> {
    let procs = state.procs.lock().await;
    let mut items = Vec::new();
    for (id, p) in procs.iter() {
        bg_refresh_exit(id, p).await;
        let exit = *p.exit_code.lock().unwrap();
        items.push(serde_json::json!({
            "id": id,
            "command": p.command,
            "status": if exit.is_some() { "exited" } else { "running" },
            "exit_code": exit,
            "elapsed_s": p.started.elapsed().map(|d| d.as_secs()).unwrap_or(0),
        }));
    }
    serde_json::to_string(&items).map_err(|e| e.to_string())
}

// ── MCP (Model Context Protocol) server management ───────────────────────────
//
// Each MCP server runs as a child process communicating over JSON-RPC / stdio.
// Lifecycle:
//   mcp_initialize  → spawn process, handshake, discover tools → return tool list
//   mcp_call_tool   → send tools/call request → return result text
//   mcp_stop_server → remove from registry (process dies when stdin handle drops)
//
// Concurrency: the reader task runs for the lifetime of the server. Requests use
// oneshot channels so the async command handlers don't hold any mutex while
// waiting for a response.

use std::collections::HashMap as StdHashMap;
use std::sync::atomic::AtomicU64;
use tokio::sync::{Mutex as TokioMutex, oneshot};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

enum McpServer {
    Stdio {
        stdin:   Arc<TokioMutex<tokio::process::ChildStdin>>,
        pending: Arc<TokioMutex<StdHashMap<u64, oneshot::Sender<serde_json::Value>>>>,
        next_id: Arc<AtomicU64>,
    },
    Http {
        url:     String,
        auth:    Option<String>,
        session: Arc<std::sync::Mutex<Option<String>>>, // Mcp-Session-Id from the server
        next_id: Arc<AtomicU64>,
    },
}

pub struct McpManager {
    servers: Arc<TokioMutex<StdHashMap<String, McpServer>>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self { servers: Arc::new(TokioMutex::new(StdHashMap::new())) }
    }
}

/// Send a JSON-RPC request and wait for the matching response (by id).
async fn mcp_rpc(
    stdin:   &Arc<TokioMutex<tokio::process::ChildStdin>>,
    pending: &Arc<TokioMutex<StdHashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: &Arc<AtomicU64>,
    method:  &str,
    params:  serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id  = next_id.fetch_add(1, Ordering::SeqCst);
    let req = serde_json::json!({ "jsonrpc":"2.0", "id":id, "method":method, "params":params });
    let msg = format!("{}\n", serde_json::to_string(&req).unwrap());

    let (tx, rx) = oneshot::channel::<serde_json::Value>();
    pending.lock().await.insert(id, tx);
    stdin.lock().await.write_all(msg.as_bytes()).await
        .map_err(|e| format!("MCP write: {e}"))?;

    tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "MCP timeout (30s)".to_string())?
        .map_err(|_| "MCP channel closed".to_string())
}

/// Send a JSON-RPC notification (no response expected).
async fn mcp_notify(
    stdin:  &Arc<TokioMutex<tokio::process::ChildStdin>>,
    method: &str,
) -> Result<(), String> {
    let note = serde_json::json!({ "jsonrpc":"2.0", "method":method, "params":{} });
    let msg  = format!("{}\n", serde_json::to_string(&note).unwrap());
    stdin.lock().await.write_all(msg.as_bytes()).await
        .map_err(|e| format!("MCP notify: {e}"))
}

// ── HTTP (streamable) transport ───────────────────────────────────────────────
// POST each JSON-RPC message to the server URL. Responses arrive as plain JSON
// or as an SSE stream (we scan `data:` lines for the matching response id).
// The server's Mcp-Session-Id header is captured and echoed on later requests.

fn mcp_http_headers(
    req: reqwest::RequestBuilder,
    auth: &Option<String>,
    session: &Arc<std::sync::Mutex<Option<String>>>,
) -> reqwest::RequestBuilder {
    let mut req = req
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    if let Some(token) = auth {
        req = req.header("Authorization", format!("Bearer {}", token));
    }
    if let Some(sid) = session.lock().unwrap().clone() {
        req = req.header("Mcp-Session-Id", sid);
    }
    req
}

async fn mcp_http_rpc(
    url:     &str,
    auth:    &Option<String>,
    session: &Arc<std::sync::Mutex<Option<String>>>,
    next_id: &Arc<AtomicU64>,
    method:  &str,
    params:  serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id  = next_id.fetch_add(1, Ordering::SeqCst);
    let req = serde_json::json!({ "jsonrpc":"2.0", "id":id, "method":method, "params":params });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| e.to_string())?;
    let resp = mcp_http_headers(client.post(url), auth, session)
        .body(req.to_string())
        .send().await
        .map_err(|e| format!("MCP HTTP: {e}"))?;

    // Capture/refresh the session id
    if let Some(sid) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        *session.lock().unwrap() = Some(sid.to_string());
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("MCP HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }

    let is_sse = resp.headers().get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("text/event-stream"))
        .unwrap_or(false);
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if is_sse {
        // Scan SSE data lines for the JSON-RPC response with our id
        for line in body.lines() {
            let Some(data) = line.strip_prefix("data:") else { continue };
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data.trim()) {
                if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                    return Ok(v);
                }
            }
        }
        Err("MCP HTTP: no matching response in SSE stream".into())
    } else {
        serde_json::from_str(&body).map_err(|e| format!("MCP HTTP parse: {e}"))
    }
}

async fn mcp_http_notify(
    url:     &str,
    auth:    &Option<String>,
    session: &Arc<std::sync::Mutex<Option<String>>>,
    method:  &str,
) -> Result<(), String> {
    let note = serde_json::json!({ "jsonrpc":"2.0", "method":method, "params":{} });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?;
    let resp = mcp_http_headers(client.post(url), auth, session)
        .body(note.to_string())
        .send().await
        .map_err(|e| format!("MCP HTTP notify: {e}"))?;
    if let Some(sid) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        *session.lock().unwrap() = Some(sid.to_string());
    }
    Ok(())
}

/// Start an MCP server (stdio subprocess or streamable-HTTP endpoint), complete
/// the initialize handshake, discover ALL its tools (cursor pagination), and
/// register it. Returns the tools list as JSON.
/// Secret-store key holding an MCP server's bearer token.
///
/// The token is deliberately NOT accepted as a command argument: taking it from the
/// webview would mean it lives in JS memory and (as it previously did) in localStorage,
/// where any untrusted page content rendered in the agent could scrape it. Server ids
/// are user-supplied, so non-key charset is folded to '_' to keep secret_key_ok happy
/// and block path traversal.
fn mcp_secret_key(id: &str) -> String {
    let sanitized: String = id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("mcp-{}", sanitized)
}

#[tauri::command]
async fn mcp_initialize(
    state:      tauri::State<'_, McpManager>,
    id:         String,
    command:    Option<String>,
    args:       Option<Vec<String>>,
    env_vars:   Option<StdHashMap<String, String>>,
    transport:  Option<String>,
    url:        Option<String>,
) -> Result<String, String> {
    let init_params = serde_json::json!({
        "protocolVersion": "2025-03-26",
        "capabilities": { "tools": {} },
        "clientInfo": { "name": "UIG Studios AI", "version": "1.1.0" }
    });

    // ── HTTP transport ────────────────────────────────────────────────────────
    if transport.as_deref() == Some("http") {
        let url = url.filter(|u| !u.trim().is_empty())
            .ok_or("HTTP transport requires a server URL")?;
        // Read straight from the 0600 secret store — never from the caller.
        let auth = read_secret_value(&mcp_secret_key(&id)).ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        let session: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
        let next_id = Arc::new(AtomicU64::new(1));

        let init_resp = mcp_http_rpc(&url, &auth, &session, &next_id, "initialize", init_params).await?;
        if let Some(err) = init_resp.get("error") {
            return Err(format!("MCP initialize failed: {err}"));
        }
        let _ = mcp_http_notify(&url, &auth, &session, "notifications/initialized").await;

        // tools/list with cursor pagination
        let mut tools: Vec<serde_json::Value> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(c) => serde_json::json!({ "cursor": c }),
                None    => serde_json::json!({}),
            };
            let resp = mcp_http_rpc(&url, &auth, &session, &next_id, "tools/list", params).await?;
            if let Some(page) = resp.pointer("/result/tools").and_then(|t| t.as_array()) {
                tools.extend(page.iter().cloned());
            }
            cursor = resp.pointer("/result/nextCursor").and_then(|c| c.as_str()).map(String::from);
            if cursor.is_none() || tools.len() > 500 { break; }
        }

        let tools_json = serde_json::to_string(&tools).map_err(|e| e.to_string())?;
        state.servers.lock().await.insert(id, McpServer::Http { url, auth, session, next_id });
        return Ok(tools_json);
    }

    // ── stdio transport (default) ─────────────────────────────────────────────
    let command = command.filter(|c| !c.trim().is_empty())
        .ok_or("stdio transport requires a command")?;
    let args = args.unwrap_or_default();
    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args)
       .stdin(std::process::Stdio::piped())
       .stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::null());
    if let Some(ref env) = env_vars {
        for (k, v) in env { cmd.env(k, v); }
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Cannot start MCP server '{}': {e}", command))?;

    let child_stdin  = Arc::new(TokioMutex::new(child.stdin.take().unwrap()));
    let child_stdout = child.stdout.take().unwrap();
    let pending: Arc<TokioMutex<StdHashMap<u64, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(TokioMutex::new(StdHashMap::new()));
    let next_id = Arc::new(AtomicU64::new(1));

    // Spawn the stdout reader task — owns the child handle to keep process alive.
    {
        let pend = Arc::clone(&pending);
        tokio::spawn(async move {
            let _proc = child; // keep alive until EOF
            let mut reader = tokio::io::BufReader::new(child_stdout);
            let mut line   = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let t = line.trim();
                        if t.is_empty() { continue; }
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
                            // Match by id — notifications (no id) are silently ignored.
                            if let Some(rid) = v.get("id").and_then(|i| i.as_u64()) {
                                if let Some(tx) = pend.lock().await.remove(&rid) {
                                    let _ = tx.send(v);
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    // MCP handshake
    let init_resp = mcp_rpc(&child_stdin, &pending, &next_id, "initialize", init_params).await?;
    if let Some(err) = init_resp.get("error") {
        return Err(format!("MCP initialize failed: {err}"));
    }
    mcp_notify(&child_stdin, "notifications/initialized").await?;

    // Discover ALL tools — cursor pagination
    let mut tools: Vec<serde_json::Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(c) => serde_json::json!({ "cursor": c }),
            None    => serde_json::json!({}),
        };
        let resp = mcp_rpc(&child_stdin, &pending, &next_id, "tools/list", params).await?;
        if let Some(page) = resp.pointer("/result/tools").and_then(|t| t.as_array()) {
            tools.extend(page.iter().cloned());
        }
        cursor = resp.pointer("/result/nextCursor").and_then(|c| c.as_str()).map(String::from);
        if cursor.is_none() || tools.len() > 500 { break; }
    }

    let tools_json = serde_json::to_string(&tools).map_err(|e| e.to_string())?;

    state.servers.lock().await.insert(id, McpServer::Stdio {
        stdin: child_stdin, pending, next_id,
    });

    Ok(tools_json)
}

/// Call a tool on a running MCP server. Returns the text content from the result.
#[tauri::command]
async fn mcp_call_tool(
    state:     tauri::State<'_, McpManager>,
    server_id: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<String, String> {
    // Clone transport handles before releasing the lock so we don't hold it
    // during the async wait.
    enum Handle {
        Stdio(Arc<TokioMutex<tokio::process::ChildStdin>>, Arc<TokioMutex<StdHashMap<u64, oneshot::Sender<serde_json::Value>>>>, Arc<AtomicU64>),
        Http(String, Option<String>, Arc<std::sync::Mutex<Option<String>>>, Arc<AtomicU64>),
    }
    let handle = {
        let guard = state.servers.lock().await;
        match guard.get(&server_id)
            .ok_or_else(|| format!("MCP server '{server_id}' not connected"))? {
            McpServer::Stdio { stdin, pending, next_id } =>
                Handle::Stdio(Arc::clone(stdin), Arc::clone(pending), Arc::clone(next_id)),
            McpServer::Http { url, auth, session, next_id } =>
                Handle::Http(url.clone(), auth.clone(), Arc::clone(session), Arc::clone(next_id)),
        }
    };

    let params = serde_json::json!({ "name": tool_name, "arguments": arguments });
    let resp = match &handle {
        Handle::Stdio(stdin, pending, next_id) =>
            mcp_rpc(stdin, pending, next_id, "tools/call", params).await?,
        Handle::Http(url, auth, session, next_id) =>
            mcp_http_rpc(url, auth, session, next_id, "tools/call", params).await?,
    };

    if let Some(err) = resp.get("error") {
        return Err(format!("MCP tool error: {err}"));
    }

    // Extract text blocks from the MCP content array
    let text = resp.pointer("/result/content")
        .and_then(|c| c.as_array())
        .map(|arr| arr.iter()
            .filter_map(|item| {
                (item.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .then(|| item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string())
            })
            .collect::<Vec<_>>()
            .join("\n"))
        .unwrap_or_else(|| {
            serde_json::to_string(resp.get("result").unwrap_or(&resp))
                .unwrap_or_default()
        });

    Ok(text)
}

/// Remove a server from the registry (drops stdin → process exits naturally).
#[tauri::command]
async fn mcp_stop_server(
    state: tauri::State<'_, McpManager>,
    server_id: String,
) -> Result<(), String> {
    state.servers.lock().await.remove(&server_id);
    Ok(())
}

/// List currently connected server IDs.
#[tauri::command]
async fn mcp_list_servers(
    state: tauri::State<'_, McpManager>,
) -> Result<Vec<String>, String> {
    Ok(state.servers.lock().await.keys().cloned().collect())
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = migrate_legacy_dirs();   // ~/.tonyai → ~/.uigai, ~/TonyAI-* → ~/UIG-AI/* (once, never overwrites)
    tauri::Builder::default()
        .manage(StreamCancelMap::new())
        .manage(McpManager::new())
        .manage(ProcessManager::new())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            migrate_legacy_layout,
            read_rag_index,
            save_rag_index,
            read_source_files,
            stat_source_files,
            read_knowledge_index,
            save_knowledge_index,
            read_knowledge_files,
            stat_knowledge_files,
            read_memory,
            save_memory,
            save_session,
            read_sessions,
            delete_session_file,
            delete_session_images,
            save_session_image,
            read_session_image,
            read_memory_files,
            save_memory_file,
            save_secret,
            read_secret,
            append_log,
            launch_self_update,
            append_telemetry,
            read_telemetry,
            append_compare_vote,
            read_inbox,
            save_inbox,
            read_ops_state,
            ollama_tags,
            ollama_pull,
            ollama_post,
            ollama_chat,
            ollama_abort,
            cloud_chat,
            cloud_post,
            cloud_list_models,
            tool_web_search,
            tool_fetch_url,
            get_home_dir,
            get_hardware_info,
            tool_read_file,
            tool_write_file,
            tool_edit_file,
            checkpoint_file,
            checkpoint_revert,
            find_project_instructions,
            tool_search_files,
            tool_list_dir,
            tool_run_command,
            tool_run_background,
            tool_process_status,
            tool_process_kill,
            tool_process_list,
            reconcile_orphan_processes,
            kill_orphan_process,
            tool_python_exec,
            tool_git_status,
            tool_git_diff,
            tool_git_log,
            tool_git_blame,
            save_generated_image,
            open_path,
            mcp_initialize,
            mcp_call_tool,
            mcp_stop_server,
            mcp_list_servers,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill every background process group on normal app exit so dev
            // servers and watch tasks don't outlive UIG Studios AI. (Force-quit/crash
            // is covered by the persistent registry + orphan reconciliation.)
            if let tauri::RunEvent::Exit = event {
                if let Some(pm) = app_handle.try_state::<ProcessManager>() {
                    tauri::async_runtime::block_on(async {
                        let mut procs = pm.procs.lock().await;
                        #[cfg(unix)]
                        {
                            for (id, p) in procs.iter() {
                                signal_group(p.pid, libc::SIGTERM);
                                registry_remove(id);
                            }
                            if !procs.is_empty() {
                                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                for p in procs.values() {
                                    signal_group(p.pid, libc::SIGKILL);
                                }
                            }
                        }
                        #[cfg(windows)]
                        {
                            let ids: Vec<String> = procs.keys().cloned().collect();
                            for id in &ids { registry_remove(id); }
                            for p in procs.values() {
                                kill_group_graceful(p.pid).await;
                            }
                        }
                        procs.clear();
                    });
                }
            }
        });
}
