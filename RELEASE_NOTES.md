## UIG Studios AI 1.4.0 — first public release

A local-first desktop AI agent (Tauri 2 + React + Rust + Ollama; cloud and custom OpenAI-compatible endpoints optional), built to be checkable rather than magical.

**Trust features**
- Undo for shell commands (rv journal) alongside per-turn file checkpoints
- Evidence tiers per turn — ran / read / told / recalled — stamped by code, with a `ran-backed %` per model
- Verified examples with execution attestations, checked in CI
- Memory as an OKF bundle with per-fact evidence tags
- Credential stores unreadable by every tool; secret-looking payloads refused outbound; force-push/publish/uploads never allowlistable

**New in 1.4.0**
- First-run experience: Ollama detection, guided model pull sized to your RAM
- Signed release updates (Settings → Check for updates)
- Custom OpenAI-compatible endpoint provider (Hugging Face Inference Providers, LM Studio, vLLM, llama.cpp)
- Renamed to UIG Studios AI; author-specific defaults moved out of the code

macOS Apple Silicon only. Signed and notarized. Apache-2.0.
