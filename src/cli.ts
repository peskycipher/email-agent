import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import { appendAuditRecord } from "./audit.ts";
import { loadConfig } from "./config.ts";

type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

async function readVersion(): Promise<string> {
  const thisFile = url.fileURLToPath(import.meta.url);
  const packagePath = path.resolve(path.dirname(thisFile), "..", "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  return String(pkg.version ?? "0.0.0");
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }

  return args[index + 1];
}

function renderHelp(version: string): string {
  return [
    `email-cleanup ${version}`,
    "Usage:",
    "  node src/cli.ts --help",
    "  node src/cli.ts --version",
    "  node src/cli.ts demo [--config <path>] [--message-id <id>]"
  ].join("\n");
}

export async function runCli(args: string[], io: CliIo): Promise<number> {
  const version = await readVersion();
  const command = args[0];

  if (command === undefined || command === "--help" || command === "help") {
    io.stdout(renderHelp(version));
    return 0;
  }

  if (command === "--version" || command === "version") {
    io.stdout(version);
    return 0;
  }

  if (command !== "demo") {
    io.stderr(`Unknown command: ${command}`);
    io.stdout(renderHelp(version));
    return 1;
  }

  const configPath = readOption(args, "--config");
  const messageId = readOption(args, "--message-id") ?? "demo-message";

  const config = await loadConfig({ configPath });
  const runId = `demo-${Date.now()}`;

  await appendAuditRecord(config.auditLogPath, {
    timestamp: new Date().toISOString(),
    account: config.account,
    message_id: messageId,
    action: "classify",
    category: "FYI/Reference",
    outcome: "success",
    rationale: "demo-run",
    run_id: runId
  });

  io.stdout(`email-cleanup ${version}`);
  io.stdout(`demo complete: wrote audit record to ${config.auditLogPath}`);
  return 0;
}

const shouldRun = process.argv[1]
  ? url.pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (shouldRun) {
  runCli(process.argv.slice(2), {
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text)
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
