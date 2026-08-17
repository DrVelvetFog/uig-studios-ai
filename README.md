# UIG Studios AI

A local-first desktop AI agent. Tauri 2 + React + Rust, driving Ollama models on your own machine (cloud models optional). One person's daily workstation, built to be trustworthy rather than magical.

> Status: personal tool, macOS (Apple Silicon) only, built from source. Not a product. See [Status](#status).

## What makes it different

Most agent apps ask you to trust the transcript. UIG Studios AI records things a stranger could check:

- **Undo for shell commands.** File edits are checkpointed per turn (↩ Revert), and — the part most tools skip — `run_command` effects are journaled too: when a command runs inside a git repo it goes through [rv](https://github.com/DrVelvetFog/reversible), which snapshots the worktree before/after as a content-addressed tree. The message gets an **↩ Undo command effects** button; restore is per-path and refuses files you edited since.
- **Evidence tiers, stamped by code.** Every tool step is tagged by *what kind of tool it is* — `ran` (executed), `read` (file/URL/RAG), `told` (web search, MCP, another agent) — never by the model. A completed turn shows the strongest tier its steps actually support; the settings table shows **ran-backed %** per model (of completed runs, how many rested on an executed step). Transcript exports carry a `.evidence.json` sidecar of [in-toto Statements](https://github.com/DrVelvetFog/evidence-tier).
- **Verified examples.** Runnable examples ship with execution attestations (`examples/attest.json`, gated in CI). The coder subagent looks for the same in libraries it uses and imitates only examples reported VERIFIED ([xv](https://github.com/DrVelvetFog/verified-examples)).
- **Portable memory.** Persistent memory is a directory of markdown files in [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) with `generated: { by, at }` stamped on every write (agent vs human), and each learned fact ends with an evidence tag — `[ran]` `[read: path]` `[told: user]` `[recalled]`. `npm run okf-check` validates the bundle.
- **Safety gates that don't depend on the model.** Hard denylist of catastrophic operations; **credential stores (`~/.ssh`, `~/.aws`, keychains, the app's own secret files, signing keys) are unreadable by every tool**, and secret-looking tokens are refused in outbound URLs/queries/MCP args — closing the read-then-exfiltrate chain; approval prompt for anything mutating (with an allowlist for "always allow" that force-push, publish, prune and file uploads can never satisfy); `.env` reads ask; prompt-injection scanning on all web/MCP content; and a provenance flag: once untrusted content enters the context, mutating tools — and long/blob-like outbound requests — require human approval for the rest of the turn regardless of allowlists. Secrets live in `~/.tonyai/secret-*.txt` (mode 0600), never in the webview.
- **A stop condition the model can't talk its way past.** "Task complete" is rejected unless code that was written was also run with `[exit 0]`; queries about current events are rejected without a search that actually ran.

## What it does

- **Modes:** Auto (classifier-routed), Chat, Code, Python, Agent, Sui/Move, Ops, Image, ComfyUI. Each mode has its own tool set, model tier, and memory scope.
- **Agent loop:** hand-rolled ReAct loop over native Ollama tool calling (with a prompt-JSON fallback for models without tool support). Tools: `web_search` / `deep_search` / `fetch_url`, `read_file` / `write_file` / `edit_file` / `list_dir` / `search_files`, `run_command` / `run_background` / `process_*`, `python_exec` (sandboxed venv), read-only `git_*`, `search_knowledge` (RAG), `search_sessions`, `propose_plan`, `spawn_subagent` (researcher / coder / verifier / fixer; coder auto-chains coder → verifier → fixer).
- **MCP client** in Rust — stdio and streamable-HTTP transports, tools namespaced `mcp__<server>__<tool>`, always behind approval.
- **Models:** local Ollama with model-fit indicators for your RAM (context clamped for big models) — including any GGUF on Hugging Face via `ollama pull hf.co/<user>/<repo>`; OpenRouter and OpenAI as an explicit cloud tier with per-session cost; **any OpenAI-compatible endpoint** (Hugging Face Inference Providers, LM Studio, vLLM, llama.cpp server) as a custom provider; blind A/B compare with vote-then-reveal.
- **Memory & context:** two RAG indexes (code + knowledge base, hybrid vector + keyword), two-level context compaction, per-project `TONYAI.md` instructions auto-injected when tools touch a project tree.
- **Sessions:** on disk, forkable, auto-exported to markdown; background processes survive the turn and die with the app.
- **Ops console:** a launchd monitor runs config-driven health checks (HTTP, Sui balances/objects, pm2) every five minutes, posts transitions to an in-app inbox and macOS notifications, and writes a daily brief.
- **Images:** Automatic1111 and ComfyUI backends with progress and JSON sidecars.

## Requirements

- macOS on Apple Silicon (a Windows port exists in the tree but has only been syntax-checked, not built).
- [Ollama](https://ollama.com) with at least one chat model pulled. Tool-calling models work best (`qwen2.5-coder:14b` on 16 GB is the calibrated default); the app shows a fit indicator per model.
- Node 22+, Rust stable, and the Tauri 2 prerequisites to build.
- Optional: OpenRouter / OpenAI keys for the cloud tier; a Serper or Brave key for search (DuckDuckGo scraping is the last-resort fallback and rate-limits fast); Automatic1111 / ComfyUI for images; [rv](https://github.com/DrVelvetFog/reversible) at `~/reversible/rv` for shell undo.

## Build and install

```bash
npm ci
npm test                    # vitest
(cd src-tauri && cargo test --lib)
./scripts/update-app.sh     # test → tauri build → install to /Applications
```

For a signed (and, with credentials, notarized) build see `scripts/release-signed.sh`; it also produces the updater artifacts and `latest.json` and, with `--release`, publishes a GitHub Release. Installed builds check GitHub Releases for signed updates (Settings → Check for updates). Unsigned builds run only on the machine that built them.

## Configuration

Everything lives under `~/.tonyai/` and `~/TonyAI-*`:

| Path | What |
|---|---|
| `~/.tonyai/secret-<name>.txt` | API keys and MCP tokens, mode 0600. Set them in Settings; the field saves on blur and clears from the UI. |
| `~/.tonyai/sessions/` · `~/TonyAI-Exports/` | Sessions on disk; markdown transcripts (+ `.evidence.json`). |
| `~/TonyAI-Projects/memory/` | OKF memory bundle (`index.md`, `global.md`, `<mode>.md`). |
| `~/TonyAI-Documents/` | Knowledge base indexed for RAG. |
| `~/TonyAI-Sandbox/` | Python venv used by `python_exec`. |
| `~/.tonyai/ops.json` | Ops checks (seeded from `scripts/ops-default.json` on first run). |
| `~/.tonyai/telemetry.jsonl` | Per-run agent stats, local only. |
| `~/.tonyai/checkpoints/` · `<repo>/.git/rv/` | File checkpoints; rv command journals. |

## Privacy

Nothing leaves the machine unless you configure it to: local models via Ollama; cloud models only when you select one and supply a key; web search only through the provider whose key you set; MCP servers only those you add. Telemetry is a local JSONL file. File tools are restricted to `$HOME` and `/tmp`.

## Development

```bash
npm run dev            # vite, for the web preview (no Tauri bridge)
npm run tauri dev      # full app
npm test               # 270+ unit tests
npm run eval           # promptfoo behavioral evals
npm run okf-check      # validate the memory bundle
```

Layout: `src/App.jsx` (UI + agent loop), `src/*.js` (pure logic: `agentLogic`, `toolGuard`, `classifyPrompt`, `retrieval`, `tokens`, `cloud`, `evidence`, `rv`, `memoryOkf`), `src-tauri/src/lib.rs` (tools, MCP client, process registry, secrets), `scripts/` (monitor, ops, okf-check, update).

## Status

This is the tool its author uses every day, not a product: one contributor, macOS-only, defaults tuned to a 16 GB M1 and to the author's own projects (the Sui and Ops modes in particular). It is published for the design — the trust features above are the point — and as reference for anyone building a local-first agent. Issues and PRs are welcome; expect the maintainer to be opinionated about scope.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
