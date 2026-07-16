#!/bin/bash
# Lyra — one-command installer for macOS & Linux.
# Run it either way:
#   curl -fsSL https://raw.githubusercontent.com/Freespirits/lyra-ai-companion/main/install.command | bash
#   …or on a Mac, download this file and double-click it (right-click -> Open the first time, to get past Gatekeeper).
#
# It ensures Node, downloads the app, installs it (which also fetches the avatar
# bodies + seeds .env), then runs the cross-platform setup wizard (AI / voice /
# hearing choices + a double-click launcher). Prerequisites it can't silently
# install (Node, Ollama, the subscription CLIs) are opened for you with steps.
set -e

say(){ printf "  %s\n" "$1"; }
open_url(){ (open "$1" >/dev/null 2>&1 || xdg-open "$1" >/dev/null 2>&1 || true); }
have(){ command -v "$1" >/dev/null 2>&1; }

echo ""
say "Lyra — a talking, 3D avatar companion, on your machine."
echo ""

# 1) Node.js 20+
NEED_NODE=1
if have node; then
  MAJ=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  if [ "${MAJ:-0}" -ge 20 ] 2>/dev/null; then NEED_NODE=0; fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  say "Node.js 20+ is required and was not found."
  say "I'll open the download page — install the LTS version, then run this again."
  open_url "https://nodejs.org/en/download/prebuilt-installer"
  read -r -p "  Press Enter to close " _
  exit 0
fi
say "Node $(node -v) OK"

# 2) Download or update the app
DIR="$HOME/Lyra"
REPO="https://github.com/Freespirits/lyra-ai-companion"
if [ -d "$DIR/.git" ]; then
  say "Updating your existing install at $DIR ..."
  (cd "$DIR" && git pull --ff-only) || true
elif [ -d "$DIR" ]; then
  say "Using the existing folder $DIR"
else
  say "Downloading Lyra to $DIR ..."
  if have git; then
    git clone --depth 1 "$REPO.git" "$DIR"
  else
    TMP=$(mktemp -d)
    curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" -o "$TMP/lyra.tgz"
    tar -xzf "$TMP/lyra.tgz" -C "$TMP"
    mv "$TMP/lyra-ai-companion-main" "$DIR"
    rm -rf "$TMP"
  fi
fi
cd "$DIR"

# 3) Install (postinstall downloads the bodies + seeds .env)
echo ""
say "Installing — this also downloads her bodies (~75 MB), about a minute..."
npm install

# 4) Interactive setup: brain, voice, hearing, build, launcher
node scripts/setup-wizard.mjs

# 5) Offer to start her now
echo ""
read -r -p "  Start Lyra now? [Y/n] " GO
case "${GO:-Y}" in
  [Yy]*|"")
    LAUNCHER="$DIR/Lyra.command"; [ -f "$LAUNCHER" ] || LAUNCHER="$DIR/lyra-start.sh"
    if [ -f "$LAUNCHER" ]; then ( "$LAUNCHER" >/dev/null 2>&1 & ); fi
    ;;
esac
