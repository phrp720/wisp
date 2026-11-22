<script setup lang="ts">
import { AlarmClockIcon, ContainerIcon, Copy01Icon, DashboardSquare01Icon, FlashIcon, Folder01Icon, LaptopIcon, Layers01Icon, ReloadIcon, RoboticIcon, Rocket01Icon, SecurityCheckIcon, ServerStack01Icon, TaskDone01Icon, Tick02Icon, Time04Icon, WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { onMounted, onBeforeUnmount, ref } from "vue";

const command = "wisp acme dev";
const typed = ref("");
const shown = ref(0);
const steps = [
  { kind: "docker", what: "db", note: "healthy in 1.4s" },
  { kind: "run", what: "web  pnpm dev", note: "in the background" },
  { kind: "run", what: "api  pnpm dev", note: "after db, in the background" },
  { kind: "wait", what: "localhost:3000", note: "answered in 2.1s" },
  { kind: "link", what: "localhost:5173", note: "after the api and web" },
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

const installs = [
  { tab: "macOS & Linux", command: "curl -fsSL https://willowisp.dev/install.sh | sh" },
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
    copied.value = "";
  }
}

type IconData = readonly (readonly [string, Record<string, unknown>])[];
const icons: Record<string, IconData> = {
  flow: WorkflowSquare01Icon as IconData,
  folder: Folder01Icon as IconData,
  watch: DashboardSquare01Icon as IconData,
  history: Time04Icon as IconData,
  nested: FlashIcon as IconData,
  docker: ContainerIcon as IconData,
  restart: ReloadIcon as IconData,
  asks: SecurityCheckIcon as IconData,
  laptop: LaptopIcon as IconData,
  agents: RoboticIcon as IconData,
  stack: Layers01Icon as IconData,
  checks: TaskDone01Icon as IconData,
  deploy: Rocket01Icon as IconData,
  server: ServerStack01Icon as IconData,
  clock: AlarmClockIcon as IconData,
};

const kinds = [
  { kind: "run", label: "command" },
  { kind: "docker", label: "Docker" },
  { kind: "wait", label: "wait" },
  { kind: "link", label: "open" },
  { kind: "pipeline", label: "another pipeline" },
];
function svgAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([name]) => name !== "key").map(([name, value]) => [name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value]));
}

const pillars = [
  { icon: "flow", title: "In parallel, or in order", text: "Steps start together unless they wait for others, like the API for a healthy database." },
  { icon: "folder", title: "From any folder", text: "<code>wisp acme dev</code> from wherever you are. No <code>cd</code> first." },
  { icon: "watch", title: "Knows what it started", text: "Servers never start twice, each keeps its log, and <code>wisp down</code> stops it all." },
  { icon: "history", title: "History of every run", text: "Each run kept like CI, with its commit and output. Retry only what failed." },
];

const uses = [
  { icon: "stack", title: "Bring up a dev stack", flow: [["db:docker"], ["api:run"], ["page:link"]], text: "The database, the API once it's healthy, the web app beside them, then the page. One command stops it all.", link: "/docs/use-cases#bring-up-a-dev-stack" },
  { icon: "checks", title: "Check before you push", flow: [["lint:run", "types:run", "test:run"], ["build:run"]], text: "Lint, types and tests side by side, then the build. As a git hook, a failure stops the push.", link: "/docs/use-cases#check-before-you-push" },
  { icon: "deploy", title: "Release and deploy", flow: [["checks:pipeline"], ["deploy:run"], ["health:wait"]], text: "The checks first, then it asks where and asks before it goes. Every deploy's log is kept.", link: "/docs/use-cases#release-and-deploy" },
  { icon: "server", title: "Run a server", flow: [["pull:run"], ["install:run"], ["restart:run"]], text: "Pull, install, migrate and restart the app, the same way for whoever SSHs in, from whatever folder they land in.", link: "/docs/use-cases#run-a-server" },
  { icon: "clock", title: "Scheduled jobs", flow: [["dump:run"], ["prune:run"]], text: "Backups and cleanups from cron, stopped if they hang, with a message to Slack or ntfy if they fail.", link: "/docs/use-cases#scheduled-jobs" },
  { icon: "laptop", title: "Your own machine", flow: [["tunnel:run"], ["port 5433:wait"]], text: "Pipelines outside any repo: an SSH tunnel kept open and ready, your photos backed up to the NAS.", link: "/docs/use-cases#your-own-machine" },
];

