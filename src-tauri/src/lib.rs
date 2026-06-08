use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, State};

// ── Cancel token shared across commands ──────────────────────────────────────
pub struct StreamCancelToken(Arc<AtomicBool>);

// ── Filesystem helpers ────────────────────────────────────────────────────────
fn tonyai_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(home).join(".tonyai");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// ── General Knowledge Base ───────────────────────────────────────────────────
/// Separate from the arb-bot RAG. Reads any text-based file recursively
/// from a user-configured directory (default: ~/TonyAI-Documents/).

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

/// Read all memory .md files from ~/TonyAI-Projects/memory/.
/// Returns JSON object: { "global": "...", "chat": "...", ... }
#[tauri::command]
fn read_memory_files() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(&home).join("TonyAI-Projects").join("memory");
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

/// Write a single memory .md file to ~/TonyAI-Projects/memory/{name}.md.
/// name must be alphanumeric (e.g. "global", "chat", "code").
#[tauri::command]
fn save_memory_file(name: String, content: String) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(&home).join("TonyAI-Projects").join("memory");
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
    cancel: State<'_, StreamCancelToken>,
    body: String,
    event_id: String,
) -> Result<(), String> {
    // Reset cancel flag for this new request
    cancel.0.store(false, Ordering::Relaxed);

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

    let cancel_flag = cancel.0.clone();
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

/// Signals the active stream to stop after the current chunk.
#[tauri::command]
fn ollama_abort(cancel: State<'_, StreamCancelToken>) {
    cancel.0.store(true, Ordering::Relaxed);
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
        format!("No results scraped for '{}'. Consider adding a Serper.dev or Brave API key for reliable search.", query)
    } else {
        results.join("\n\n")
    }
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
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(html) => ddg_html_scrape(&html, query),
            Err(e)   => format!("Search unavailable (DuckDuckGo read error: {}). Add a Serper.dev or Brave API key for reliable search.", e),
        },
        Ok(resp) => format!("Search unavailable (DuckDuckGo HTTP {}). Add a Serper.dev or Brave API key for reliable search.", resp.status()),
        Err(e)   => format!("Search unavailable (DuckDuckGo unreachable: {}). Add a Serper.dev or Brave API key for reliable search.", e),
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
    fn empty_html_reports_no_results() {
        let out = ddg_html_scrape("<html><body>nothing here</body></html>", "q");
        assert!(out.starts_with("No results scraped"), "got: {out}");
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

/// Read a file from disk (home directory only).
#[tauri::command]
fn tool_read_file(path: String) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let allowed_prefixes = [home.as_str(), "/tmp"];
    if !allowed_prefixes.iter().any(|p| path.starts_with(p)) {
        return Err(format!("Access denied: only files under $HOME or /tmp are readable"));
    }
    let p = std::path::Path::new(&path);
    if !p.exists() { return Err(format!("Not found: {}", path)); }
    if p.is_dir()  { return Err(format!("'{}' is a directory — use list_dir instead", path)); }
    let content = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
    let chars: Vec<char> = content.chars().collect();
    let limit = 20000;
    Ok(if chars.len() > limit {
        format!("{}\n\n[...truncated at {} chars]", chars[..limit].iter().collect::<String>(), limit)
    } else {
        content
    })
}

/// Return the current user's home directory.
#[tauri::command]
fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
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

    let home = std::env::var("HOME").unwrap_or_default();
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
    let home = std::env::var("HOME").unwrap_or_default();
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

