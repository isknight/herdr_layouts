// Dark Lab 1: one mod drawing every piece of the layout, chosen by props().part:
// banner (brand + live readouts over the lab skyline), bays (spaces + context window),
// lab (the glass-case art with a live label and blinking lights), tabs (folder tabs),
// history (a 30-minute curve of agent activity).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, focused, run, openOverlay, theme, window, props, exec, checking } from "herdr";
import { startUpdates, installUpdate } from "./updater.js";

const MONO = "JetBrains Mono";
const ART = "mods/dark_lab1";
const C = {
  ink: "#0e0616", panel: "#150a1e", pane: "#140a1c", tab: "#1a0f24", box: "#12071b",
  line: "#3d2a52", lineHi: "#6e5a80", text: "#ece6f5", muted: "#b3a6c6", dim: "#7a6a8e",
  mint: "#3ef0b0", amber: "#ffb020", pink: "#ff5fd2", lav: "#b89cff", slash: "#c77dff", unlit: "#2a1d38",
};
// Icons cycle through the bays; [width, height] of each source crop.
const ICONS = [["icon-tablet", 68, 60], ["icon-scope", 60, 66], ["icon-core", 68, 66]];
const STATUS = {
  working: { label: "Working", color: C.mint },
  blocked: { label: "Needs review", color: C.amber },
  done: { label: "Done", color: C.pink },
  idle: { label: "Idle", color: C.lav },
};
const stop = (_e, cx) => cx.stop_propagation();

// ---------- context window: read from each agent's own session log ----------
// Claude Code, Codex, pi and Devin each keep a local log with token usage; the script finds the log
// for this folder and prints its last usage line ($1 = agent kind, $2 = folder).
const CONTEXT_SH = `k="$1"; c="$2"; f=""; p='"usage"'
case "$k" in
claude) f=$(ls -t "$HOME/.claude/projects/$(printf %s "$c" | sed 's/[^A-Za-z0-9]/-/g')"/*.jsonl 2>/dev/null | head -1) ;;
pi) f=$(ls -t "$HOME/.pi/agent/sessions/--$(printf %s "$c" | sed 's#^/##; s#[/:]#-#g')--"/*.jsonl 2>/dev/null | head -1) ;;
codex) p='"token_count"'
  db=$(ls -t "$HOME"/.codex/state_*.sqlite 2>/dev/null | head -1)
  [ -n "$db" ] && f=$(sqlite3 "$db" "select rollout_path from threads where cwd='$(printf %s "$c" | sed "s/'/''/g")' order by updated_at desc limit 1" 2>/dev/null)
  if [ ! -f "$f" ]; then
    f=$(find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -mtime -14 2>/dev/null | xargs ls -t 2>/dev/null | grep rollout- | head -40 |
      while read -r r; do head -c 8000 "$r" | grep -qF "\\"cwd\\":\\"$c\\"" && { echo "$r"; break; }; done)
  fi ;;
devin)
  for dd in "$DEVIN_DATA_DIR" "$HOME/Library/Application Support/devin/cli" "$HOME/.local/share/devin/cli"; do
    [ -f "$dd/sessions.db" ] || continue
    id=$(sqlite3 "$dd/sessions.db" "select id from sessions where working_directory='$(printf %s "$c" | sed "s/'/''/g")' and coalesce(hidden,0)=0 order by last_activity_at desc limit 1" 2>/dev/null)
    [ -n "$id" ] && [ -f "$dd/transcripts/$id.json" ] && { f="$dd/transcripts/$id.json"; break; }
  done
  [ -n "$f" ] || exit 1
  t=$(tail -c 2000000 "$f" | tr -d '\n')
  m=$(printf %s "$t" | grep -o '"metrics": *{[^{}]*\\({[^{}]*}[^{}]*\\)*}' | tail -1)
  n=$(printf %s "$t" | grep -o '"generation_model": *"[^"]*"' | tail -1)
  [ -n "$n" ] || n=$(printf %s "$t" | grep -o '"model_name": *"[^"]*"' | tail -1)
  [ -n "$m" ] && printf '{%s,%s}\n' "$m" "$( [ -n "$n" ] && echo "$n" || echo '"none":0')"
  exit ;;
esac
[ -n "$f" ] && [ -f "$f" ] && tail -c 600000 "$f" | grep "$p" | tail -1`;
const PI_MODELS_SH = `cat "$HOME/.pi/agent/models-store.json" 2>/dev/null; echo; echo '#--'; cat "$HOME/.pi/agent/models.json" 2>/dev/null`;
const KINDS = { "claude-code": "claude", claude: "claude", codex: "codex", pi: "pi", devin: "devin", "devin-cli": "devin" };
const kindOf = (p) => (p && (KINDS[p.app] ?? KINDS[p.program?.key])) || null;
const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", pi: "pi", devin: "Devin" };

