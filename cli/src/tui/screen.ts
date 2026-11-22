const CLEARS = ["\u001B[2J\u001B[3J\u001B[H", "\u001B[2J\u001B[0f"];
const HOME = "\u001B[H";
const ERASE_LINE_END = "\u001B[K";
const ERASE_BELOW = "\u001B[J";

export function paintInPlace(chunk: string): string {
  for (const clear of CLEARS) {
    const at = chunk.indexOf(clear);
    if (at < 0) continue;
    const frame = chunk.slice(at + clear.length).split("\n").join(`${ERASE_LINE_END}\n`);
    return `${chunk.slice(0, at)}${HOME}${frame}${ERASE_LINE_END}${ERASE_BELOW}`;
  }
  return chunk;
}

export function inPlaceStdout(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  const write = (chunk: unknown, ...rest: unknown[]) =>
    (stdout.write as (...args: unknown[]) => boolean)(typeof chunk === "string" ? paintInPlace(chunk) : chunk, ...rest);
  return new Proxy(stdout, {
    get(target, key) {
      if (key === "write") return write;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
