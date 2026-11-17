/** An error that carries a code, so a caller can say what to try next. */
export class WispError extends Error {
  code: string;

  constructor(message: string, code = "WISP_ERROR") {
    super(message);
    this.name = "WispError";
    this.code = code;
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
