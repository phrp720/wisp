<script setup lang="ts">
import { ComputerTerminal01Icon, ContainerIcon, FlashIcon, GitBranchIcon, LaptopIcon, ReloadIcon } from "@hugeicons/core-free-icons";
import { onMounted, onBeforeUnmount, ref } from "vue";

/** The demo at the top: `wisp api` typed, then each step of the bolt coming up in turn. */
const command = "wisp api";
const typed = ref("");
const shown = ref(0);
const steps = [
  { mark: "✓", kind: "run", what: "docker compose up db", note: "in the background" },
  { mark: "✓", kind: "wait", what: "port 5432", note: "ready in 1.4s" },
  { mark: "✓", kind: "folder", what: "apps/api", note: "opened in your editor" },
  { mark: "✓", kind: "run", what: "pnpm dev", note: "in the background" },
  { mark: "✓", kind: "wait", what: "http://localhost:3000", note: "answered in 2.1s" },
  { mark: "✓", kind: "link", what: "http://localhost:3000", note: "focused its open tab" },
];
let timers: ReturnType<typeof setTimeout>[] = [];
function play() {
  timers.forEach(clearTimeout);
  timers = [];
  typed.value = "";
  shown.value = 0;
  [...command].forEach((_, at) => timers.push(setTimeout(() => (typed.value = command.slice(0, at + 1)), 400 + at * 70)));
  const start = 400 + command.length * 70 + 350;
  steps.forEach((_, at) => timers.push(setTimeout(() => (shown.value = at + 1), start + at * 420)));
  timers.push(setTimeout(play, start + steps.length * 420 + 4500));
}
onMounted(play);
onBeforeUnmount(() => timers.forEach(clearTimeout));

const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText("npm install -g @squaredasher/wisp");
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    // No clipboard here: the command is on screen to select by hand.
  }
}

/**
 * The features' icons, from Hugeicons (MIT): each one a list of SVG elements, drawn here
 * with their attributes turned from camelCase to the names SVG uses.
 */
type IconData = readonly (readonly [string, Record<string, unknown>])[];
const icons: Record<string, IconData> = {
  needs: FlashIcon as IconData,
  docker: ContainerIcon as IconData,
  restart: ReloadIcon as IconData,
  git: GitBranchIcon as IconData,
  laptop: LaptopIcon as IconData,
  tmux: ComputerTerminal01Icon as IconData,
};
function svgAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([name]) => name !== "key").map(([name, value]) => [name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value]));
}

const more = [
  { icon: "needs", title: "Bolts that need bolts", text: "Start the database before the API, even from another project. Each runs once per run." },
  { icon: "docker", title: "Docker services", text: "Point at a compose file. Wisp waits until they're healthy, and shows their logs." },
  { icon: "restart", title: "Restart on crash", text: "\"restart\": \"on-failure\" brings a server back, with a growing pause, like Kubernetes." },
  { icon: "git", title: "Git hooks and cron", text: "Run your Check before every push, or a Release every night." },
  { icon: "laptop", title: "macOS, Linux, Windows", text: "One file for every machine. Per-OS commands when they differ." },
  { icon: "tmux", title: "Over SSH, inside tmux", text: "Works the same on a server. Links are shown instead of opened." },
];

</script>

<template>
  <div class="home">
    <!-- The demo -->
    <section class="wrap demo-wrap">
      <div class="terminal" aria-label="A terminal running wisp api">
        <div class="bar"><span /><span /><span /><em>~/dev/acme</em></div>
        <pre><span class="dim">$ </span>{{ typed }}<span v-if="shown === 0" class="caret">▍</span>
