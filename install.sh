#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ABBES_ROOT="$(dirname "$INSTALL_DIR")"

# 1. Build nanoclaw if dist/ is missing
if [ ! -d "$INSTALL_DIR/dist" ]; then
    echo "[nanoclaw] Building..."
    cd "$INSTALL_DIR" && npm install && npm run build
fi

# 2. Locate node binary
NODE_BIN="$(command -v node 2>/dev/null || true)"
for candidate in "$HOME/.nvm/versions/node/"*/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$candidate" ] && NODE_BIN="$candidate" && break
done
[ -z "$NODE_BIN" ] && echo "ERROR: node not found" && exit 1

# 3. XDG config for nanoclaw
mkdir -p "$HOME/.config/nanoclaw"
if [ ! -f "$HOME/.config/nanoclaw/env" ]; then
    cp "$INSTALL_DIR/.env.example" "$HOME/.config/nanoclaw/env"
    # Migrate existing secrets if .env is present
    if [ -f "$INSTALL_DIR/.env" ]; then
        echo "" >> "$HOME/.config/nanoclaw/env"
        echo "# Migrated from nanoclaw/.env" >> "$HOME/.config/nanoclaw/env"
        cat "$INSTALL_DIR/.env" >> "$HOME/.config/nanoclaw/env"
    fi
    echo "Config installed at ~/.config/nanoclaw/env — verify secrets before starting"
else
    echo "Config already exists at ~/.config/nanoclaw/env — skipping"
fi

# 4. nanoclaw.service
mkdir -p "$HOME/.config/systemd/user"
sed -e "s|__HOME__|$HOME|g" \
    -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    "$INSTALL_DIR/nanoclaw.service.template" \
    > "$HOME/.config/systemd/user/nanoclaw.service"

# 5. whisper.service
sed -e "s|__HOME__|$HOME|g" \
    -e "s|__ABBES_ROOT__|$ABBES_ROOT|g" \
    "$INSTALL_DIR/whisper.service.template" \
    > "$HOME/.config/systemd/user/whisper.service"

# 6. Enable + start
systemctl --user daemon-reload
systemctl --user enable nanoclaw.service whisper.service
systemctl --user start whisper.service nanoclaw.service
echo "nanoclaw + whisper installed and started"
