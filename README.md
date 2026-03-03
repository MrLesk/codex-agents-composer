# Codex Agents Composer (ElectroBun)

Desktop app for managing Codex agents and assigning skills via drag and drop.

## What this MVP includes

- ElectroBun shell + React UI
- Agent-centric sidebar (project-scoped agents removed)
- Main skill catalog view (local + skills.sh)
- Drag/drop skill assignment from catalog to agent sidebar
- Agent detail editor (model, reasoning, instructions) + assigned/catalog board
- Agent persistence in Codex config (`~/.codex/config.toml` + per-agent config files)
- Skills metadata + assignment history in local SQLite
- Codex App Server integration for:
  - model list / reasoning options
  - local skills list
  - config read/write

## Run

```bash
bun install
bun run dev:hmr
```

## Build

```bash
bun run build
```

## Notes

- API server runs inside the Bun process on `http://127.0.0.1:8765`.
- Dragging a remote skill onto an agent runs:
  - `npx -y skills add <owner/repo> -g -a codex -s <skillId> -y`
- Remote catalog ingestion reads the `skills.sh` RSC payload embedded in the page response.
