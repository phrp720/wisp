/** An error that carries a code, so a caller can say what to try next. */
export class WispError extends Error {
  code: string;
  hint: string | undefined;

  constructor(message: string, code = "WISP_ERROR", hint?: string) {
    super(message);
    this.name = "WispError";
    this.code = code;
    this.hint = hint;
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
