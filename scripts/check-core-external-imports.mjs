// AD-10: src/core/** must not import external packages (no node_modules, no
// `node:` builtins) — core is dependency-free. Any import specifier that is not
// relative (does not start with ".") fails the check with the offending file.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CORE_DIR = join(process.cwd(), "src", "core");
// Matches `from "..."`, `from '...'` and dynamic `import("...")` specifiers.
const SPECIFIER = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

const violations = [];
for (const file of walk(CORE_DIR)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(SPECIFIER)) {
    if (!match[1].startsWith(".") && !match[1].startsWith("node:")) {
      violations.push(`${relative(process.cwd(), file)} → "${match[1]}"`);
    }
  }
}

if (violations.length > 0) {
  console.error("AD-10: src/core/** must not import external packages — core imports nothing.");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