function contextTarget() {
  const all = panes(), f = focused();
  const mine = all.find((p) => p.pane === f?.pane);
  if (kindOf(mine)) return mine;
  return all.find((p) => p.tab === f?.tab && kindOf(p)) ?? all.find((p) => kindOf(p) && p.status === "working") ?? null;
}

// pi's log has the model id but not its window; pi's model lists do (contextWindow).
let piWindows = null;
async function loadPiWindows() {
  if (piWindows) return piWindows;
  const map = {};
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v.id === "string" && Number(v.contextWindow) > 0) map[v.id] = Number(v.contextWindow);
      Object.values(v).forEach(walk);
    }
  };
  try {
    const r = await exec("sh", ["-c", PI_MODELS_SH], { timeout: 5000 });
    for (const part of r.stdout.split("#--")) { try { walk(JSON.parse(part)); } catch {} }
  } catch {}
  return (piWindows = map);
}

// A props().context_window wins; then the size the agent logged (Codex, pi's model list);
// then for Claude models: "[1m]" ids, Claude 5-family ids and anything past 200k get 1M,
// older ones 200k. Unknown models get no window: the meter shows tokens used only.
function windowFor(kind, model, used, reported) {
  const forced = Number(props()?.context_window);
  if (forced > 0) return forced;
  if (reported > 0) return reported;
  if (kind !== "claude" && !/claude/i.test(model)) return null;
  if (/\[1m\]/i.test(model) || used > 200000) return 1000000;
  const gen = Number(model.match(/claude-(?:[a-z]+-)?(\d+)/i)?.[1] ?? 0);
  return gen >= 5 ? 1000000 : 200000;
}

