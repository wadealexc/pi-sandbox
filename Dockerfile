FROM node:24-bookworm-slim

# System deps pi relies on (ripgrep, git, bash, TLS).
# fd comes from the read-write ~/.pi/agent/bin mount (host already has a
# working linux-x64 fd there), so we don't install it here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        git \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install pi. --ignore-scripts avoids running postinstall hooks from deps
# (minor supply-chain hardening, no functional impact).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# TUI niceties and a real HOME. node:24-bookworm-slim already ships a `node`
# user (uid 1000:1000) that owns /home/node, which matches the host uid we'll
# run as (--user 1000:1000) so files written into the workspace stay owned by
# the invoking user.
ENV TERM=xterm-256color
ENV HOME=/home/node
ENV GIT_CONFIG_GLOBAL=/home/node/.gitconfig

WORKDIR /workspace
ENTRYPOINT ["pi"]
