import { AlarmClockIcon, ComputerTerminal01Icon, ContainerIcon, HourglassIcon, Notification01Icon, DashboardSquare01Icon, FlashIcon, Folder01Icon, LaptopIcon, Layers01Icon, ReloadIcon, RoboticIcon, Rocket01Icon, SecurityCheckIcon, ServerStack01Icon, TaskDone01Icon, Time04Icon, WorkflowSquare01Icon } from "@hugeicons/core-free-icons";

export type IconData = readonly (readonly [string, Record<string, unknown>])[];
export const icons: Record<string, IconData> = {
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
  notify: Notification01Icon as IconData,
  hangs: HourglassIcon as IconData,
  tools: ComputerTerminal01Icon as IconData,
};

export function svgAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([name]) => name !== "key").map(([name, value]) => [name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value]));
}

export interface UseCase {
  icon: string;
  title: string;
  flow: string[][];
  text: string;
  link: string;
  examples: { title: string; link: string }[];
}

export const uses: UseCase[] = [
  { icon: "stack", title: "Bring up a dev stack", flow: [["db:docker"], ["api:run"], ["page:link"]], text: "The database, the API once it's healthy, the web app beside them, then the page. One command stops it all.", link: "/docs/use-cases#bring-up-a-dev-stack", examples: [{ title: "The database, the API, the web app", link: "/docs/use-cases#the-database-the-api-the-web-app" }, { title: "Servers that come back", link: "/docs/use-cases#servers-that-come-back" }, { title: "Start over with a fresh database", link: "/docs/use-cases#start-over-with-a-fresh-database" }] },
  { icon: "checks", title: "Check before you push", flow: [["lint:run", "types:run", "test:run"], ["build:run"]], text: "Lint, types and tests side by side, then the build. As a git hook, a failure stops the push.", link: "/docs/use-cases#check-before-you-push", examples: [{ title: "Lint, types and tests, then the build", link: "/docs/use-cases#lint-types-and-tests-then-the-build" }] },
  { icon: "deploy", title: "Release and deploy", flow: [["checks:pipeline"], ["deploy:run"], ["health:wait"]], text: "The checks first, then it asks where and asks before it goes. Every deploy's log is kept.", link: "/docs/use-cases#release-and-deploy", examples: [{ title: "Deploy, asking first", link: "/docs/use-cases#deploy-asking-first" }, { title: "Tag a release once the checks pass", link: "/docs/use-cases#tag-a-release-once-the-checks-pass" }, { title: "Use a secret", link: "/docs/use-cases#use-a-secret" }] },
  { icon: "server", title: "Run a server", flow: [["pull:run"], ["install:run"], ["restart:run"]], text: "Pull, install, migrate and restart the app, the same way for whoever SSHs in, from whatever folder they land in.", link: "/docs/use-cases#run-a-server", examples: [{ title: "Update the app and restart it", link: "/docs/use-cases#update-the-app-and-restart-it" }, { title: "Keep an app running, without writing a service", link: "/docs/use-cases#keep-an-app-running-without-writing-a-service" }] },
  { icon: "clock", title: "Scheduled jobs", flow: [["dump:run"], ["prune:run"]], text: "Backups and cleanups from cron, stopped if they hang, and uptime checks that tell you once when a site goes down. Messages go to Slack, Teams or ntfy.", link: "/docs/use-cases#scheduled-jobs", examples: [{ title: "Back up every night", link: "/docs/use-cases#back-up-every-night" }, { title: "Clean up disk space every week", link: "/docs/use-cases#clean-up-disk-space-every-week" }, { title: "Uptime checks", link: "/docs/use-cases#uptime-checks" }] },
  { icon: "laptop", title: "Your own machine", flow: [["tunnel:run"], ["port 5433:wait"]], text: "Pipelines outside any repo: an SSH tunnel kept open and ready, your photos backed up to the NAS.", link: "/docs/use-cases#your-own-machine", examples: [{ title: "A tunnel to the production database", link: "/docs/use-cases#a-tunnel-to-the-production-database" }, { title: "Back up your photos", link: "/docs/use-cases#back-up-your-photos" }, { title: "Several projects at once", link: "/docs/use-cases#several-projects-at-once" }] },
];