// -> { used, max, pct, agent } (max/pct null when the window is unknown), or null.
async function readUsage(target) {
  const kind = kindOf(target);
  if (!kind || !target?.cwd) return null;
  const r = await exec("sh", ["-c", CONTEXT_SH, "sh", kind, target.cwd], { timeout: 5000 });
  const line = r.stdout.trim().split("\n").pop();
  if (!line) return null;
  const ev = JSON.parse(line);
  let used = 0, model = "", reported = 0;
  if (kind === "codex") {
    const info = ev?.payload?.info;
    const u = info?.last_token_usage ?? info?.total_token_usage;
    if (!u) return null;
    used = u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    reported = Number(info.model_context_window) || 0;
  } else if (kind === "pi") {
    const m = ev?.message, u = m?.usage;
    if (!u) return null;
    used = u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    model = String(m.model ?? "");
    reported = (await loadPiWindows())[model] ?? 0;
  } else if (kind === "devin") {
    const u = ev?.metrics;
    if (!u) return null;
    used = u.prompt_tokens != null
      ? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)
      : (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0) + (u.output_tokens ?? 0);
    model = String(ev.generation_model ?? ev.model_name ?? "");
  } else {
    const u = ev?.message?.usage ?? ev?.usage;
    if (!u) return null;
    used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    model = String(ev?.message?.model ?? "");
  }
  const max = windowFor(kind, model, used, reported);
  return { used, max, pct: max ? Math.min(100, Math.round((used / max) * 100)) : null, agent: AGENT_NAMES[kind] };
}
const kfmt = (n) => (n >= 1000000 ? `${+(n / 1000000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// ---------- rain: forward-only (`.loop` goes there and back, `.frames` only steps on) ----------
// Each drop is a column of one-character cells started together; cell r shows the glyph while
// the streak passes row r. Columns get their own gap, speed and start so they never line up.
function rain(x0, x1, height, count, { cell, len, ms }) {
  const rows = Math.max(4, Math.ceil(height / cell));
  return Array.from({ length: count }, (_, i) => {
    const x = Math.round(x0 + (((i * 37) % 97) / 97) * (x1 - x0));
    const total = rows + len + 1 + ((i * 7) % 6);
    const shift = (i * 17) % total;
    return div().absolute().left(x).top(0).w(cell).h(rows * cell).opacity(0.4)
      .text_color(i % 4 === 0 ? "#ff8af0" : "#b9b0ff").font_family(MONO).text_size(cell).line_height(cell)
      .children(Array.from({ length: rows }, (_, r) => div().absolute().left(0).top(r * cell).w(cell).h(cell)
        .frames(Array.from({ length: total }, (_, k) => {
          const f = (k + shift) % total;
          return r <= f && r > f - len ? "│" : " ";
        }), ms + (i % 3) * 3)));
  });
}

// ---------- activity history ----------
const BUCKET_MS = 30000, BUCKETS = 60;

export default class DarkLab extends View {
  init(_props, cx) {
    this.part = props()?.part ?? "banner";
    this.size = { width: 0, height: 0 };
    // opt-in updates from the repo (updater.js); off by default
    if (this.part === "banner" && !checking()) startUpdates(this, cx, { name: "dark_lab1", title: "Dark Lab" });
    if (this.part === "bays") {
      this.ctx = null;
      this.scroll = ScrollHandle.new();
      if (!checking()) {
        this.readContext(cx);
        cx.timer.every(5000, (cx) => this.readContext(cx));
      }
    }
    if (this.part === "history") {
      this.prev = {};
      try { this.hist = JSON.parse(localStorage.getItem("history") ?? "null"); } catch { this.hist = null; }
      if (!this.hist || !Array.isArray(this.hist.b)) this.hist = { at: Date.now(), b: [] };
      this.roll();
      cx.timer.every(BUCKET_MS, (cx) => { this.roll(); this.sample(); this.save(); cx.notify(); });
    }
  }

  sized(el) { return el.on_size_change((size, cx) => { this.size = size; cx.notify(); }); }

  // ---------- data ----------
  readContext(cx) {
    const target = contextTarget();
    if (!target?.cwd) { if (this.ctx) { this.ctx = null; cx.notify(); } return; }
    cx.spawn(async (cx) => {
      let next = null;
      try { next = await readUsage(target); } catch { next = this.ctx; }
      if (JSON.stringify(next) !== JSON.stringify(this.ctx)) { this.ctx = next; cx.notify(); }
    });
  }

  roll() {
    const now = Date.now();
    let steps = Math.floor((now - this.hist.at) / BUCKET_MS);
    if (steps <= 0 && this.hist.b.length) return;
    steps = Math.max(1, Math.min(steps, BUCKETS));
    for (let i = 0; i < steps; i++) this.hist.b.push({ w: 0, e: 0 });
    this.hist.b = this.hist.b.slice(-BUCKETS);
    this.hist.at = now;
  }

  sample() {
    const cur = this.hist.b[this.hist.b.length - 1];
    const list = agents();
    cur.w = Math.max(cur.w, list.filter((a) => a.status === "working").length);
    for (const a of list) {
      const was = this.prev[a.address];
      if (was && was !== a.status && (a.status === "done" || a.status === "blocked")) cur.e++;
      this.prev[a.address] = a.status;
    }
  }

  save() { try { localStorage.setItem("history", JSON.stringify(this.hist)); } catch {} }

  render() {
    switch (this.part) {
      case "bays": return this.bays();
      case "lab": return this.lab();
      case "tabs": return this.tabs();
      case "history": return this.history();
      default: return this.banner();
    }
  }

  // ---------- banner ----------
  banner() {
    const w = window();
    const lights = w?.platform === "macos" && !w?.fullscreen;
    const { width, height } = this.size;
    // image() always fits the whole picture at its own shape (it can't stretch), so work out
    // that fitted rectangle and place everything on it: the art, the rain (clipped to it), the
    // cut-out front layer, and the text on the picture's cleared areas (the brand plate from
    // x 14, the angled readout panel from x 1085, both in the top 38 of 108 rows).
    const IW = 1586, IH = 108;
    const s = width && height ? Math.min(width / IW, height / IH) : 1;
    const aw = IW * s, ah = IH * s, ox = (width - aw) / 2, oy = (height - ah) / 2;
    const bandH = Math.max(28, 38 * s);
    const space = spaces().find((x) => x.active);
    const list = agents();
    const working = list.filter((a) => a.status === "working").length;
    const branch = panes().find((p) => p.pane === focused()?.pane)?.branch ?? space?.branch;
    const field = (label, value, color = C.text) => h_flex().gap(8).items_center()
      .child(div().text_color(C.muted).child(label)).child(div().text_color(color).max_w(160).truncate().child(value));
    const sep = () => div().w(1).h(14).bg(C.line);
    const upd = this.updates;
    const art = (file) => image(`${ART}/art/${file}`).absolute().left(ox).top(oy).w(aw).h(ah);
    return this.sized(div().id("banner").size_full().relative().overflow_hidden().font_family(MONO))
      .when(width > 0, (el) => el
        .child(art("lab-banner.png"))
        // rain over the window view, then the art again with the glass cut out: frame, wall,
        // lamp and cables cover the drops, so it rains outside the window
        .child(div().absolute().left(ox).top(oy).w(aw).h(ah).overflow_hidden()
          .children(rain(606 * s, aw, ah, Math.round((aw - 606 * s) / 22), { cell: 7, len: 2, ms: 18 })))
        .child(art("lab-banner-front2.png"))
        .children(this.gear(ox, oy, s)))
      .child(h_flex().absolute().left(Math.max(lights ? 86 : 0, ox + 22 * s)).top(oy).h(bandH).gap(14).items_center()
        .child(div().font_bold().italic().text_size(18).text_color(C.slash).child("///"))
        .child(div().font_bold().text_size(20).text_color("#f4f0ff").child("DARK LAB")))
      .child(h_flex().absolute().left(ox + 1100 * s).right(Math.max(0, ox)).top(oy).h(bandH).pr(20).gap(16).items_center().justify_end().text_size(12.5)
        .when(Boolean(upd?.next || upd?.busy), (el) => el
          .child(h_flex().id("update").gap(8).items_center().cursor_pointer()
            .tooltip(upd.busy ? "Installing update…" : `${upd.next.notes ?? "New version"} · click to install`)
            .on_click((_e, cx) => installUpdate(this, cx))
            .child(div().text_color(C.muted).child("UPDATE"))
            .child(div().text_color(C.amber).child(upd.busy ? "…" : `v${upd.next.version}`)
              .when(upd.busy, (x) => x.loop("opacity", { from: 0.35, to: 1, period: 900, easing: "ease-in-out" }))))
          .child(sep()))
        .when(Boolean(branch), (el) => el.child(field("BRANCH", branch)).child(sep()))
        .child(field("AGENTS", `${working}/${list.length}`, working ? C.mint : C.text))
        .child(sep())
        .child(field("BAYS", String(spaces().length).padStart(3, "0")))
        .child(svg(`${ART}/flask.svg`).size(20).text_color(working ? C.mint : C.text)
          .when(working > 0, (x) => x.loop("opacity", { from: 0.45, to: 1, period: 1400, easing: "ease-in-out" }))));
  }

  // The lab equipment in the banner's left half, brought to life. Positions are in the
  // 1586×108 source art and land on the fitted picture through ox, oy and s.
  gear(ox, oy, s) {
    const at = (x, y, w, h) => div().absolute().left(ox + x * s).top(oy + y * s).w(w * s).h(h * s);
    const pulse = (from, to, period) => ({ from, to, period, easing: "ease-in-out" });
    // the green level meter: the art's bars are covered, then three bars rise and fall
    const bar = (x, lo, hi, period) => at(x, 70, 5, 23).flex().flex_col().justify_end()
      .child(div().w_full().bg(C.mint).h(hi * s).loop("height", { from: lo * s, to: hi * s, period, easing: "ease-in-out" }));
    // a status LED that softly blinks off and on (a dark cover fading in and out)
    const blink = (x, y, w, h, period) => at(x, y, w, h).bg("#120818").loop("opacity", pulse(0, 0.85, period));
    // a light that glows brighter now and then
    const glow = (x, y, w, h, color, to, period) => at(x, y, w, h).rounded(2 * s).bg(color).loop("opacity", pulse(0, to, period));
    return [
      at(411, 69, 23, 25).bg("#150d1f"),
      // small, slow drifts around each bar's painted height, so the meter idles rather than dances
      bar(413, 17, 21, 5200), bar(420.5, 7, 11, 4300), bar(428, 12, 16, 6100),
      // the orange digit display breathes
      glow(176, 75, 46, 15, "#ffa040", 0.22, 3200),
      glow(392, 82, 12, 9, "#ffb050", 0.3, 2400),
      // LEDs, each at its own pace
      blink(136, 79, 5, 5, 1900), blink(151, 80, 6, 4, 2700), blink(163, 80, 5, 4, 1500),
      blink(101, 70, 4, 5, 2300), blink(396, 73, 5, 4, 1100), blink(455, 70, 5, 4, 3100),
      blink(451, 95, 7, 4, 1700), blink(279, 86, 3, 6, 2900), blink(349, 69, 3, 3, 1300),
      // a scanner light sweeping along the pink slot of the right-hand box
      at(498, 75, 13, 5).child(div().absolute().top(0).w(4 * s).h(5 * s).bg("#fff0f8").opacity(0.75)
        .loop("left", { from: 0, to: 9 * s, period: 2600, easing: "ease-in-out" })),
    ];
  }

  // ---------- bays ----------
  bays() {
    const list = spaces();
    const active = list.findIndex((x) => x.active);
    if (active !== this.shownActive) { this.shownActive = active; if (active >= 0) this.scroll.scroll_to_item(active); }
    const row = (s, i) => {
      const st = STATUS[s.status ?? "idle"] ?? STATUS.idle;
      const [icon, iw, ih] = ICONS[i % ICONS.length];
      return h_flex().id(`bay-${s.id}`).mx(10).h(76).px(12).gap(16).items_center().rounded(10).cursor_pointer()
        .border_2().border_color(s.active ? st.color : "#00000000")
        .when(s.active, (el) => el.bg(`${st.color}14`))
        .when(!s.active, (el) => el.hover((h) => h.bg("#ffffff0a")))
        .on_click((e) => { if (e?.click_count === 2) run("space.rename", { id: s.id }); else run("space.select", { id: s.id }); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "space", target: { id: s.id } } }); })
        .child(div().w(64).h(60).flex_none().flex().items_center().justify_center()
          .child(image(`${ART}/art/${icon}.png`).w(iw * 0.88).h(ih * 0.88)))
        .child(v_flex().flex_1().min_w(0).gap(6)
          .child(div().truncate().text_size(15.5).text_color(C.text).child(s.name))
          .child(h_flex().gap(9).items_center().text_size(13.5).text_color(st.color)
            .child(div().size(11).flex_none().bg(st.color)
              .when(s.status === "working", (d) => d.loop("opacity", { from: 0.35, to: 1, period: 1100, easing: "ease-in-out" })))
            .child(st.label)));
    };
    const ctx = this.ctx, cells = 26;
    const lit = ctx?.pct != null ? Math.round((ctx.pct / 100) * cells) : 0;
    const hot = ctx?.pct >= 80;
    const rule = () => div().mx(20).h(1).flex_none().bg(C.line);
    return v_flex().size_full().font_family(MONO)
      .child(h_flex().h(54).flex_none().px(26).gap(14).items_center()
        .child(div().text_size(15).text_color(C.text).child("EXPERIMENT BAYS"))
        .child(div().text_size(15).text_color(C.dim).child(`[${list.length}]`))
        .child(div().flex_1())
        .child(div().id("bay-new").size(24).flex().items_center().justify_center().rounded(6).border_1().border_color(C.line)
          .text_size(14).text_color(C.mint).cursor_pointer().hover((h) => h.border_color(C.mint))
          .tooltip("New bay").on_click(() => run("space.new", {})).child("+")))
      .child(rule())
      .child(v_flex().id("bay-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pt(8).pb(8).gap(4).children(list.map(row)))
      .child(rule())
      .child(v_flex().flex_none().px(26).pt(16).pb(16).gap(12)
        .child(h_flex().items_center().justify_between()
          .child(div().text_size(15.5).text_color(C.text).child("Context"))
          .child(h_flex().gap(6).text_size(13.5)
            .child(div().text_color(hot ? C.amber : C.text).child(ctx?.pct != null ? `${ctx.pct}%` : "—"))
            .when(Boolean(ctx), (el) => el.child(div().text_color(C.muted).child(ctx.max ? `· ${kfmt(ctx.used)} / ${kfmt(ctx.max)}` : `· ${kfmt(ctx.used)} used`)))))
        .child(h_flex().h(14).gap(2).children(Array.from({ length: cells }, (_, i) =>
          div().flex_1().h_full().bg(i < lit ? (hot ? C.amber : C.mint) : C.unlit))))
        .child(div().text_size(12.5).text_color(C.dim).child(ctx ? ctx.agent : "no agent in focus")))
      .child(rule());
  }

  // ---------- lab art: cover-fit by hand so the label and lights land on the picture ----------
  lab() {
    const { width, height } = this.size;
    const IW = 392, IH = 480;
    const s = width && height ? Math.max(width / IW, height / IH) : 0;
    const l = (width - IW * s) / 2, t = (height - IH * s) * 0.35;
    const at = (x, y) => [l + x * s, t + y * s];
    const space = spaces().find((p) => p.active);
    const tab = space?.tabs.find((x) => x.active);
    const lead = tab && (panes().find((p) => p.tab === tab.id && p.program?.agent) ?? panes().find((p) => p.tab === tab.id));
    const label = [space?.name, tab ? (tab.named ? tab.name : lead?.program?.name ?? `Tab ${tab.index}`) : null].filter(Boolean).join(" · ");
    const busy = space?.status === "working";
    const [lx, ly] = at(80, 306), [m1x, m1y] = at(330, 296), [m2x] = at(352, 296), [sx, sy] = at(284, 168);
    return this.sized(div().id("lab").size_full().relative().overflow_hidden().rounded(10).font_family(MONO))
      .when(s > 0, (el) => el
        .child(image(`${ART}/art/lab.png`).absolute().left(l).top(t).w(IW * s).h(IH * s))
        // the monitor glows while the bay works; the console lights blink out of step
        .child(div().absolute().left(sx).top(sy).w(58 * s).h(58 * s).rounded(8 * s).bg(C.mint)
          .loop("opacity", { from: 0, to: busy ? 0.22 : 0.08, period: busy ? 900 : 2600, easing: "ease-in-out" }))
        .child(div().absolute().left(m1x).top(m1y).w(9 * s).h(8 * s).bg("#ffc46b").loop("opacity", { from: 0.1, to: 0.85, period: 1300, easing: "ease-in-out" }))
        .child(div().absolute().left(m2x).top(m1y).w(9 * s).h(8 * s).bg("#ffc46b").loop("opacity", { from: 0.1, to: 0.85, period: 1900, easing: "ease-in-out" }))
        .child(h_flex().absolute().left(lx).top(ly).w(240 * s).h(28 * s).px(10 * s).gap(10 * s).items_center()
          .child(div().font_bold().italic().text_size(12 * s).text_color(C.slash).child("///"))
          .child(div().flex_1().min_w(0).truncate().text_size(12 * s).text_color("#e9e0f5").child(label))));
  }

  // ---------- tabs ----------
  tabs() {
    const space = spaces().find((p) => p.active);
    const shown = (space?.tabs ?? []).filter((c) => !c.settled || c.active);
    const all = panes();
    const item = (c) => {
      const lead = all.find((p) => p.tab === c.id && p.program?.agent) ?? all.find((p) => p.tab === c.id);
      const prog = lead?.program;
      const name = c.named ? c.name : prog?.name ?? `Tab ${c.index}`;
      const icon = !prog || prog.shell ? svg(`${ART}/prompt.svg`).size(17)
        : prog.agent ? svg(`${ART}/flask.svg`).size(19)
        : svg(`${ART}/layers.svg`).size(17);
      const st = c.status && c.status !== "idle" ? STATUS[c.status] : null;
      return h_flex().id(`tab-${c.id}`).h(c.active ? 44 : 38).px(c.active ? 22 : 18).gap(10).items_center().flex_none().cursor_pointer()
        .rounded_t(10).border_1().border_b_0()
        .border_color(c.active ? C.lineHi : C.line).bg(c.active ? C.pane : C.tab)
        .text_size(c.active ? 15.5 : 14.5).text_color(c.active ? C.text : C.muted)
        .when(c.active, (el) => el.font_bold())
        .when(!c.active, (el) => el.hover((h) => h.text_color(C.text)))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); if (e.click_count === 2) run("tab.rename", { id: c.id }); else run("tab.select", { id: c.id }); })
        .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .child(div().text_color(c.active ? "#f4f0ff" : C.muted).child(icon))
        .child(div().max_w(200).truncate().child(c.zoomed ? `${name} ⤢` : name))
        .when(Boolean(st), (el) => el.child(div().size(8).bg(st.color)
          .when(c.status === "working", (d) => d.loop("opacity", { from: 0.3, to: 1, period: 900, easing: "ease-in-out" }))));
    };
    return h_flex().size_full().min_w(0).items_end().gap(6).font_family(MONO)
      .child(h_flex().id("tab-strip").h_full().min_w(0).flex_shrink_1().overflow_x_scroll().items_end().gap(6).children(shown.map(item)))
      .child(div().id("tab-new").mb(6).size(28).flex_none().flex().items_center().justify_center().rounded(6).border_1().border_color(C.line)
        .text_size(15).text_color(C.dim).cursor_pointer().hover((h) => h.text_color(C.mint).border_color(C.mint))
        .on_mouse_down("left", stop).on_click(() => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })).child("+"));
  }

  // ---------- history ----------
  history() {
    this.roll();
    this.sample();
    const b = this.hist.b;
    const pts = Array.from({ length: BUCKETS - b.length }, () => ({ w: 0, e: 0 })).concat(b);
    // smooth the working counts into a curve, then keep every other point (30 dots)
    let v = 0;
    const curve = pts.map((p) => (v = v * 0.6 + p.w * 0.4)).filter((_, i) => i % 2 === 1);
    const top = Math.max(1, ...curve);
    const live = agents().filter((a) => a.status === "working").length;
    const events = b.reduce((n, p) => n + p.e, 0);
    const col = (val, i) => {
      const last = i === curve.length - 1;
      const h = 3 + (val / top) * 30;
      return v_flex().flex_1().h_full().items_center().justify_end()
        .child(last
          ? div().size(12).flex_none().rounded(6).border_2().border_color(C.mint).bg(C.pane).flex().items_center().justify_center()
            .child(div().size(4).rounded(2).bg(C.mint)).loop("opacity", { from: 0.6, to: 1, period: 1200, easing: "ease-in-out" })
          : div().size(6).flex_none().rounded(3).bg(C.mint))
        .child(div().w_full().h(h).flex_none().bg(C.mint).opacity(0.08));
    };
    return h_flex().size_full().px(22).gap(18).items_center().font_family(MONO)
      .child(svg(`${ART}/bars.svg`).size(17).flex_none().text_color(C.lav))
      .child(h_flex().flex_none().gap(10).items_center()
        .child(div().text_size(14.5).text_color(C.text).child("Agent activity"))
        .child(div().text_size(14.5).text_color(C.dim).child("·"))
        .child(div().text_size(13).text_color(C.muted).child("WORKING"))
        .child(div().text_size(17).font_bold().text_color(live ? C.mint : C.text).child(String(live))))
      .child(div().w(1).h(38).flex_none().bg(C.line))
      .child(h_flex().flex_1().min_w(0).h(44).items_end().children(curve.map(col)))
      .child(div().w(1).h(38).flex_none().bg(C.line))
      .child(div().flex_none().text_size(13.5).text_color(C.muted).child(events ? `${events} hand-offs · 30 min` : "last 30 min"));
  }
}
