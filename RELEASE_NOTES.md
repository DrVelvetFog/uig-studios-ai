## UIG Studios AI 1.4.1

- Repository renamed to `uig-studios-ai` (old URL redirects; the updater endpoint follows).
- Data directories renamed: `~/.tonyai` → `~/.uigai`, `~/TonyAI-*` → `~/UIG-AI/{Projects,Exports,Documents,Images}`. Migrated automatically on first launch — never overwrites, leaves symlinks at the old paths; the Python sandbox is recreated on first use. Stored paths in settings are remapped.
- Per-project instructions file is now `UIGAI.md` (`TONYAI.md` still recognised).
- Credential-store protection covers both old and new app directories.
