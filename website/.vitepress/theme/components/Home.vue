<script setup lang="ts">
import { ComputerTerminal01Icon, ContainerIcon, Copy01Icon, FlashIcon, GitBranchIcon, LaptopIcon, ReloadIcon, Tick02Icon } from "@hugeicons/core-free-icons";
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

/** The ways to install, as tabs: the one that needs nothing first. */
const installs = [
  { tab: "macOS & Linux", command: "curl -fsSL https://willowisp.dev/install.sh | sh" },
  // Windows has no one-line installer: it says, in words, the two ways there are.
  { tab: "Windows", command: "" },
  { tab: "npm", command: "npm install -g @squaredasher/wisp" },
];
const tab = ref(0);
const copied = ref("");
async function copy(command: string) {
  try {
    await navigator.clipboard.writeText(command);
    copied.value = command;
    setTimeout(() => (copied.value = ""), 1600);
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
        <p class="lead">A <b>bolt</b> lists what to start, in order, in a <code>.wisp.json</code> the whole team shares. <code>wisp init</code> writes it from what your project already has.</p>
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

    <!-- The dashboard: a recording of real Wisp -->
    <section class="wrap showcase">
      <div class="showcase-text">
        <p class="eyebrow">The dashboard</p>
        <h2>Everything you run, on one screen.</h2>
        <p class="lead">Type <code>wisp</code>: every bolt, every server and container with its live output, and a word when something crashes. No JSON to touch.</p>
        <a class="more" href="/docs/dashboard">Tour the dashboard →</a>
      </div>
      <img class="recording" src="/demo/dashboard.gif" width="1400" height="760" loading="lazy" alt="Wisp's dashboard: running the Work on api bolt, its server's live output on the Running tab, then the History tab" />
    </section>

    <!-- History: a recording of real Wisp -->
    <section class="wrap showcase">
      <div class="showcase-text">
        <p class="eyebrow">Jobs and history</p>
        <h2>A small CI, on your laptop.</h2>
        <p class="lead">A <b>job</b> stops at the first failure, and every run is kept like a CI run, with its commit and each step's output. Retry only what failed.</p>
        <a class="more" href="/docs/jobs">Jobs and history →</a>
      </div>
      <img class="recording" src="/demo/jobs.gif" width="1400" height="760" loading="lazy" alt="A Check job fails at its test; History shows the run like CI, with the test's output; after the fix, --retry runs only the test, and it passes" />
    </section>

    <!-- Safe by default -->
    <section class="band">
      <div class="wrap split">
        <div>
          <p class="eyebrow">Safe by default</p>
          <h2>Nothing runs<br />until you say so.</h2>
        </div>
        <div>
          <p class="lead">A cloned repository's commands wait until you've read them and allowed that exact file. Any change asks again, and AI agents can't approve their own.</p>
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
      <div class="installer">
        <div class="tabs" role="tablist" aria-label="Install Wisp">
          <button
            v-for="(install, at) in installs"
            :key="install.tab"
            type="button"
            role="tab"
            :aria-selected="tab === at"
            :class="{ on: tab === at }"
            @click="tab = at"
          >
            {{ install.tab }}
          </button>
        </div>
        <p v-if="!installs[tab].command" class="windows">
          Install with <button type="button" class="inline" @click="tab = installs.findIndex((install) => install.tab === 'npm')">npm</button>, or download from the <a href="https://github.com/phrp720/wisp/releases">Releases page</a>.
        </p>
        <div v-else class="command">
          <code><span class="dim">$ </span>{{ installs[tab].command }}</code>
          <button type="button" class="copy" :aria-label="copied === installs[tab].command ? 'Copied' : 'Copy the command'" @click="copy(installs[tab].command)">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
              <component :is="t" v-for="([t, a], at) in (copied === installs[tab].command ? Tick02Icon : Copy01Icon) as IconData" :key="at" v-bind="svgAttrs(a)" />
            </svg>
          </button>
        </div>
      </div>
      <p class="small">Then <a href="/docs/getting-started">get started</a>: one file, one word.</p>
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
.terminal, .code { background: var(--wisp-terminal-bg); color: var(--wisp-terminal-fg); border-radius: 14px; border: 1px solid var(--wisp-line); box-shadow: var(--wisp-shadow); }
.code { padding: 22px 24px; }
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
.installer { max-width: 560px; margin: 28px auto 18px; text-align: left; border: 1px solid var(--wisp-line); border-radius: 14px; background: var(--wisp-terminal-bg); box-shadow: var(--wisp-shadow); overflow: hidden; }
.tabs { display: flex; gap: 4px; padding: 6px 6px 0; border-bottom: 1px solid var(--wisp-divider); }
.tabs button { font: inherit; font-size: 13px; font-weight: 500; color: var(--wisp-dim); background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 12px 9px; cursor: pointer; }
.tabs button:hover { color: var(--wisp-terminal-fg); }
.tabs button.on { color: var(--wisp-terminal-fg); border-bottom-color: var(--wisp-accent); }
.windows { margin: 0; padding: 18px; font-size: 14px; line-height: 1.6; color: var(--wisp-terminal-fg); }
.windows a, .windows .inline { color: var(--wisp-accent); text-decoration: underline; text-underline-offset: 2px; }
.windows .inline { font: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.windows code { font-family: var(--vp-font-family-mono); font-size: 13px; background: var(--wisp-band-code-bg); color: var(--wisp-band-code); padding: 2px 6px; border-radius: 4px; }
.command { display: flex; align-items: center; gap: 12px; padding: 16px 12px 16px 18px; }
.command code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; font-family: var(--vp-font-family-mono); font-size: 14px; color: var(--wisp-terminal-fg); background: none; padding: 0; }
.copy { flex-shrink: 0; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; border: 1px solid var(--wisp-line); background: none; color: var(--wisp-dim); cursor: pointer; }
.copy:hover { color: var(--wisp-accent); border-color: var(--wisp-accent); }
.small { font-size: 14px; color: var(--vp-c-text-2); }
.small a { color: var(--vp-c-brand-1); }

.showcase { display: grid; gap: 32px; }
.showcase-text { max-width: 640px; }
.recording { display: block; width: 100%; height: auto; border-radius: 12px; border: 1px solid var(--wisp-line); box-shadow: var(--wisp-shadow); background: #1e1e2e; }
</style>
