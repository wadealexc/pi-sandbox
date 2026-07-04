# PLAN: pi-sandbox-web

A web front-end for the sandboxed pi setup. A browser page that lists,
uploads, deletes, and downloads files in a persistent workspace, and chats
with a containerized pi agent — streaming assistant text and tool calls live.

Two sibling containers, no docker socket, server code baked into its image.

## Non-goals (not in v0)

- Login, multi-user, multi-workspace. One persistent workspace volume.
- Chat persistence across server restart (`pi --mode rpc --no-session`).
- Multiple sessions / resume / fork. "Clear chat" = `new_session`.
- In-browser file content editing. Download only; no inline preview.
- Model picker / thinking controls / image inputs to the model.
- Steer/follow-up queueing (send is disabled while streaming → 409).
- Push-based file watching (see "File list freshness" below).
- Any docker-socket or DinD. The web server never touches Docker.

## Architecture

```
docker-compose.yml
├─ web      (TS server: static frontend + REST + SSE)
│    └─ workspace volume (rw)        ← upload/download/list/delete via fs
│    └─ no pi, no docker socket, no API keys
│
└─ agent    (pi --mode rpc + tiny TS TCP bridge, sandboxed)
     └─ workspace volume (rw)        ← for read/bash/edit/write tools
     └─ bind-mount host ~/.pi/agent  ← models.json/settings.json, local model
     └─ reaches the LAN llama-cpp server (network egress not contained —
        same as spi today)
     └─ exposes RPC over the compose-internal network via the bridge
```

The workspace is a shared named volume mounted into both. The web server does
file I/O directly (no reason to round-trip file ops through the agent). The
agent operates on the same files via its tools. The two containers share a
volume and otherwise only talk JSONL-RPC over the private compose network.

### Why sibling containers, not docker-socket-mount

The "server launches spi containers" pattern (mounting `/var/run/docker.sock`)
works but is worse for the threat model: it makes the server container
effectively root on the host. Two plain compose services with a shared volume
give the same agent sandboxing without the server ever touching Docker.

### Isolation guarantees

- The agent can't blow up the server or host. It lives in its own container
  with only the workspace + `~/.pi/agent` mounts. Its `bash` can't reach the
  web process, the host, or other services. (Same isolation `spi` gives.)
- API keys stay out of the web server. With the local llama-cpp model
  (`apiKey: "none"`) there are no credentials at all; the agent just reads
  `~/.pi/agent/models.json` + `settings.json` and uses the local model.
- Network egress from the agent is NOT contained — same as `spi` today, and
  required to reach the LAN llama-cpp server.

### Concurrency with a running `spi`

Both the web agent and a running `spi` may bind-mount host `~/.pi/agent`.
Safe because:

- Both read `models.json`/`settings.json` (read-only — fine).
- The web agent runs `pi --mode rpc --no-session`, so it writes no session
  files — no corruption risk to `spi`'s sessions.
- Local model (`apiKey: "none"`) means nothing writes `auth.json`.

## Preserving the existing `spi` workflow

The existing `Dockerfile`, `pi-box`, and image tag `pi-sandbox:latest` are
**untouched**. `pi-box` keeps building/running that image with its
`ENTRYPOINT ["pi"]` forever. The web work uses separate files:

- `Dockerfile` — untouched. Used by `pi-box`/`spi`. Tag `pi-sandbox:latest`.
- `Dockerfile.agent` — new. Same base as `Dockerfile` (node:24-bookworm-slim
  + pi) but self-contained and with the bridge as entrypoint.
  Tag `pi-sandbox-agent:latest`.
- `Dockerfile.web` — new. The server image. Tag `pi-sandbox-web:latest`.
- `docker-compose.yml` — new. Builds only the two new images/tags.

Adding new files/subdirs to the workspace is harmless to a running `spi`
container (it already has the dir mounted; new files just appear in `ls`).
Staying in this repo also keeps the current pi session alive (sessions are
keyed by cwd) — do not move to a new repo.

## Repo layout

