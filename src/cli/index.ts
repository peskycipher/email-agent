import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { defaultHandlers, runCli } from "./main.js";

/**
 * Whether this module is the process's entry point. Only then does it parse argv, so a test can
 * import this file to pin the wiring instead.
 *
 * Both sides are realpath-normalised: `import.meta.url` is Node's resolved path, while
 * `process.argv[1]` is whatever the caller typed, so a symlinked entry — the `bin` shim Epic 11.3
 * adds — would otherwise never match and the CLI would silently do nothing. `import.meta.main` is
 * not available on the pinned Node 20, and `node -e`/`--eval` leave `argv[1]` unset, which the
 * `catch` covers.
 */
function isEntryPoint(entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  process.exitCode = await runCli(process.argv, defaultHandlers);
}
