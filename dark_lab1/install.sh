#!/bin/sh
# Installs this layout into the Herdr desktop app and switches to it.
#   ./install.sh            (from this folder, or with any path to it)
# Installs into $HERDR_APP_HOME, else ~/.config/herdr-app. Re-running updates it in place.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
name=$(basename "$here")
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}

[ -f "$here/layouts/$name.json" ] || { echo "$here doesn't look like a Herdr layout folder" >&2; exit 1; }
[ -d "$home" ] || { echo "Herdr home not found at $home - open Herdr once first (or set HERDR_APP_HOME)." >&2; exit 1; }

mkdir -p "$home/layouts" "$home/themes" "$home/mods"
cp "$here/layouts/"* "$home/layouts/"
[ -d "$here/themes" ] && cp "$here/themes/"* "$home/themes/"
for m in "$here/mods/"*/; do
  m=$(basename "$m"); rm -rf "$home/mods/$m"; cp -R "$here/mods/$m" "$home/mods/$m"
done
echo "installed $name"

# Herdr desktop doesn't recognize Devin yet. This entry names Devin terminals "Devin" so the
# context meter can find them. Added only when there's no programs.json yet; never overwritten.
if [ ! -f "$home/programs.json" ]; then
  cat > "$home/programs.json" <<'JSON'
{
  "programs": {
    "devin": { "name": "Devin", "icon": "icons/agent.svg", "tint": true, "match": ["devin"], "run": ["devin"] }
  }
}
JSON
  echo "added programs.json (Devin entry)"
elif ! grep -q '"devin"' "$home/programs.json"; then
  echo "tip: for Devin in the context meter, add to $home/programs.json under \"programs\":"
  echo '  "devin": { "name": "Devin", "icon": "icons/agent.svg", "tint": true, "match": ["devin"], "run": ["devin"] }'
fi

if command -v herdr-app >/dev/null 2>&1; then
  for m in "$here/mods/"*/; do herdr-app check "$m" >/dev/null 2>&1 || echo "warning: herdr-app check failed for $(basename "$m")"; done
  herdr-app do layout.switch "{\"name\":\"$name\"}" >/dev/null 2>&1 && echo "switched to $name" || true
fi