<template v-if="shown > 0"><span class="dim">running</span> 🏢 Acme · <b>Work on api</b>
</template><template v-for="(step, at) in steps.slice(0, shown)" :key="at"><span class="ok">  {{ step.mark }}</span> <span class="dim">{{ step.kind.padEnd(6) }}</span> {{ step.what }} <span class="dim">· {{ step.note }}</span>
</template><template v-if="shown === steps.length"><span class="accent">everything is up</span><span class="dim"> · wisp ps shows it, wisp down api stops it</span></template></pre>
      </div>
    </section>

    <!-- Describe it once -->
    <section class="wrap split">
      <div>
        <p class="eyebrow">One file</p>
        <h2>Describe the job once.<br />Start it with one word.</h2>
        <p class="lead">
          A <b>bolt</b> is a named list of things to start, in order: a database, a server, a folder,
          a page. It lives in a <code>.wisp.json</code> next to your code, so the whole team gets it.
        </p>
        <p class="lead">Never written one? <code>wisp init</code> reads your <code>package.json</code>, compose files, Makefile or Procfile and writes it for you.</p>
        <a class="more" href="/docs/file">The file, step by step →</a>
      </div>
      <pre class="code"><span class="dim">{</span>
  <span class="key">"bolts"</span>: [{
    <span class="key">"label"</span>: <span class="str">"Work on api"</span>,
    <span class="key">"targets"</span>: [
      { <span class="key">"bolt"</span>: <span class="str">"Database"</span> },
      { <span class="key">"folder"</span>: <span class="str">"apps/api"</span> },
      { <span class="key">"run"</span>: <span class="str">"pnpm dev"</span>, <span class="key">"cwd"</span>: <span class="str">"apps/api"</span> },
      { <span class="key">"wait"</span>: <span class="str">"http://localhost:3000"</span> },
      { <span class="key">"url"</span>: <span class="str">"http://localhost:3000"</span> }
    ]
  }]
<span class="dim">}</span></pre>
    </section>

    <!-- The TUI -->
    <section class="wrap split reverse">
      <div>
        <p class="eyebrow">The TUI</p>
        <h2>Everything you run,<br />on one screen.</h2>
        <p class="lead">
          Type <code>wisp</code> for a full-screen view, like htop for your projects. Every bolt as a
          pipeline, every server and container with its live output, and a word when something
          crashes. Edit bolts through forms; you never have to touch JSON.
        </p>
        <a class="more" href="/docs/tui">Tour the TUI →</a>
      </div>
      <div class="screen tui" aria-label="Wisp's Running tab">
        <div class="tabs"><span class="accent">🔮 wisp</span><span class="dim">1 Bolts</span><u class="accent">2 Running</u><span class="ok">● 3</span><span class="dim">3 History</span></div>
        <div class="panes">
          <div class="pane list">
            <p class="dim small-caps">ACME</p>
            <p><b>⚡ Work on api</b> <span class="dim">#4</span><span class="right ok">● up</span></p>
            <p class="step"><span class="ok">✓</span> ⚡ Database<span class="right dim">1.4s</span></p>
            <p class="step selected"><span class="ok">●</span> api<span class="right dim">up 2h</span></p>
            <p class="step"><span class="ok">✓</span> wait for :3000</p>
            <p class="step"><span class="ok">✓</span> open localhost:3000</p>
          </div>
          <div class="pane output">
            <p><b>api</b> <span class="dim">pnpm dev</span> <span class="ok">● running</span></p>
            <p>▲ Next.js 16.1</p>
            <p>- Local: http://localhost:3000</p>
            <p><span class="ok">✓</span> Ready in 1.2s</p>
            <p>GET / 200 in 84ms</p>
            <p>GET /api/me 200 in 12ms</p>
          </div>
        </div>
      </div>
    </section>

    <!-- History -->
    <section class="wrap split">
      <div>
        <p class="eyebrow">Jobs and history</p>
        <h2>A small CI,<br />on your laptop.</h2>
        <p class="lead">
          Mark a bolt as a <b>job</b> (Check, Build, Release) and it runs to the end, stopping at
          the first failure. Every run is kept like a CI run: numbered, with its branch, commit,
          each step's time and output. Retry only what failed.
        </p>
        <a class="more" href="/docs/jobs">Jobs and history →</a>
      </div>
      <pre class="screen"><span class="bad">✗</span> <b>Check #7</b>   <span class="dim">main @ a1b2c3d  “fix cart total”  Failed  9.8s</span>

  <span class="dim">▸</span> <span class="ok">✓</span> run lint            3.1s  <span class="accent">▇▇▇▇</span>
  <span class="dim">▾</span> <span class="bad">✗</span> run test            6.7s  <span class="accent">▇▇▇▇▇▇▇▇</span>  <span class="bad">exited with code 1</span>
        <span class="dim">1</span> ✓ adds items
        <span class="dim">2</span> <span class="bad">✗ cart total: expected 42, got 41</span>
    <span class="dim">–</span> run build                 <span class="dim">not reached</span>

