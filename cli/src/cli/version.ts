/**
 * The version `wisp --version` prints.
 *
 * A constant rather than a read of package.json, because a compiled binary has no
 * package.json beside it. A test keeps the two in step.
 */
export const VERSION = "0.1.1";
