// Opt-in updates for a layout shared from a GitHub repo. Off unless turned on.
//   notify: checks the repo's version.json every 6 hours and shows an UPDATE readout
//   auto:   same check, then downloads the folder and re-runs its install.sh
// Reads the source (repo, branch, folder) from this mod's own version.json, so the same file
// works for any layout that ships one. Uses curl and tar; nothing runs while the mode is off.
//
// In a mod: startUpdates(this, cx, { name: "my_layout", title: "My Layout" }) once in init, then
// draw a readout while view.updates.next or view.updates.busy is set; clicking it calls
// installUpdate(view, cx). Commands (herdr-app do <name>.<command>):
//   updates-off, updates-notify, updates-auto, update (install the repo's version now)
import { exec, appHome, readTextFile, nextCommand, notify } from "herdr";

export const MODES = ["off", "notify", "auto"];
export const CHECK_MS = 6 * 60 * 60 * 1000;

export function getMode() {
  try { const m = localStorage.getItem("updates"); return MODES.includes(m) ? m : "off"; } catch { return "off"; }
}
export function setMode(m) { try { localStorage.setItem("updates", m); } catch {} }

export async function localVersion(name) {
  try { return JSON.parse(await readTextFile(`${appHome()}/mods/${name}/version.json`)); } catch { return null; }
}

// true when version a is higher than b ("1.10.0" > "1.9.2")
export function isNewer(a, b) {
  const p = (v) => String(v ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

// The repo's version.json if it is newer than the installed one, else null.
export async function checkForUpdate(name) {
  const local = await localVersion(name);
  const src = local?.source;
  if (!src?.repo || !src?.folder) return null;
  const url = `https://raw.githubusercontent.com/${src.repo}/${src.branch ?? "main"}/${src.folder}/mods/${name}/version.json`;
  const r = await exec("curl", ["-fsSL", "--max-time", "15", url], { timeout: 20000 });
  const remote = JSON.parse(r.stdout);
  return isNewer(remote.version, local.version) ? remote : null;
}

const APPLY_SH = `set -eu
repo=$1 branch=$2 folder=$3 home=$4
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
curl -fsSL --max-time 120 "https://codeload.github.com/$repo/tar.gz/refs/heads/$branch" | tar -xz -C "$t"
d=$(find "$t" -mindepth 2 -maxdepth 2 -type d -name "$folder" | head -1)
[ -n "$d" ] && [ -f "$d/install.sh" ] || { echo "no $folder/install.sh in $repo" >&2; exit 3; }
HERDR_APP_HOME="$home" sh "$d/install.sh"
`;

// Downloads the layout's folder from its repo and runs its install.sh. Resolves true on success.
export async function applyUpdate(name) {
  const src = (await localVersion(name))?.source;
  if (!src?.repo || !src?.folder) return false;
  const r = await exec("sh", ["-c", APPLY_SH, "sh", src.repo, src.branch ?? "main", src.folder, appHome()], { timeout: 300000 });
  return /installed /.test(r.stdout);
}

export function startUpdates(view, cx, { name, title }) {
  view.updates = { name, title, next: null, busy: false };
  checkNow(view, cx);
  cx.timer.every(CHECK_MS, (cx) => checkNow(view, cx));
  cx.spawn(async (cx) => {
    for (;;) {
      const c = await nextCommand();
      const m = /^updates-(off|notify|auto)$/.exec(c ?? "");
      if (m) {
        setMode(m[1]);
        if (m[1] === "off") view.updates.next = null;
        notify({ title, body: `Updates: ${m[1]}`, timeout: 3000 });
        checkNow(view, cx);
      }
      if (c === "update") installUpdate(view, cx, true);
      cx.notify();
    }
  });
}

function checkNow(view, cx) {
  const u = view.updates;
  if (getMode() === "off" || u.busy) return;
  cx.spawn(async (cx) => {
    try { u.next = await checkForUpdate(u.name); } catch { return; }
    cx.notify();
    if (u.next && getMode() === "auto") installUpdate(view, cx);
  });
}

// force: install whatever the repo has, even without a newer version (the `update` command)
export function installUpdate(view, cx, force = false) {
  const u = view.updates;
  if (!u || u.busy || (!force && !u.next)) return;
  u.busy = true;
  const notes = u.next?.notes;
  cx.notify();
  cx.spawn(async (cx) => {
    let ok = false;
    try { ok = await applyUpdate(u.name); } catch {}
    u.busy = false;
    if (ok) u.next = null;
    notify(ok
      ? { title: `${u.title} updated`, body: notes ?? "Installed the latest version.", timeout: 6000 }
      : { title: `${u.title} update failed`, body: "Try again later, or re-run install.sh.", level: "error" });
    cx.notify();
  });
}
