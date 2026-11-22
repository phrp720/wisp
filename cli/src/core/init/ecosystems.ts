import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * What a project says about running itself, beyond package.json: Python, Java and Kotlin,
 * Go, Rust, Ruby, PHP, .NET, Deno and Elixir. Each finds the dev server its framework starts
 * (with the port it listens on) and the checks a Check job should run, using the project's
 * own runner: `uv run`, `poetry run`, `./gradlew`, `./mvnw`. Read just well enough for that,
 * from the files' text: no parsers, nothing installed.
 *
 * Looked for at the root and one folder down, where a `backend/` or `api/` usually sits.
 */
export interface Found {
  apps: { name: string; dir: string; command: string; port?: number }[];
  checks: { label: string; run: string; cwd?: string }[];
  tasks: { source: string; name: string; run: string }[];
  sources: string[];
}

/** Folders that are never a project of their own. */
const SKIP = new Set(["node_modules", "vendor", "dist", "build", "target", "out", "coverage", "venv", "env", "__pycache__", "bin", "obj", "deps", "_build", "tmp"]);

export async function detectEcosystems(root: string): Promise<Found> {
  const found: Found = { apps: [], checks: [], tasks: [], sources: [] };
  const dirs = ["", ...(await subfolders(root))];
  for (const dir of dirs) await detectIn(root, dir, found);
  return found;
}

async function detectIn(root: string, dir: string, found: Found): Promise<void> {
  const at = join(root, dir);
  const text = (name: string) => readFile(join(at, name), "utf8").catch(() => "");
  const has = (name: string) => exists(join(at, name));
  const name = dir ? basename(dir) : basename(root);
  const where = dir ? ` in ${dir}` : "";
  const app = (command: string, port: number | undefined, source: string) => {
    found.apps.push({ name, dir, command, ...(port ? { port } : {}) });
    found.sources.push(`${source}${where}`);
  };
  const check = (label: string, run: string) => {
    if (!found.checks.some((entry) => entry.run === run && (entry.cwd ?? "") === dir)) found.checks.push({ label, run, ...(dir ? { cwd: dir } : {}) });
  };

  // Python: the runner from the lockfile, the server from the framework.
  const pyproject = await text("pyproject.toml");
  const requirements = (await text("requirements.txt")) + (await text("requirements-dev.txt")) + (await text("Pipfile"));
  const python = pyproject + requirements;
  if (pyproject || requirements || (await has("manage.py"))) {
    const run = (await has("uv.lock")) ? "uv run " : (await has("poetry.lock")) ? "poetry run " : (await has("Pipfile")) ? "pipenv run " : "";
    if (await has("manage.py")) app(`${run}python manage.py runserver`, 8000, "Django");
    else if (/\bfastapi\b/i.test(python)) {
      const module = (await has("main.py")) ? "main" : (await has("app/main.py")) ? "app.main" : (await has("src/main.py")) ? "src.main" : undefined;
      if (module) app(`${run}uvicorn ${module}:app --reload`, 8000, "FastAPI");
    } else if (/\bflask\b/i.test(python)) app(`${run}flask run`, 5000, "Flask");
    if (/\bruff\b/.test(python)) check("lint", `${run}ruff check .`);
    if (/\bmypy\b/.test(python)) check("typecheck", `${run}mypy .`);
    if (/\bpytest\b/.test(python)) check("test", `${run}pytest`);
    if (await has("tox.ini")) check("test", "tox");
    if (await has("noxfile.py")) check("test", "nox");
    for (const task of section(pyproject, "tool.poe.tasks")) found.tasks.push({ source: "poe", name: task, run: `poe ${task}` });
    for (const task of section(pyproject, "tool.pdm.scripts")) found.tasks.push({ source: "pdm", name: task, run: `pdm run ${task}` });
  }

  // Java and Kotlin: Gradle or Maven, through its wrapper when the project has one.
  const gradle = (await text("build.gradle")) + (await text("build.gradle.kts"));
  if (gradle) {
    const tool = (await has("gradlew")) ? "./gradlew" : "gradle";
    if (/org\.springframework\.boot/.test(gradle)) app(`${tool} bootRun`, 8080, "Spring Boot (Gradle)");
    check("test", `${tool} test`);
    found.sources.push(`Gradle${where}`);
  }
  const pom = await text("pom.xml");
  if (pom) {
    const tool = (await has("mvnw")) ? "./mvnw" : "mvn";
    if (/spring-boot/.test(pom)) app(`${tool} spring-boot:run`, 8080, "Spring Boot (Maven)");
    check("test", `${tool} test`);
    found.sources.push(`Maven${where}`);
  }

  // Go and Rust.
  if (await has("go.mod")) {
    if (await has("main.go")) app("go run .", undefined, "Go");
    check("vet", "go vet ./...");
    check("test", "go test ./...");
  }
  if (await has("Cargo.toml")) {
    if (await has("src/main.rs")) app("cargo run", undefined, "Rust");
    check("test", "cargo test");
  }

  // Ruby on Rails.
  if (await has("bin/rails")) {
    app("bin/rails server", 3000, "Rails");
    check("test", (await has("spec")) ? "bundle exec rspec" : "bin/rails test");
  } else if ((await has("Gemfile")) && (await has("spec"))) check("test", "bundle exec rspec");

  // PHP: Laravel, and composer's own scripts.
  if (await has("artisan")) {
    app("php artisan serve", 8000, "Laravel");
    check("test", "php artisan test");
  }
  const composer = await json(join(at, "composer.json"));
  const composerScripts = composer?.["scripts"];
  if (composerScripts && typeof composerScripts === "object") {
    for (const script of Object.keys(composerScripts)) {
      if (/^(test|lint|analyse|analyze|check|cs)$/.test(script)) check(script, `composer run ${script}`);
    }
  }

  // .NET: a project that is a web app runs; any solution tests.
  const files = await readdir(at).catch(() => [] as string[]);
  const csproj = files.find((file) => file.endsWith(".csproj"));
  if (csproj && /Microsoft\.NET\.Sdk\.Web/.test(await text(csproj))) app("dotnet watch run", 5000, ".NET");
  if (csproj || files.some((file) => file.endsWith(".sln"))) check("test", "dotnet test");

  // Deno: its tasks, like package.json's scripts.
  const deno = (await json(join(at, "deno.json"))) ?? (await json(join(at, "deno.jsonc")));
  const denoTasks = deno?.["tasks"];
  if (denoTasks && typeof denoTasks === "object") {
    for (const task of Object.keys(denoTasks)) found.tasks.push({ source: "deno", name: task, run: `deno task ${task}` });
  }

  // Elixir, and Phoenix.
  const mix = await text("mix.exs");
  if (mix) {
    if (/:phoenix\b/.test(mix)) app("mix phx.server", 4000, "Phoenix");
    check("test", "mix test");
  }
}

/** The keys of a `[table]` in a TOML file: the task names under `[tool.poe.tasks]`, say. */
export function section(toml: string, table: string): string[] {
  const start = toml.indexOf(`[${table}]`);
  if (start < 0) return [];
  const body = toml.slice(start + table.length + 2).split(/\n\s*\[/)[0] ?? "";
  return [...body.matchAll(/^\s*([\w-]+)\s*=/gm)].map((match) => match[1] as string);
}

async function subfolders(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, 40);
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => undefined));
}

async function json(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
