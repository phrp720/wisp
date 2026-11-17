/** An error that carries a code, so a caller can say what to try next. */
export class SpecterError extends Error {
  code: string;

  constructor(message: string, code = "SPECTER_ERROR") {
    super(message);
    this.name = "SpecterError";
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
