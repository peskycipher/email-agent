import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import { M365MailboxAdapter } from "./adapter_m365.ts";
import type { MailboxAdapter } from "./adapter.ts";
import { runLiveApply } from "./apply.ts";
import { appendAuditRecord } from "./audit.ts";
import { isEmailCategory, type EmailCategory } from "./classify/categories.ts";
import { loadConfig, type Config } from "./config.ts";
import { runDryRun } from "./dry_run.ts";

type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

type CliDependencies = {
  createAdapter?: (config: Config) => MailboxAdapter;
  now?: () => Date;
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

function readOptions(args: string[], name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length) {
      values.push(args[index + 1]);
    }
  }

  return values;
}

function readNumberOption(args: string[], name: string, fallback: number): number {
  const value = readOption(args, name);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${name}: ${value}`);
  }

  return parsed;
}

function renderHelp(version: string): string {
  return [
    `email-cleanup ${version}`,
    "Usage:",
    "  node src/cli.ts --help",
    "  node src/cli.ts --version",
    "  node src/cli.ts demo [--config <path>] [--message-id <id>]",
    "  node src/cli.ts dry-run [--config <path>] [--limit <n>]",
    "  node src/cli.ts live-apply --plan <path> [--config <path>] [--approve-category <name>] [--reject-category <name>]"
  ].join("\n");
}

function createAdapterFromConfig(config: Config): MailboxAdapter {
  if (!config.m365TenantId || !config.m365ClientId || !config.m365ClientSecret) {
    throw new Error("Config validation failed: M365_TENANT_ID, M365_CLIENT_ID, and M365_CLIENT_SECRET are required for dry-run");
  }

  return new M365MailboxAdapter({
    tenantId: config.m365TenantId,
    clientId: config.m365ClientId,
    clientSecret: config.m365ClientSecret,
    account: config.account
  });
}

export async function runCli(args: string[], io: CliIo, dependencies: CliDependencies = {}): Promise<number> {
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

  if (command === "demo") {
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

  if (command === "dry-run") {
    const configPath = readOption(args, "--config");
    const limit = readNumberOption(args, "--limit", 50);
    const config = await loadConfig({ configPath });
    const createAdapter = dependencies.createAdapter ?? createAdapterFromConfig;
    const adapter = createAdapter(config);
    const now = dependencies.now;

    const result = await runDryRun({
      adapter,
      account: config.account,
      dataDir: config.dataDir,
      limit,
      now,
      vipSenders: config.vipSenders,
      financeLegalKeywords: config.financeLegalKeywords
    });

    io.stdout(`email-cleanup ${version}`);
    io.stdout(`dry-run complete: ingested ${result.ingestedCount} message(s)`);
    io.stdout(`plan artifact: ${result.planPath}`);
    io.stdout(`run record: ${result.runPath}`);
    return 0;
  }

  if (command === "live-apply") {
    const configPath = readOption(args, "--config");
    const planPath = readOption(args, "--plan");
    if (!planPath) {
      throw new Error("Missing required option: --plan <path>");
    }

    const approvals: Partial<Record<EmailCategory, boolean>> = {};

    for (const category of readOptions(args, "--approve-category")) {
      if (!isEmailCategory(category)) {
        throw new Error(`Invalid category for --approve-category: ${category}`);
      }
      approvals[category] = true;
    }

    for (const category of readOptions(args, "--reject-category")) {
      if (!isEmailCategory(category)) {
        throw new Error(`Invalid category for --reject-category: ${category}`);
      }

      if (approvals[category] === true) {
        throw new Error(`Conflicting approval options for category: ${category}`);
      }

      approvals[category] = false;
    }

    const config = await loadConfig({ configPath });
    const createAdapter = dependencies.createAdapter ?? createAdapterFromConfig;
    const adapter = createAdapter(config);
    const now = dependencies.now;

    const result = await runLiveApply({
      adapter,
      account: config.account,
      dataDir: config.dataDir,
      planPath,
      auditLogPath: config.auditLogPath,
      approvals,
      now
    });

    io.stdout(`email-cleanup ${version}`);
    io.stdout(`live-apply complete: applied ${result.appliedActions} action(s), skipped ${result.skippedActions}`);
    io.stdout(`live run record: ${result.runPath}`);
    return 0;
  }

  io.stderr(`Unknown command: ${command}`);
  io.stdout(renderHelp(version));
  return 1;
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