```
pi-sandbox/                      (existing repo, extended)
  Dockerfile                     existing — UNTOUCHED (spi uses this)
  pi-box                         existing — UNTOUCHED
  README.md                      existing — update with a "Web mode" section
  docker-compose.yml             NEW — web + agent services, shared volumes
  Dockerfile.web                 NEW — server image
  Dockerfile.agent               NEW — agent image (bridge entrypoint)
  agent-bridge/
    src/bridge.ts                NEW — TCP socket ↔ pi --mode rpc stdio
    tsconfig.json
    package.json
  web/
    server/
      src/
        main.ts                  entrypoint: HTTP server + agent RPC client
        rpc-client.ts            JSONL-over-TCP client to the agent container
        routes/files.ts          GET /files, POST /files, DELETE /files/:name, GET /files/:name
        routes/chat.ts           POST /chat (SSE), POST /chat/clear
        workspace.ts             fs helpers over the workspace volume
      tsconfig.json
      package.json
    frontend/
      src/
        main.ts                  bootstrap, file-list loading, SSE handling, DOM render
        render.ts                transcript renderer (user/assistant/tool rows)
        api.ts                   fetch wrappers for /files + /chat
      index.html
      styles.css
      tsconfig.json
      package.json               vite + TS
      vite.config.ts
  workspace/                     created by compose named volume — NOT committed
```

## Component specs

### 1. `agent-bridge` (TS, ~50 lines)

Runs as the agent container's entrypoint. Bridges a TCP socket to
`pi --mode rpc`'s stdio.

- Listens on `0.0.0.0:8080` (compose-internal only — never published to the
  host in the final compose file; the web container reaches it as
  `agent:8080` over the private network).
- On each accepted connection: spawn
  `pi --mode rpc --no-session` with `cwd` = the workspace mount.
- Pipe `socket → child.stdin` and `child.stdout → socket`. Forward
  `child.stderr` to the bridge's own stdout for debugging (not over the
  socket — keep the socket to the JSONL protocol only).
- One connection at a time for v0. Reject additional connections while busy.
- On socket close or child exit: clean up; accept the next connection.

### 2. `web/server` (TS, Express + SSE)

- **Workspace**: bind-mounted volume at `/workspace`. All file ops are
  direct `fs` calls.
- **Agent RPC**: a single long-lived TCP connection to `agent:8080` over
  the compose network. `rpc-client.ts` keeps a JSONL reader (split on `\n`
  only, per the RPC docs — NOT `readline`, which splits on U+2028/U+2029)
  and:
  - `send(command)` writes one JSON line + `\n`.
  - separates responses (have an `id`) from events (no `id`).
  - maintains a pending-request promise map keyed by `id`.
- **Routes**:
  - `GET /files` → `{ files: [{ name, size, dir }] }` — flat top-level
    listing of the workspace.
  - `POST /files` → multipart; write each file into `/workspace`; return
    updated list.
  - `DELETE /files/:name` → `fs.rm`.
  - `GET /files/:name` → `res.download`.
  - `POST /chat` → opens SSE. Body `{ message }`. Sends
    `{"type":"prompt","message":...}` over RPC, then relays events to the
    client as SSE `data:` frames until `agent_end` (then closes the SSE).
    Maps events to a small JSON wire format:
    - `{kind:"text_delta",delta}`
    - `{kind:"tool_start",toolName,args}`
    - `{kind:"tool_end",toolName,result,isError}`
    - `{kind:"agent_end"}`
    (Discards thinking/queue/compaction events for v0.)
  - `POST /chat/clear` → sends `{"type":"new_session"}` over RPC; waits for
    the response; returns `{ok:true}`.
- **Streaming guard**: track `isStreaming` from `agent_start`→`agent_end`.
  `POST /chat` while streaming returns `409`.
- **Static**: serve `frontend/dist/` at `/`.
- No env vars beyond `WEB_PORT` (default 8090) and `AGENT_ADDR`
  (default `agent:8080`). No API keys.

### 3. `web/frontend` (vanilla TS + Vite)

Single page, three regions:

- **Left panel — Files**: table of rows (name, size, [download] [delete]).
  Upload dropzone + file input at the top. A **Refresh** button on the panel.
  Load `GET /files` on page load, on refresh, and after upload/delete.
  Also reload after each completed tool call and after each completed
  assistant response (so file changes the agent made show up without
  polling). Drop/upload → `POST /files` → refresh. Delete → `DELETE` →
  refresh. Download → link to `GET /files/:name`.
- **Right panel — Chat**: scroll transcript. Each entry is one of:
  - user bubble (the prompt text)
  - assistant text block (appended to live as `text_delta` events arrive,
    finalized at `agent_end`)
  - tool row: name, args (truncated), result text or error, success/error
    styling. **Expanded-by-default, truncated to ~30 lines with a toggle**
    to show full.
  - While streaming: show a "working…" indicator; input + send disabled.
