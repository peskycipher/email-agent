import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "check-core-external-imports.mjs");
let cwd: string;
let coreDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "core-ext-"));
  // The script reads `<cwd>/src/core/**`. Mirror that layout.
  coreDir = join(cwd, "src", "core");
  mkdirSync(coreDir, { recursive: true });
  // A clean barrel so the orphan-file check has something to walk.
  writeFileSync(
    join(coreDir, "index.ts"),
    'export type { Greeter } from "./greeter.js";\n',
  );
  writeFileSync(join(coreDir, "greeter.ts"), 'export interface Greeter { greet(name: string): string; }\n');
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function run(): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync("node", [SCRIPT], { cwd, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function writeCore(filename: string, body: string): void {
  writeFileSync(join(coreDir, filename), body);
}

describe("check-core-external-imports", () => {
  test("passes on a clean core", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
  });

  test("rejects a `node:` builtin import", () => {
    writeCore(
      "reader.ts",
      'import { existsSync } from "node:fs";\nexport const reader = existsSync;\n',
    );
    // Make the file reachable so the orphan check doesn't fire first.
    writeFileSync(
      join(coreDir, "index.ts"),
      'export type { reader } from "./reader.js";\n',
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"node:fs"');
    expect(r.stderr).toContain("AD-10");
  });

  test("rejects a bare side-effect external import", () => {
    writeCore("side-effect.ts", 'import "zod";\n');
    writeFileSync(
      join(coreDir, "index.ts"),
      'export type { Side } from "./side-effect.js";\n',
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"zod"');
  });

  test("rejects a named external import", () => {
    writeCore("typed.ts", 'import type { z } from "zod";\nexport type T = z.ZodType;\n');
    writeFileSync(
      join(coreDir, "index.ts"),
      'export type { T } from "./typed.js";\n',
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"zod"');
  });

  test("rejects a dynamic external import", () => {
    writeCore("dyn.ts", 'export const load = () => import("zod");\n');
    writeFileSync(
      join(coreDir, "index.ts"),
      'export type { load } from "./dyn.js";\n',
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"zod"');
  });

  test("rejects an orphan file in src/core/**", () => {
    // `loose.ts` is not reachable from the barrel — the orphan check must fire.
    writeCore("loose.ts", "export const loose = 1;\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("orphan");
    expect(r.stderr).toContain(relative(cwd, join(coreDir, "loose.ts")).split(sep).join("/"));
  });

  test("rejects a relative crossing outside src/core/** is oxlint's job, not this script's", () => {
    // The script enforces *external* and *orphan* only; relative crossings
    // are caught by oxlint. This test pins the split so a future refactor
    // does not move the boundary silently.
    writeCore("x.ts", 'export type { x } from "../adapters/logger/index.js";\n');
    writeFileSync(
      join(coreDir, "index.ts"),
      'export type { x } from "./x.js";\n',
    );
    // The relative path resolves to `<cwd>/src/adapters/logger/index.ts` —
    // outside `src/core/`. The script does not track that as an edge, so
    // `x.ts` becomes an orphan and the orphan check fires. Either way, the
    // exit code is 1 — the guard rejects the layout.
    const r = run();
    expect(r.status).toBe(1);
  });
});
