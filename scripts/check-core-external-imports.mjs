// AD-10: src/core/** must not import external packages, `node:` builtins, or
// any specifier that is not a relative path (`./` or `../`) — core is
// dependency-free. Also enforces that every `src/core/**/*.ts` is either
// re-exported by `src/core/index.ts` or imported by at least one file under
// `src/`, so an orphan file cannot escape the guard.
//
// Three import forms are caught:
//   - `from "spec"` clauses (covers named, default, namespace, `import type`,
//     re-exports)
//   - bare side-effect imports `import "spec"`
//   - dynamic `import("spec")` calls
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(process.cwd(), "src");
const CORE_DIR = join(SRC_DIR, "core");
const BARREL = join(CORE_DIR, "index.ts");
const ALL_TS = /\.(?:ts|tsx|mts|cts)$/;

// Three branches; each captures the specifier in its own group (1, 2, 3).
const SPECIFIER =
  /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (ALL_TS.test(entry)) yield full;
  }
}

const allFiles = [...walk(SRC_DIR)];
const coreFiles = new Set(allFiles.filter((f) => f.startsWith(CORE_DIR + "/")));

// First pass: collect violations and build the importers graph.
// `importers` maps each file under `src/core/**` to the set of files (anywhere
// under `src/`) that import it. The barrel is a virtual importer for every
// file it re-exports.
const violations = [];
const importers = new Map();
for (const file of coreFiles) importers.set(file, new Set());

for (const file of allFiles) {
  const source = readFileSync(file, "utf8");
  const rel = relative(process.cwd(), file);
  for (const match of source.matchAll(SPECIFIER)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (!isRelative(spec)) {
      // External or `node:` import — not allowed in `src/core/**`.
      if (file.startsWith(CORE_DIR + "/")) {
        violations.push(`${rel} → "${spec}"`);
      }
      continue;
    }
    // Resolve the relative import against the file's directory.
    const dir = file.substring(0, file.lastIndexOf("/"));
    const resolved = join(dir, spec).replace(/[\\/]+$/, "");
    // Normalise the extension; the barrel re-exports with .js (ESM nodenext),
    // source files are .ts. Try both.
    const candidates = [
      resolved,
      `${resolved}.ts`,
      `${resolved}.js`,
      resolved.replace(/\.js$/, ".ts"),
      resolved.replace(/\.ts$/, ".js"),
    ];
    const target = candidates.find((c) => allFiles.includes(c));
    if (target && importers.has(target)) {
      importers.get(target).add(file);
    }
  }
}

if (violations.length > 0) {
  console.error("AD-10: src/core/** must not import external packages or `node:` builtins — core imports nothing.");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

// Second pass: a `src/core/**/*.ts` is an orphan iff no one imports it and the
// barrel does not re-export it. The barrel is the only file allowed to import
// without being imported itself, so it is always considered used.
const orphans = [...coreFiles].filter(
  (f) => f !== BARREL && importers.get(f).size === 0,
);
if (orphans.length > 0) {
  console.error("AD-10: every src/core/**/*.ts must be re-exported by src/core/index.ts or imported by some file under src/ — the following are orphans:");
  for (const orphan of orphans) console.error(`  ${relative(process.cwd(), orphan)}`);
  process.exit(1);
}
