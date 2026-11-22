export function quietOnClosedPipe(stream: NodeJS.EventEmitter, exit: (code: number) => void = (code) => process.exit(code)): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") return exit(0);
    throw error;
  });
}
