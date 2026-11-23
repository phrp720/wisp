export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[1]) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1);
  return seconds > 0 ? seconds : undefined;
}

export function describeDuration(exact: number): string {
  const seconds = exact >= 59.95 ? Math.round(exact) : exact;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.round((seconds % 60) * 10) / 10;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", rest || (!hours && !minutes) ? `${rest}s` : ""].filter(Boolean).join(" ");
}
