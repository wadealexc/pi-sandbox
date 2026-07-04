# pi-sandbox

Containerized wrapper around `pi`. Two modes:

- **`spi` (TUI)** — runs the pi TUI in a Docker container with access to the
  current directory (read-write) and your pi config (`~/.pi/agent`, read-write),
  and nothing else on the host.
- **Web mode** — a browser front-end (`docker compose up`) that hosts a single
  persistent workspace you can upload files into and chat with a sandboxed pi
  agent through.

Both modes keep pi sandboxed: only the workspace and `~/.pi/agent` are
reachable on the host.

## Files

- `Dockerfile` — image definition (`node:24-bookworm-slim` + pi). Used by the
  `spi` alias.
- `pi-box` — the wrapper script invoked by the `spi` alias.
- `Dockerfile.agent` / `Dockerfile.web` / `docker-compose.yml` — the web-mode
  images and wiring.
- `agent-bridge/` — a tiny TCP↔stdio bridge baked into the agent image; lets
  the web server drive `pi --mode rpc` over the compose-internal network.
- `web/` — the web server and frontend (TypeScript).

## Install

Add to `~/.bashrc` (or wherever):

```bash
alias spi='/home/fox/sandbox/pi-box'
```

Optionally reroute model aliases to use the sandbox:

```bash
alias pi-glm="spi --model openrouter/z-ai/glm-5.2"
```

Reload: `source ~/.bashrc`.

## Build

The image builds automatically on first run, or on demand:

```bash
spi --build        # force rebuild (use after `pi update` on the host)
```

Built as `pi-sandbox:latest`. No rebuild happens on normal runs; `spi` just
launches a container from the cached image.

## Run

```bash
spi                       # launch the pi TUI in the current directory
spi <args...>             # pass args through to pi
spi --model openrouter/z-ai/glm-5.2
```

Args other than `--build` are forwarded to `pi` inside the container.

## Sandbox boundary

Read-write access: the current directory, and `~/.pi/agent` (so sessions,
settings, trust, `auth.json`, `models.json`, and the shared `bin/` persist
exactly like host pi). Files written into your project stay owned by your
own uid (the image's `node` user is uid 1000:1000).

Not reachable: anything else on the host (`~`, `~/.ssh`, other projects,
`/etc`, ...).

Not contained: network egress. The container has outbound network access by
default (needed to reach model APIs). A malicious script in the workspace
could exfiltrate files or probe your LAN. Filesystem isolation only.

---

# Web mode

A browser front-end for the sandboxed agent. Visit a single page, upload
files into a persistent workspace, and chat with pi — the agent streams its
responses and tool calls live. Two sibling containers, no docker socket:
the web server never touches Docker.

## Architecture

```
docker compose up
├─ agent   (pi --mode rpc + a tiny TCP bridge, sandboxed)
│    ├─ ./workspace:/workspace            ← its read/bash/edit/write tools
│    └─ ~/.pi/agent:…                      ← models.json, settings.json
│
└─ web     (TS server + static frontend)
     ├─ ./workspace:/workspace            ← upload/download/list/delete via fs
     └─ AGENT_ADDR=agent:8080              ← JSONL-RPC over the private network
```

The workspace is a relative bind-mount (`./workspace`) so it persists on the
host at a stable, inspectable location. The agent reads your pi config from
the host `~/.pi/agent` (via `$HOME` interpolation), so it picks up your local
model the same way `spi` does.

The existing `Dockerfile` / `pi-box` / `pi-sandbox:latest` are untouched —
the `spi` alias and the web mode are fully independent.

## Build & run

```bash
docker compose build
docker compose up -d
```

Then open `http://<this-host-LAN-IP>:8090` from another machine on your
network (the host may be headless).

Logs: `docker compose logs -f web agent`
Stop:  `docker compose down`

Rebuild after editing the server, frontend, or bridge:

```bash
docker compose build && docker compose up -d
```

## Using it

- **Files panel (left)** — drag/drop or click to upload; download (↓) or
  delete (✕) individual entries; "Clear all" wipes the workspace.
- **Chat (right)** — send a message; the agent streams its response and tool
  calls. Tool results render expanded, truncated to 30 lines with a toggle.
  The file list auto-refreshes after each completed tool call and after the
  turn ends.
- **Stop** — abort the current run mid-generation. In-progress output is
  dropped (completed messages and tool calls stay); the next message you send
  tells the agent its previous response was interrupted.
- **Clear chat** — start a fresh session (workspace files are unaffected).

## Sandbox boundary (web mode)

Read-write: `./workspace` and `~/.pi/agent` (the latter is effectively
read-only in practice: `pi` runs with `--no-session`, and the local model
uses `apiKey: "none"`, so nothing writes `auth.json` or session files).

Not reachable: anything else on the host. The agent's `bash` cannot reach the
web process, other host services, or `~/.ssh`.

**No auth.** Anyone who can reach `:8090` can upload/download/delete files
and drive the agent (which has `bash` on the workspace). Only expose this on
a trusted network, or put it behind a reverse proxy with auth.

Not contained: network egress (same as `spi` — needed to reach the model
API, which for the default local model is a LAN llama-cpp server).
