# Setup: models, keys, MCP servers, background monitor

## First run

1. Install [Ollama](https://ollama.com/download) and launch it once. The app's empty state shows **Ollama isn't running** until it can reach `localhost:11434`; press **Retry**.
2. Pull a model. The empty state lists starters sized to your RAM (🟢 comfortable · 🟡 tight · 🔴 will swap). `qwen2.5-coder:7b` is the safe default; `qwen2.5-coder:14b` is the best quality on 16 GB+. Any GGUF model on Hugging Face works too: `ollama pull hf.co/<user>/<repo>` (add `:Q4_K_M` etc. for a quant).
3. Optional: `ollama pull nomic-embed-text` enables the knowledge-base search (`search_knowledge`) over `~/UIG-AI/Documents/`.

The first launch also creates `~/.uigai/` and an empty memory bundle at `~/UIG-AI/Projects/memory/`.

## Keys and cloud models (⚙ settings)

All keys are stored in `~/.uigai/secret-<name>.txt` with mode 0600 — never in the webview. **Fields save on blur**: type or paste, then click somewhere else before you use the key.

| Setting | What it enables |
|---|---|
| Serper or Brave key | `web_search` / `deep_search`. Without a key the app falls back to scraping DuckDuckGo, which rate-limits after a single query (it serves its challenge page under HTTP 202; the app detects it and reports *search did not run*). |
| OpenRouter key | Curated frontier models (`or/…`) with per-session cost shown in the header. |
| OpenAI key | GPT models direct (`oai/…`). |
| **Custom endpoint** | Any OpenAI-compatible server: `https://router.huggingface.co/v1` (Hugging Face Inference Providers), `http://localhost:1234/v1` (LM Studio), vLLM, llama.cpp `--server`, TGI. Key optional. Models appear as `cx/…`. |

Cloud models are **manual selection only** — smart routing never picks one — so nothing leaves the machine unless you choose it. Local models get context clamped by RAM automatically (fit dots in the picker).

## MCP servers (⚙ → MCP)

The app is an MCP client with two transports:

- **stdio** — a local command (`npx …`, a binary). Tools appear as `mcp__<serverId>__<tool>`.
- **HTTP** (streamable) — a URL, optional bearer token.

Every MCP tool is treated as **untrusted input** (wrapped, injection-scanned, and it flips the "web content in context" flag so mutating tools need approval for the rest of the turn) and **always requires approval** to run, unless you allowlist that exact tool name.

### GitHub (verified working)

Endpoint `https://api.githubcopilot.com/mcp/`, transport HTTP, bearer = a GitHub **fine-grained PAT** (no Copilot subscription needed). ~44 tools.

Traps, in order of how often they bite:

1. **Paste the token, then click away, *then* flip the toggle.** The token saves on blur; the On toggle immediately connects and reads the secret store. Toggle while the field still has focus → the server sees an empty token → a `401` that looks like a bad PAT but is a timing artifact.
2. **The server advertises its full toolset regardless of token scope.** Write tools appear even with a read-only PAT and 403 at execution. Your token scopes are the enforcement boundary, not the tool list.
3. **Server ids are auto-generated and not editable** — the token file name is derived from the id. Don't rename or recreate a server entry expecting the token to follow it; re-paste it.
4. Quick liveness test from a terminal (no token): `curl -s -o /dev/null -w '%{http_code}' https://api.githubcopilot.com/mcp/` → `401` means the endpoint is up.

## Background monitor and Ops mode (optional, macOS)

`scripts/monitor.mjs` runs config-driven checks (HTTP, Sui balances/objects, pm2) every five minutes, writes `~/.uigai/ops-state.json`, posts transitions to the in-app inbox + macOS notifications, and writes a daily brief. It is **not installed automatically**. To run it under launchd:

```bash
cat > ~/Library/LaunchAgents/com.uigstudios.ai.monitor.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.uigstudios.ai.monitor</string>
  <key>ProgramArguments</key><array><string>$(which node)</string><string>$HOME/uig-studios-ai/scripts/monitor.mjs</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.uigai/logs/monitor-error.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict></plist>
EOF
launchctl load -w ~/Library/LaunchAgents/com.uigstudios.ai.monitor.plist
```

Checks live in `~/.uigai/ops.json` (seeded from `scripts/ops-default.json` — two example checks; replace them). `project` groups cards in the Ops panel; optional `projectOrder` fixes the order. Project-specific rules for the Ops mode go in `~/UIG-AI/Projects/memory/ops.md`.

## Shell undo (optional)

Install [rv](https://github.com/DrVelvetFog/reversible) at `~/reversible/rv`. When present, `run_command` inside a git repo is journaled and each turn gets an **↩ Undo command effects** button. Journals live in `<repo>/.git/rv/`.

## Where things live

| Path | What |
|---|---|
| `~/.uigai/secret-*.txt` | keys (0600) |
| `~/.uigai/sessions/` · `~/UIG-AI/Exports/` | sessions; markdown transcripts + `.evidence.json` sidecars |
| `~/UIG-AI/Projects/memory/` | OKF memory bundle |
| `~/UIG-AI/Documents/` | knowledge base for RAG |
| `~/UIG-AI/Sandbox/` | Python venv for `python_exec` |
| `~/UIG-AI/Images/` | generated images + JSON sidecars |
| `~/.uigai/checkpoints/` | per-turn file checkpoints |
| `~/.uigai/telemetry.jsonl` | per-run stats (local only) |
| `~/.uigai/logs/` | app + monitor logs |
