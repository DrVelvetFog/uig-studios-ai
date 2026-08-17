# Modes and tools

UIG Studios AI has one agent loop and several **modes**. A mode fixes three things: the system prompt, which tools the model may call, and which memory scope is injected (global + that mode's file in `~/TonyAI-Projects/memory/`).

## Modes

| Mode | What it's for | Tools |
|---|---|---|
| **Auto** | Classifies each prompt and routes to Chat / Code / Python / Agent / Sui / Ops / Image | resolved per prompt |
| **Chat** | Questions and writing, with search when needed | `web_search`, `deep_search`, `fetch_url`, `search_knowledge`, `search_sessions` |
| **Code** | Software work: read, plan, edit, run, verify | `web_search`, `deep_search`, `fetch_url`, `propose_plan`, `write_file`, `edit_file`, `read_file`, `search_files`, `list_dir`, `run_command`, `run_background`, `process_status`, `process_kill`, `process_list`, `python_exec`, `git_status`, `git_diff`, `git_log`, `git_blame`, `spawn_subagent`, `search_knowledge`, `search_sessions` |
| **Python** | Same as Code, Python-first system prompt | `web_search`, `deep_search`, `fetch_url`, `propose_plan`, `write_file`, `edit_file`, `read_file`, `search_files`, `list_dir`, `run_command`, `run_background`, `process_status`, `process_kill`, `process_list`, `python_exec`, `git_status`, `git_diff`, `git_log`, `git_blame`, `spawn_subagent`, `search_knowledge`, `search_sessions` |
| **Agent** | Unrestricted orchestrator: every tool, subagents, MCP | all tools + connected MCP tools |
| **Sui/Move** | Sui blockchain / Move development | `web_search`, `deep_search`, `fetch_url`, `propose_plan`, `write_file`, `edit_file`, `read_file`, `search_files`, `list_dir`, `run_command`, `run_background`, `process_status`, `process_kill`, `process_list`, `python_exec`, `git_status`, `git_diff`, `git_log`, `git_blame`, `spawn_subagent`, `search_knowledge`, `search_sessions` |
| **Ops** | Reads the background monitor's state (`~/.tonyai/ops-*.json`) and runs health / deep / daily playbooks | same as Code |
| **Image** | Automatic1111 / ComfyUI generation | none (image backends) |

`smart routing` picks a model per mode from the tier lists (local first; cloud only when you select one). Each mode also has its own temperature and context size.

## Tools

Every tool call passes two gates before it runs, in code, not in the prompt: the hard denylist (`toolGuard.js` — catastrophic shell shapes, credential stores, secret-looking outbound payloads), then the approval prompt for anything mutating (or anything at all once untrusted web content is in the turn). Read tools run silently unless they touch a `.env` file.

| Tool | Description |
|---|---|
| `web_search` | Search the internet for current information, news, research, documentation, prices. Returns titles, URLs, and snippets. Use deep_search if you need full page content. |
| `deep_search` | Search the internet AND automatically fetch the full content of the top results. Use this for any question needing current, detailed information — prices, news, documentation, tutorials. More thorough than web_search alone. |
| `fetch_url` | Fetch and read the full text content of a specific URL. Use after web_search to get full page details. |
| `read_file` | Read the contents of a local file. Only files under $HOME are accessible. Long files come back one 20000-char window at a time; if the result ends in a truncation marker, call again with the offset it names to read the rest. |
| `list_dir` | List files and subdirectories in a local directory. |
| `run_command` | Run a shell command and return its output. Use for pm2, git, npm, ls, curl, python3, node, etc. Default timeout 30s — pass timeout_seconds (max 600) for long builds or test suites. For servers / watch tasks that never exit, use run_background instead. |
| `run_background` | Start a LONG-RUNNING shell command in the background (dev server, watch task, long build) and return immediately with a process id. The command keeps running — use process_status(id) to read its output and process_kill(id) to stop it. Always kill servers you started when the task is done. |
| `process_status` | Check a background process started with run_background: returns RUNNING or EXITED [exit N] plus its recent output. Call this after starting a server to confirm it came up. |
| `process_kill` | Stop a background process started with run_background. |
| `process_list` | List all background processes (id, command, running/exited, elapsed seconds) as JSON. |
| `write_file` | Write text content to a NEW file (creates parent directories automatically). For changing an EXISTING file, prefer edit_file — it changes only the matched text instead of overwriting the whole file. |
| `edit_file` | Surgically edit an EXISTING file by exact search/replace — the safe way to modify files. old_string must match the file content exactly (read_file first to copy it, whitespace included) and must be unique in the file unless replace_all is true. Prefer this over write_file for any change to an existing file. |
| `search_files` | Search file contents using a regex pattern across a directory tree (like grep -rn). Returns matching lines as 'file:line: content'. Use to find function definitions, variable usages, imports, TODO comments, or any text pattern across a codebase. Skips node_modules, .git, target, and binary files automatically. |
| `propose_plan` | Present a structured plan to the user for approval BEFORE executing a complex task (2+ files, state-changing commands, architectural choices). The user sees the plan with Approve / Request-changes buttons; the result tells you their decision. Do not start executing until a plan is APPROVED. Skip planning for simple single-step tasks. |
| `spawn_subagent` | Spawn an isolated subagent to handle a subtask. coder role auto-runs a verifier after writing code, then a fixer if verification fails — you get a guaranteed-working result. researcher=web search only | coder=write+verify+fix (full pipeline) | verifier=run+inspect | fixer=fix broken code. |
| `search_sessions` | Search the user's PAST CONVERSATION transcripts (auto-saved session exports). Use when asked about earlier discussions, prior decisions, 'what did we talk about', or to recall context from previous sessions. Returns matching lines as 'file:line: text' — the filenames start with the session date. |
| `search_knowledge` | Search your personal knowledge base — documents, notes, specs, and files you've added to ~/TonyAI-Documents/. Returns the most relevant passages. Use this to answer questions about your own projects, decisions, preferences, or any documents you've stored. |
| `python_exec` | Execute Python code in a SANDBOXED environment (~/TonyAI-Sandbox/) — safer than run_command for testing snippets, data analysis, or experimentation. Code runs in an isolated venv, not your project tree. Supports optional pip packages. Returns stdout, stderr, and exit code. Prefer this over run_command for any standalone Python code. |
| `git_status` | Get a git repo's current state: branch, ahead/behind, staged + unstaged + untracked files, stash count. Use BEFORE making changes to understand the current state. |
| `git_diff` | Show git diff for working tree (default) or staged changes. Optionally limit to a single file. Use to review what changed before committing or to understand recent edits. |
| `git_log` | Get recent commit history in one-line format with branch decorations. Optionally limit to a specific file. |
| `git_blame` | Show who last modified each line of a file. Useful for understanding the history and authors of specific code. |

Evidence tier by tool kind (stamped by code, shown as `evidence:` under each turn): `run_command` / `python_exec` / `run_background` → **ran**; `read_file` / `list_dir` / `search_files` / `git_*` / `fetch_url` / `search_knowledge` / `search_sessions` → **read**; `web_search` / `deep_search` / `spawn_subagent` / MCP tools → **told**; `write_file` / `edit_file` / `propose_plan` / process control → actions.

## Subagents

`spawn_subagent` runs a scoped worker with its own tool set and no approval UI (catastrophic ops are simply refused): **researcher** (search + fetch), **coder** (write/edit/read/run — checks for verified examples first), **verifier** (run + report exact output), **fixer** (read error → minimal edit → re-run). A coder request auto-chains coder → verifier → fixer, up to two fix rounds.

## Undo

- File edits by `write_file` / `edit_file` are checkpointed per turn → **↩ Revert N file changes** on the message.
- `run_command` effects are journaled with [rv](https://github.com/DrVelvetFog/reversible) when the command runs inside a git repo (scope = a leading `cd <dir>` or the last directory a tool touched) → **↩ Undo N command effects**. Per-path restore; files you edited since are skipped.

## Memory

`~/TonyAI-Projects/memory/` is an [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog) bundle: `global.md` (every mode) plus one file per mode. The agent appends bullets under `## Learned Facts`, each ending with an evidence tag — `[ran]`, `[read: path-or-url]`, `[told: user]`, `[recalled]`. Frontmatter (`generated: { by, at }`) is stamped automatically on every write; edit the files by hand whenever you like. `npm run okf-check` validates the bundle.
