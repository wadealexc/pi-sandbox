# pi-sandbox

Containerized wrapper around `pi`. Runs the pi TUI in a Docker container
with access to the current directory (read-write) and your pi config
(`~/.pi/agent`, read-write), and nothing else on the host.

## Files

- `Dockerfile` — image definition (`node:24-bookworm-slim` + pi).
- `pi-box` — the wrapper script invoked by the `spi` alias.

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