<span class="dim">r retry from test · R run it all again</span></pre>
    </section>

    <!-- Safe by default -->
    <section class="band">
      <div class="wrap split">
        <div>
          <p class="eyebrow">Safe by default</p>
          <h2>Nothing runs<br />until you say so.</h2>
        </div>
        <div>
          <p class="lead">
            A cloned repository could put anything in its <code>.wisp.json</code>. So its commands,
            and any file or app that would execute when opened, wait until you've read exactly what
            they are and allowed that file. Change one character, a <code>git pull</code> included,
            and it asks again.
          </p>
          <p class="lead">Coding agents can write and run bolts with Wisp, but they can't approve their own commands. That stays yours.</p>
          <a class="more" href="/docs/trust">How trust works →</a>
        </div>
      </div>
    </section>

    <!-- Also -->
    <section class="wrap">
      <h2 class="center">Also in Wisp</h2>
      <ul class="grid">
        <li v-for="item in more" :key="item.title">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
              <component :is="tag" v-for="([tag, attrs], at) in icons[item.icon]" :key="at" v-bind="svgAttrs(attrs)" />
            </svg>
          </span>
          <div>
            <p class="title">{{ item.title }}</p>
            <p class="text">{{ item.text }}</p>
          </div>
        </li>
      </ul>
    </section>

    <!-- Install -->
    <section class="wrap narrow cta">
      <h2>Free, open source, yours.</h2>
      <p class="lead">No account, no telemetry. One command to install, one word to start.</p>
      <button class="install" type="button" @click="copy">
        <span class="dim">$</span> npm install -g @squaredasher/wisp
        <span class="copy">{{ copied ? "copied" : "copy" }}</span>
      </button>
      <p class="small">Or a single binary for macOS, Linux and Windows from <a href="https://github.com/phrp720/wisp/releases">Releases</a>. Then <a href="/docs/getting-started">get started</a>.</p>
    </section>
  </div>
</template>

<style scoped>
.home { padding-bottom: 48px; }
.wrap { max-width: 1152px; margin: 0 auto; padding-left: 24px; padding-right: 24px; }
.narrow { max-width: 760px; }
section { padding-top: 72px; padding-bottom: 72px; }
section + section { border-top: 1px solid var(--vp-c-divider); }
.wrap.split, .band .split { display: grid; gap: 40px; align-items: center; }
@media (min-width: 960px) {
  .wrap.split, .band .split { grid-template-columns: 1fr 1.1fr; gap: 64px; }
  .split.reverse > :first-child { order: 2; }
}
h2 { font-size: 36px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 16px; border: 0; padding: 0; }
h2.center { text-align: center; margin-bottom: 40px; }
.eyebrow { color: var(--vp-c-brand-1); font-weight: 600; font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; margin: 0 0 12px; }
.lead { color: var(--vp-c-text-2); font-size: 17px; line-height: 1.65; margin: 0 0 14px; }
.more { display: inline-block; margin-top: 6px; font-weight: 600; color: var(--vp-c-brand-1); }
.more:hover { text-decoration: underline; }