- **Bottom — Input**: textarea + Send button + "Clear chat" button.
  Send → `POST /chat` opens SSE and streams. Clear → `POST /chat/clear`
  then wipes the transcript.
- Build: `vite build` → `frontend/dist/` (static `index.html` + JS + CSS).
  Server serves it.

### 4. `docker-compose.yml`

```yaml
services:
  agent:
    build:
      context: .
      dockerfile: Dockerfile.agent
    volumes:
      - workspace:/workspace
      - ${HOME}/.pi/agent:/home/node/.pi/agent   # bind-mount, like pi-box
    networks: [internal]
  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    ports: ["8090:8090"]
    volumes:
      - workspace:/workspace
    depends_on: [agent]
    environment:
      AGENT_ADDR: agent:8080
      WEB_PORT: "8090"
    networks: [internal]

volumes:
  workspace:

networks:
  internal:
```

### 5. `Dockerfile.agent`

Self-contained (does not `FROM pi-sandbox:latest`, so it builds without
requiring a prior `spi --build`):

```dockerfile
FROM node:24-bookworm-slim

# Same system deps as the spi Dockerfile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

# pi (same as spi).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# The bridge.
WORKDIR /agent-bridge
COPY agent-bridge/package.json agent-bridge/tsconfig.json ./
COPY agent-bridge/src ./src
RUN npm install && npm run build

ENV TERM=xterm-256color
ENV HOME=/home/node
ENV GIT_CONFIG_GLOBAL=/home/node/.gitconfig

WORKDIR /workspace
ENTRYPOINT ["node", "/agent-bridge/dist/bridge.js"]
```

### 6. `Dockerfile.web`

```dockerfile
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY web/server/package.json web/server/tsconfig.json ./server/
COPY web/server/src ./server/src
COPY web/frontend/package.json web/frontend/tsconfig.json web/frontend/vite.config.ts ./frontend/
COPY web/frontend/src ./frontend/src
COPY web/frontend/index.html web/frontend/styles.css ./frontend/
RUN cd server && npm install && npm run build
RUN cd frontend && npm install && npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/frontend/dist ./public
EXPOSE 8090
ENTRYPOINT ["node", "dist/main.js"]
```

## File list freshness

No continuous polling. The frontend reloads `GET /files`:

- on page load,
- on explicit Refresh button click,
- after upload and after delete,
- after each completed tool call (`tool_end`),
- after each completed assistant response (`agent_end`).

This avoids a continuous poll when nothing is happening, while still
surfacing file changes the agent makes.

## Sequence: happy path for one chat turn

1. Browser: user types, hits Send → `POST /chat {message}`.
2. Server: ensure not streaming; open SSE; send
   `{"type":"prompt","message":...}` over the TCP bridge.
3. Agent (`pi --mode rpc`): emits `agent_start`, `message_start`, repeated
   `message_update` (`text_delta`, `toolcall_*`), `tool_execution_start/
   update/end`, `turn_end`, `agent_end`.
4. Bridge: forwards each stdout line over the socket.
5. Server: parses each line; maps to SSE frames; writes them to the browser.
6. Frontend: appends text deltas to the live assistant bubble; renders tool
   rows on `tool_execution_*`; on `agent_end` finalizes, re-enables input,
   and reloads the file list.

## Build & run

- `docker compose build` builds `pi-sandbox-web` and `pi-sandbox-agent`.
- `docker compose up` runs them. Web at `http://localhost:8090`.
- Rebuild after editing server/frontend/bridge:
  `docker compose build` then `up -d`.
- `spi` / `pi-box` are unaffected — they still build and run
  `pi-sandbox:latest` from the untouched `Dockerfile`.

## Build order (when implementation begins)

1. `agent-bridge/` (Dockerfile.agent + bridge.ts) — verify `pi --mode rpc`
   answers over the bridge from a quick host-side test.
2. `web/server/` (rpc-client, workspace, files routes, chat SSE) — verify
   against the running agent container with `curl`.
3. `web/frontend/` (vite scaffold, file panel, chat transcript) — verify
   end-to-end in the browser.
4. `docker-compose.yml` + `Dockerfile.web` — wire both images and run
   `docker compose up`.
5. Update `README.md` with a "Web mode" section.