/// List contents of a directory (home directory only).
#[tauri::command]
fn tool_list_dir(path: String) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_default();
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

    let home = std::env::var("HOME").map_err(|e| e.to_string())?;

    // Sanitise inputs — no path traversal
    let safe_subdir = subdir.replace(['/', '\\', '.'], "-");
    let safe_stem   = filename_stem.replace(['/', '\\'], "-");

    let dir = std::path::PathBuf::from(&home)
        .join("TonyAI-Images")
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
    let home = std::env::var("HOME").unwrap_or_default();
    // Only allow paths under HOME for safety
    if !path.starts_with(&home) && !path.starts_with("/tmp") {
        return Err("Access denied".into());
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Git-native tools (read-only) ─────────────────────────────────────────────
// Write ops (commit/push/reset/checkout) intentionally NOT included — those
// must go through tool_run_command which has the permission gate.

async fn run_git(args: Vec<&str>, repo_path: &str) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_default();
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

/// Execute Python code in a sandboxed environment (~/TonyAI-Sandbox/).
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
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let sandbox = std::path::PathBuf::from(&home).join("TonyAI-Sandbox");
    std::fs::create_dir_all(&sandbox).map_err(|e| format!("mkdir sandbox: {e}"))?;

    let venv_dir = sandbox.join(".venv");
    let venv_python = venv_dir.join("bin").join("python3");
    let venv_pip = venv_dir.join("bin").join("pip");

    // Bootstrap venv on first use
    if !venv_python.exists() {
        let bootstrap = tokio::process::Command::new("python3")
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

/// Run a shell command and return its output (30s timeout).
#[tauri::command]
async fn tool_run_command(command: String) -> Result<String, String> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .output(),
    ).await
    .map_err(|_| "Command timed out after 30s".to_string())?
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

struct McpServer {
    stdin:   Arc<TokioMutex<tokio::process::ChildStdin>>,
    pending: Arc<TokioMutex<StdHashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: Arc<AtomicU64>,
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

/// Start an MCP server subprocess, complete the initialize handshake,
/// discover its tools, and register it. Returns the tools list as JSON.
#[tauri::command]
async fn mcp_initialize(
    state:    tauri::State<'_, McpManager>,
    id:       String,
    command:  String,
    args:     Vec<String>,
    env_vars: Option<StdHashMap<String, String>>,
) -> Result<String, String> {
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
    let init_resp = mcp_rpc(&child_stdin, &pending, &next_id, "initialize",
        serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "clientInfo": { "name": "TonyAI", "version": "1.0.0" }
        })
    ).await?;
    if let Some(err) = init_resp.get("error") {
        return Err(format!("MCP initialize failed: {err}"));
    }
    mcp_notify(&child_stdin, "notifications/initialized").await?;

    // Discover tools (first page — cursor pagination ignored for v1)
    let tools_resp = mcp_rpc(&child_stdin, &pending, &next_id, "tools/list",
        serde_json::json!({})
    ).await?;
    let tools: Vec<serde_json::Value> = tools_resp
        .pointer("/result/tools")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    let tools_json = serde_json::to_string(&tools).map_err(|e| e.to_string())?;

    state.servers.lock().await.insert(id, McpServer {
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
    // Clone Arcs before releasing the lock so we don't hold it during the async wait.
    let (stdin, pending, next_id) = {
        let guard = state.servers.lock().await;
        let s = guard.get(&server_id)
            .ok_or_else(|| format!("MCP server '{server_id}' not connected"))?;
        (Arc::clone(&s.stdin), Arc::clone(&s.pending), Arc::clone(&s.next_id))
    };

    let resp = mcp_rpc(&stdin, &pending, &next_id, "tools/call",
        serde_json::json!({ "name": tool_name, "arguments": arguments })
    ).await?;

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
    tauri::Builder::default()
        .manage(StreamCancelToken(Arc::new(AtomicBool::new(false))))
        .manage(McpManager::new())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
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
            read_memory_files,
            save_memory_file,
            save_secret,
            read_secret,
            read_inbox,
            save_inbox,
            ollama_tags,
            ollama_pull,
            ollama_post,
            ollama_chat,
            ollama_abort,
            tool_web_search,
            tool_fetch_url,
            get_home_dir,
            tool_read_file,
            tool_write_file,
            tool_search_files,
            tool_list_dir,
            tool_run_command,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