const more = [
  { icon: "nested", title: "Shared steps, started once", text: "Run one pipeline inside others. The database starts once, however many need it." },
  { icon: "docker", title: "Docker, without the waiting", text: "Starts your compose services and moves on once they're healthy." },
  { icon: "restart", title: "Servers that come back", text: "A crashed server restarts on its own, and you see that it did." },
  { icon: "asks", title: "Asks when it matters", text: "A deploy can ask where to, and ask before it goes." },
  { icon: "laptop", title: "Same file, every machine", text: "Works the same on macOS, Linux and Windows, laptop or server." },
  { icon: "agents", title: "Ready for agents", text: "Every command takes <code>--json</code>, and nothing waits for a keypress without a terminal." },
];
</script>

<template>
  <div class="home">
    <section class="wrap demo-wrap">
      <div class="terminal" aria-label="A terminal in the home folder running wisp acme dev">
        <div class="bar"><span /><span /><span /><em>~ (any folder)</em></div>
        <pre><span class="dim">~ $ </span>{{ typed }}<span v-if="shown === 0" class="caret">▍</span>
<template v-if="shown > 0"><span class="dim">running</span> 🏢 Acme · <b>Dev</b>
</template><template v-for="(step, at) in steps.slice(0, shown)" :key="at"><span class="ok">  ✓</span> <span class="dim">{{ step.kind.padEnd(6) }}</span> {{ step.what.padEnd(15) }} <span class="dim">· {{ step.note }}</span>
</template><template v-if="shown === steps.length"><span class="accent">everything is up</span><span class="dim"> · wisp down dev stops it all</span></template></pre>
      </div>
    </section>

    <section class="wrap">
      <ul class="grid pillars">
        <li v-for="item in pillars" :key="item.title">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
              <component :is="tag" v-for="([tag, attrs], at) in icons[item.icon]" :key="at" v-bind="svgAttrs(attrs)" />
            </svg>
          </span>
          <div>
            <p class="title">{{ item.title }}</p>
            <p class="text" v-html="item.text" />
          </div>
        </li>
      </ul>
    </section>

    <section class="wrap split wide-right">
      <div>
        <p class="eyebrow">One file</p>
        <h2>Write the pipeline once.</h2>
        <p class="lead">A pipeline is a list of steps that start together unless they say what they wait for, with <code>after</code>. It lives in a <code>.wisp.json</code> next to your code, or in a personal workspace for what belongs to no repo. <code>wisp init</code> drafts pipelines from what your project already has, and the dashboard edits them through forms.</p>
        <ul class="places">
          <li><b>Commands</b> that keep running, like a server, or finish, like a test.</li>
          <li><b>Docker services</b>, ready when they're healthy.</li>
          <li><b>Waits</b> for a port, a website or a few seconds.</li>
          <li><b>Other pipelines</b>, and links, folders, files and apps to open.</li>
        </ul>
        <a class="more" href="/docs/steps">Every kind of step →</a>
      </div>
      <div class="pipeline">
        <svg class="graph" viewBox="0 0 600 150" role="img" aria-label="The Dev pipeline: db and web start together; api waits for db; a wait for port 3000 waits for api; the page opens once both up and web are done">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" class="arrow" />
            </marker>
          </defs>
          <path class="edge" d="M110,36 H146" marker-end="url(#arrow)" />
          <path class="edge" d="M250,36 H286" marker-end="url(#arrow)" />
          <path class="edge" d="M400,36 C425,36 422,76 446,76" marker-end="url(#arrow)" />
          <path class="edge" d="M110,116 H400 C425,116 422,76 446,76" marker-end="url(#arrow)" />
          <g v-for="node in [
            { x: 10, y: 16, w: 100, kind: 'docker', label: 'db' },
            { x: 150, y: 16, w: 100, kind: 'run', label: 'api' },
            { x: 290, y: 16, w: 110, kind: 'wait', label: ':3000' },
            { x: 10, y: 96, w: 100, kind: 'run', label: 'web' },
            { x: 450, y: 56, w: 140, kind: 'link', label: 'localhost:5173' },
          ]" :key="node.label">
            <rect class="node" :x="node.x" :y="node.y" :width="node.w" height="40" rx="9" />
            <text class="kind" :x="node.x + 12" :y="node.y + 15">{{ node.kind }}</text>
            <text class="label" :x="node.x + 12" :y="node.y + 32">{{ node.label }}</text>
          </g>
        </svg>
        <p class="graph-note">db and web start together · api waits for db · the page waits for both</p>
        <pre class="code"><span class="dim">{</span> <span class="key">"label"</span>: <span class="str">"Dev"</span>, <span class="key">"steps"</span>: [
  { <span class="key">"compose"</span>: <span class="str">"compose.yaml"</span>, <span class="key">"label"</span>: <span class="str">"db"</span> },
  { <span class="key">"run"</span>: <span class="str">"pnpm dev"</span>, <span class="key">"cwd"</span>: <span class="str">"api"</span>, <span class="key">"label"</span>: <span class="str">"api"</span>, <span class="key">"after"</span>: <span class="str">"db"</span> },
  { <span class="key">"run"</span>: <span class="str">"pnpm dev"</span>, <span class="key">"cwd"</span>: <span class="str">"web"</span>, <span class="key">"label"</span>: <span class="str">"web"</span> },
  { <span class="key">"wait"</span>: <span class="str">":3000"</span>, <span class="key">"label"</span>: <span class="str">"up"</span>, <span class="key">"after"</span>: <span class="str">"api"</span> },
  { <span class="key">"url"</span>: <span class="str">"localhost:5173"</span>, <span class="key">"after"</span>: [<span class="str">"up"</span>, <span class="str">"web"</span>] }
] <span class="dim">}</span></pre>
      </div>
    </section>

    <section class="wrap">
      <h2 class="center">Use cases</h2>
      <p class="lead center-lead">Each is a pipeline you write once, or let <code>wisp init</code> draft, and name as you like. Then you run it from whatever folder you're in as <code>wisp &lt;workspace&gt; &lt;pipeline&gt;</code>, e.g. <code>wisp shop deploy</code> for the Deploy pipeline of your Shop project.</p>
      <p class="legend" aria-hidden="true">
        <span v-for="entry in kinds" :key="entry.kind" class="legend-item" :class="`k-${entry.kind}`">{{ entry.label }}</span>
      </p>
      <ul class="places-grid">
        <li v-for="use in uses" :key="use.title">
          <div class="use-head">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                <component :is="tag" v-for="([tag, attrs], at) in icons[use.icon]" :key="at" v-bind="svgAttrs(attrs)" />
              </svg>
            </span>
            <p class="title">{{ use.title }}</p>
          </div>
          <div class="flow" aria-hidden="true">
            <template v-for="(stage, at) in use.flow" :key="at">
              <span v-if="at > 0" class="flow-arrow" />
              <span class="flow-stage" :class="{ joined: stage.length > 1 && at < use.flow.length - 1 }">
                <span v-for="step in stage" :key="step" class="flow-step" :class="`k-${step.split(':')[1]}`">{{ step.split(":")[0] }}</span>
              </span>
            </template>
          </div>
          <p class="text">{{ use.text }}</p>
          <a class="more" :href="use.link">See how →</a>
        </li>
      </ul>
    </section>

    <section class="wrap showcase">
      <div class="showcase-text">
        <p class="eyebrow">The dashboard</p>
        <h2>Everything you started, on one screen.</h2>
        <p class="lead">Type <code>wisp</code>: every workspace and its pipelines, what's running with its live output, and every past run. Run a pipeline with <code>⏎</code> and watch each step tick off. Edit them through forms, without touching JSON. The same over SSH and in tmux.</p>
        <a class="more" href="/docs/dashboard">Tour the dashboard →</a>
      </div>
      <Recording name="dashboard" alt="Wisp's dashboard: running a pipeline in its box, its server's live output on the Running tab, then the History tab" />
    </section>

    <section class="wrap showcase">
      <div class="showcase-text">
        <p class="eyebrow">History</p>
        <h2>Every run, kept like CI.</h2>
        <p class="lead">Each run is numbered, with its commit and each step's output and time. The first failure stops the run, a retry runs only what failed, and a timeout stops a step that hangs. Run a pipeline before every <code>git push</code>, or every night from cron.</p>
        <a class="more" href="/docs/history">History →</a>
      </div>
      <Recording name="jobs" alt="A Check pipeline fails at its test; History shows the run like CI, with the test's output; after the fix, --retry runs only the test, and it passes" />
    </section>

    <section class="wrap showcase side">
      <div class="showcase-text">
        <p class="eyebrow">On a server</p>
        <h2>Your server's runbook, runnable.</h2>
        <p class="lead">How to deploy, update and back up the app, written once next to it. Whoever SSHs in runs <code>wisp shop deploy</code> from any folder: it asks before it goes, and every run is kept. A backup from cron messages you when it fails, and what Wisp starts keeps running after you log out.</p>
        <a class="more" href="/docs/use-cases#run-a-server">Server use cases →</a>
      </div>
      <Recording name="server" alt="wisp shop deploy, from the home folder: it asks where, asks before it goes, then builds and ships" />
    </section>

    <section class="band">
      <div class="wrap split">
        <div>
          <p class="eyebrow">Safe by default</p>
          <h2>Nothing runs<br />until you say so.</h2>
        </div>
        <div>
          <p class="lead">A cloned project's commands wait until <code>wisp trust</code> has shown them to you and you've said yes. Change the file, even with a <code>git pull</code>, and it asks again. Agents can write pipelines, but never approve them.</p>
          <a class="more" href="/docs/trust">How trust works →</a>
        </div>
      </div>
    </section>

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
            <p class="text" v-html="item.text" />
          </div>
        </li>
      </ul>
    </section>

    <section class="wrap narrow cta">
      <h2>Free, open source, yours.</h2>
      <p class="lead">No account, no telemetry.</p>
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
      <p class="small">Next: <a href="/docs/getting-started">Getting started</a></p>
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
.terminal pre { padding: 20px 24px 24px; height: calc(8 * 1.6em + 44px); font-size: 14px; overflow-y: hidden; }
.bar { display: flex; gap: 8px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--wisp-divider); }
.bar span { width: 12px; height: 12px; border-radius: 50%; background: var(--wisp-dots); }
.bar span:nth-child(1) { background: #ff5f57; }
.bar span:nth-child(2) { background: #febc2e; }
.bar span:nth-child(3) { background: #28c840; }
.bar em { margin-left: auto; font-style: normal; font-size: 12px; color: var(--wisp-dim); font-family: var(--vp-font-family-mono); }
.dim { color: var(--wisp-dim); }
.ok { color: var(--wisp-ok); }
.bad { color: var(--wisp-bad); }
.accent { color: var(--wisp-accent); }
.key { color: var(--wisp-key); }
.str { color: var(--wisp-str); }
.caret { animation: blink 1s steps(1) infinite; color: var(--wisp-accent); }
@keyframes blink { 50% { opacity: 0; } }

.band { width: calc(100% - 48px); max-width: 1104px; margin: 24px auto; padding-top: 56px; padding-bottom: 56px; border-radius: 22px; border: 1px solid var(--wisp-line) !important; color: var(--wisp-band-text); background: radial-gradient(90% 140% at 0% 0%, var(--vp-c-brand-soft), transparent 60%), var(--wisp-band-bg); box-shadow: var(--wisp-shadow); }
.band .wrap { padding-left: 48px; padding-right: 48px; }
.band + section { border-top: 0; }
@media (max-width: 640px) { .band .wrap { padding-left: 24px; padding-right: 24px; } }
.band h2 { color: var(--wisp-band-title); }
.band .lead { color: var(--wisp-band-text); }
.band code { background: var(--wisp-band-code-bg); color: var(--wisp-band-code); }

.grid { list-style: none; padding: 0; margin: 0; display: grid; gap: 28px 40px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.grid li { display: flex; gap: 14px; align-items: flex-start; margin: 0; }
.icon { flex-shrink: 0; width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); border: 1px solid rgba(167, 139, 250, 0.25); }
.title { font-weight: 600; margin: 0 0 4px; color: var(--vp-c-text-1); }
.text { margin: 0; color: var(--vp-c-text-2); line-height: 1.55; font-size: 15px; }
.text :deep(code) { font-family: var(--vp-font-family-mono); font-size: 13px; padding: 1px 6px; border-radius: 4px; background: var(--vp-c-default-soft); color: var(--vp-c-text-1); white-space: nowrap; }

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

.places { margin: 0 0 20px; padding: 0; list-style: none; display: grid; gap: 10px; }
.places li { position: relative; padding-left: 18px; color: var(--vp-c-text-2); font-size: 16px; line-height: 1.55; }
.places li::before { content: ""; position: absolute; left: 2px; top: 0.65em; width: 6px; height: 6px; border-radius: 50%; background: var(--vp-c-brand-1); }
.places b { color: var(--vp-c-text-1); }
.showcase { display: grid; gap: 32px; }
@media (min-width: 960px) {
  .showcase.side { grid-template-columns: 0.75fr 1.25fr; align-items: center; gap: 48px; }
}
.places-grid { list-style: none; padding: 0; margin: 0; display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.places-grid li { margin: 0; padding: 22px; border: 1px solid var(--wisp-line); border-radius: 14px; background: var(--vp-c-bg-soft); display: flex; flex-direction: column; gap: 12px; }
.places-grid .title { margin: 0; font-size: 17px; }
.places-grid .more { margin-top: auto; font-size: 14px; }
.center-lead { max-width: 720px; margin: -24px auto 18px; text-align: center; }
.legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 18px; margin: 0 0 28px; font-size: 13px; color: var(--vp-c-text-2); }
.legend-item { display: inline-flex; align-items: center; gap: 7px; }
.legend-item::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--k); flex-shrink: 0; }
.k-run { --k: #7c3aed; }
.k-docker { --k: #2563eb; }
.k-wait { --k: #b45309; }
.k-link { --k: #047857; }
.k-pipeline { --k: #be185d; }
:global(.dark) .k-run { --k: #a78bfa; }
:global(.dark) .k-docker { --k: #60a5fa; }
:global(.dark) .k-wait { --k: #fbbf24; }
:global(.dark) .k-link { --k: #34d399; }
:global(.dark) .k-pipeline { --k: #f472b6; }
.use-head { display: flex; align-items: center; gap: 12px; }
.use-head .icon { width: 36px; height: 36px; border-radius: 9px; }
.center-lead code, .places-grid code { font-family: var(--vp-font-family-mono); font-size: 14px; }
.places-grid li { transition: border-color 0.2s, box-shadow 0.2s; }
.places-grid li:hover { border-color: color-mix(in srgb, var(--vp-c-brand-1) 55%, transparent); box-shadow: var(--wisp-shadow); }
.places-grid .more { text-decoration: none; }
.places-grid .more:hover { text-decoration: underline; }
.flow { container-type: inline-size; display: flex; align-items: center; justify-content: center; height: 108px; padding: 0 10px; border-radius: 12px; border: 1px solid var(--wisp-line); background-color: var(--wisp-terminal-bg); background-image: radial-gradient(circle, var(--wisp-divider) 1px, transparent 1.3px); background-size: 14px 14px; overflow: hidden; }
.flow-stage { position: relative; display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
.flow-stage.joined { padding-right: 14px; }
.flow-stage.joined::after { content: ""; position: absolute; right: 0; top: 12px; bottom: 12px; width: 9px; border: 1.5px solid var(--wisp-dim); border-left: 0; border-radius: 0 7px 7px 0; }
.flow-step { display: inline-flex; align-items: center; justify-content: center; font-family: var(--vp-font-family-mono); font-size: 12.5px; line-height: 1.5; white-space: nowrap; padding: 2px 11px; border-radius: 999px; color: var(--wisp-terminal-fg); background: color-mix(in srgb, var(--k) 13%, transparent); border: 1px solid color-mix(in srgb, var(--k) 50%, transparent); }
.flow-arrow { position: relative; flex-shrink: 0; width: 18px; height: 1.5px; margin: 0 7px 0 5px; background: var(--wisp-dim); }
@container (max-width: 270px) {
  .flow-step { font-size: 11.5px; padding: 2px 8px; }
  .flow-arrow { width: 12px; margin: 0 6px 0 3px; }
  .flow-stage.joined { padding-right: 11px; }
}
.flow-arrow::after { content: ""; position: absolute; right: -2px; top: -3.25px; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 6px solid var(--wisp-dim); }
.showcase-text { max-width: 640px; }
.pillars { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
@media (min-width: 960px) {
  .wrap.split.wide-right { grid-template-columns: 0.85fr 1.15fr; }
}
.pipeline { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.pipeline .code { font-size: 12.5px; padding: 18px 20px; }
.graph { width: 100%; height: auto; padding: 14px; border-radius: 14px; border: 1px solid var(--wisp-line); background: var(--wisp-terminal-bg); box-shadow: var(--wisp-shadow); }
.graph .edge { fill: none; stroke: var(--wisp-dim); stroke-width: 1.5; }
.graph .arrow { fill: var(--wisp-dim); }
.graph .node { fill: var(--vp-c-bg-soft); stroke: var(--vp-c-brand-1); stroke-opacity: 0.55; }
.graph .kind { fill: var(--wisp-dim); font-family: var(--vp-font-family-mono); font-size: 10px; }
.graph .label { fill: var(--wisp-terminal-fg); font-family: var(--vp-font-family-mono); font-size: 13px; }
.graph-note { margin: 0; text-align: center; font-size: 13px; color: var(--vp-c-text-2); }
</style>
