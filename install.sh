#!/usr/bin/env sh
# opencode-pixel-office installer for macOS and Linux (also WSL and Git Bash).
#   ./install.sh                      build + install globally (~/.config/opencode/plugins)
#   ./install.sh --host 0.0.0.0 --token auto
#   ./install.sh --project ~/code/app  install for one project only
#   ./install.sh --uninstall
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "✖ Node.js >= 22.18 wird benötigt (nur zum Bauen): https://nodejs.org"
  echo "  macOS: brew install node   ·   Linux: nvm install 22 / Paketmanager"
  exit 1
fi

ver=$(node -p 'process.versions.node')
major=${ver%%.*}
rest=${ver#*.}
minor=${rest%%.*}
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; }; then
  echo "✖ Node $ver ist zu alt – benötigt wird >= 22.18 (führt TypeScript direkt aus)."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "✖ npm fehlt (kommt normalerweise mit Node.js)."
  exit 1
fi

exec node scripts/install.ts "$@"
