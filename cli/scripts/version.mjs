import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const next = (process.argv[2] ?? "").replace(/^v/, "");

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(next)) {
  console.error(`"${process.argv[2] ?? ""}" is not a version like 0.2.0 or 1.0.0-beta.1`);
  process.exit(1);
}

const files = [
  { path: join(cli, "package.json"), pattern: /("version":\s*")[^"]+(")/ },
  { path: join(cli, "src", "cli", "version.ts"), pattern: /(export const VERSION = ")[^"]+(")/ },
];

const { version: before } = JSON.parse(await readFile(join(cli, "package.json"), "utf8"));
for (const file of files) {
  const text = await readFile(file.path, "utf8");
  if (!file.pattern.test(text)) {
    console.error(`no version found in ${file.path}`);
    process.exit(1);
  }
  await writeFile(file.path, text.replace(file.pattern, `$1${next}$2`));
}

console.log(`${before} → ${next} in cli/package.json and cli/src/cli/version.ts`);
