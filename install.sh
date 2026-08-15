#!/usr/bin/env sh
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 2nd1st
# open-mcp-apps — user install bootstrap.
#
#   curl -fsSL https://raw.githubusercontent.com/2nd1st/open-mcp-apps/main/install.sh | sh
#
# Clones the repo (or updates an existing clone) and runs the Node installer. The installer opens a
# short picker to choose which hosts to register into (Claude Desktop, Claude Code, Codex) and your
# permission preference — pass flags after `-s --` to skip it, e.g. `| sh -s -- --host codex` or
# `| sh -s -- --yes`. One clone, one server, one shared per-user store. Idempotent: safe to re-run.
# After it finishes, FULLY QUIT and reopen your host (Cmd-Q, not just close the window), then ask the
# AI in-host to show you how to use it.
set -eu

REPO="https://github.com/2nd1st/open-mcp-apps"
DIR="${OMA_DIR:-$HOME/open-mcp-apps}"

command -v git  >/dev/null 2>&1 || { echo "✗ git is required — install it, then re-run."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ Node 22+ is required — install it, then re-run."; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "→ Updating existing clone at $DIR"
  git -C "$DIR" pull --ff-only || {
    echo "✗ Update failed. If this clone predates a published-history rewrite (v0.2.0 re-rooted"
    echo "  the public repo), a fast-forward can never succeed again. Fresh start:"
    echo "      mv \"$DIR\" \"$DIR.bak\"   # then re-run this installer"
    echo "  Your apps and data are NOT in this folder — the store lives in your user data dir."
    exit 1
  }
else
  echo "→ Cloning open-mcp-apps into $DIR"
  git clone "$REPO" "$DIR"
fi

cd "$DIR"
node install.mjs "$@"