pre { margin: 0; font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.6; white-space: pre; overflow-x: auto; }
.terminal, .code, .screen { background: var(--wisp-terminal-bg); color: var(--wisp-terminal-fg); border-radius: 14px; border: 1px solid var(--wisp-line); box-shadow: var(--wisp-shadow); }
.code, .screen { padding: 22px 24px; }
.demo-wrap { padding-top: 8px; padding-bottom: 72px; border-top: 0 !important; }
.terminal { max-width: 760px; margin: 0 auto; overflow: hidden; }
.terminal pre { padding: 20px 24px 24px; min-height: 270px; font-size: 14px; }
.bar { display: flex; gap: 8px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--wisp-divider); }
.bar span { width: 12px; height: 12px; border-radius: 50%; background: var(--wisp-dots); }
.bar em { margin-left: auto; font-style: normal; font-size: 12px; color: var(--wisp-dim); font-family: var(--vp-font-family-mono); }
.dim { color: var(--wisp-dim); }
.ok { color: var(--wisp-ok); }
.bad { color: var(--wisp-bad); }
.accent { color: var(--wisp-accent); }
.key { color: var(--wisp-key); }
.str { color: var(--wisp-str); }
.caret { animation: blink 1s steps(1) infinite; color: var(--wisp-accent); }
@keyframes blink { 50% { opacity: 0; } }

.band { background: var(--wisp-band-bg); color: var(--wisp-band-text); border: 0 !important; }
.band h2 { color: var(--wisp-band-title); }
.band .lead { color: var(--wisp-band-text); }
.band code { background: var(--wisp-band-code-bg); color: var(--wisp-band-code); }

.grid { list-style: none; padding: 0; margin: 0; display: grid; gap: 28px 40px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.grid li { display: flex; gap: 14px; align-items: flex-start; margin: 0; }
.icon { flex-shrink: 0; width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); border: 1px solid rgba(167, 139, 250, 0.25); }
.title { font-weight: 600; margin: 0 0 4px; color: var(--vp-c-text-1); }
.text { margin: 0; color: var(--vp-c-text-2); line-height: 1.55; font-size: 15px; }

.center-text { text-align: center; }
.cta { text-align: center; }
.install { margin: 18px auto 12px; display: inline-flex; gap: 12px; align-items: center; font-family: var(--vp-font-family-mono); font-size: 15px; background: var(--wisp-terminal-bg); color: var(--wisp-terminal-fg); border: 1px solid rgba(167, 139, 250, 0.3); border-radius: 12px; padding: 14px 18px; cursor: pointer; }
.install:hover { border-color: var(--vp-c-brand-1); }
.copy { font-family: var(--vp-font-family-base); font-size: 12px; color: var(--wisp-accent); border-left: 1px solid var(--wisp-line); padding-left: 12px; }
.small { font-size: 14px; color: var(--vp-c-text-2); }
.small a { color: var(--vp-c-brand-1); }

.tui { font-family: var(--vp-font-family-mono); font-size: 13px; padding: 16px 18px 18px; }
.tui p { margin: 0; line-height: 1.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tabs { display: flex; gap: 18px; align-items: center; margin-bottom: 12px; }
.tabs .ok { margin-left: -12px; }
.panes { display: grid; grid-template-columns: 1fr 1.15fr; gap: 10px; }
.pane { border: 1px solid rgba(167, 139, 250, 0.22); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.pane.list { border-color: rgba(167, 139, 250, 0.45); }
.small-caps { font-size: 11px; letter-spacing: 0.06em; }
.step { padding-left: 14px; position: relative; }
.step.selected { color: var(--wisp-accent); font-weight: 600; }
.step.selected::before { content: "❯"; position: absolute; left: 0; color: var(--wisp-accent); }
.right { float: right; padding-left: 8px; }
.output { color: var(--wisp-output); }
</style>
