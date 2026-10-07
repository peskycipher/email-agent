import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import { M365MailboxAdapter } from "./adapter_m365.ts";
import type { MailboxAdapter } from "./adapter.ts";
import { appendAuditRecord } from "./audit.ts";
import { isEmailCategory, EMAIL_CATEGORIES, type EmailCategory } from "./classify/categories.ts";
import { buildConfigSnapshot, loadConfig, type Config } from "./config.ts";
import type { DryRunSummary } from "./dry_run.ts";
import { evaluateExpansionGate, loadGateEvidence, loadExpansionSignOffFromRun, recordExpansionSignOff } from "./gate.ts";
import { runDryRun, runLiveApply } from "./orchestrator.ts";
import type { ClassifierSystem1 } from "./classify/system1.ts";
import type { SecondPassClassifier } from "./classify/ollama.ts";

type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

type CliDependencies = {
  createAdapter?: (config: Config) => MailboxAdapter;
  system1Classifier?: ClassifierSystem1;
  secondPassClassifier?: SecondPassClassifier;
  /** Override spinner availability; defaults to whether stderr is a TTY. */
  spinner?: boolean;
  now?: () => Date;
};

/**
 * Writes an animated status line to stderr so stdout stays clean for the summary.
 * Returns a stop function that clears the line — always call it, including on throw.
 */
function startSpinner(write: (text: string) => void, label: string, enabled: boolean): () => void {
  if (!enabled) {
    return () => {};
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const startedAt = Date.now();
  let frame = 0;
  let lastRenderedSecond: number | undefined;

  // One line, never a repeated message: the status line is repainted in place, and only
  // when the elapsed second changes, so a terminal that ignores \r still gets at most
  // one line per second instead of ten.
  const render = (elapsedSeconds: number): void => {
    lastRenderedSecond = elapsedSeconds;
    write(`\r\u001b[K${frames[frame % frames.length]} ${label}${elapsedSeconds > 0 ? ` ${elapsedSeconds}s` : ""}`);
    frame += 1;
  };

  render(0);

  const timer = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedSeconds !== lastRenderedSecond) {
      render(elapsedSeconds);
    }
  }, 200);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    write("\r\u001b[K");
  };
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  return `${minutes}m ${Math.round((durationMs % 60_000) / 1000)}s`;
}

function renderDryRunSummary(summary: DryRunSummary): string {
  const rows: Array<[string, string | number]> = [
    ["ingested", summary.ingested],
    ...EMAIL_CATEGORIES.map((category) => [category, summary.categories[category]] as [string, number]),
    ["archives planned", summary.archivesPlanned],
    ["protected (no-touch)", summary.protectedItems],
    ["duration", formatDuration(summary.durationMs)]
  ];

  const reasonRows: Array<[string, number]> = Object.entries(summary.noTouchReasons).map(([reason, count]) => [`  ${reason}`, count]);

  const width = Math.max(...[...rows, ...reasonRows].map(([label]) => label.length));
  const pad = (label: string): string => label.padEnd(width);

  return [
    "Summary",
    ...rows.map(([label, value]) => `  ${pad(label)}  ${value}`),
    ...(reasonRows.length > 0 ? ["  no-touch reasons", ...reasonRows.map(([label, value]) => `  ${pad(label)}  ${value}`)] : [])
  ].join("\n");
}

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

function readCategoryApprovals(args: string[]): Partial<Record<EmailCategory, boolean>> {
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

  return approvals;
}

function renderHelp(version: string): string {
  return [
    `email-cleanup ${version}`,
    "Usage:",
    "  node src/cli.ts --help",
    "  node src/cli.ts --version",
    "  node src/cli.ts demo [--config <path>] [--message-id <id>]",
    "  node src/cli.ts dry-run [--config <path>] [--limit <n>]",
    "  node src/cli.ts live-apply --plan <path> [--config <path>] [--approve-category <name>] [--reject-category <name>]",
    "  node src/cli.ts sign-off --run <path-to-run-json> --decision <go|no-go> [--actor <you>] [--note \"...\"]",
    "  node src/cli.ts gate --run <path-to-run-json>"
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

    const stopSpinner = startSpinner(
      io.stderr,
      "dry-run: ingesting and classifying",
      dependencies.spinner ?? Boolean(process.stderr.isTTY)
    );

    let result;
    try {
      result = await runDryRun({
        adapter,
        config: buildConfigSnapshot(config),
        dataDir: config.dataDir,
        limit,
        now,
        system1Classifier: dependencies.system1Classifier,
        secondPassClassifier: dependencies.secondPassClassifier
      });
    } finally {
      stopSpinner();
    }

    io.stdout(`email-cleanup ${version}`);
    io.stdout(`dry-run complete: ingested ${result.ingestedCount} message(s)`);
    io.stdout(renderDryRunSummary(result.summary));
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

    const approvals = readCategoryApprovals(args);

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
      config: buildConfigSnapshot(config),
      now
    });

    io.stdout(`email-cleanup ${version}`);
    io.stdout(`live-apply complete: applied ${result.appliedActions} action(s), skipped ${result.skippedActions}`);
    io.stdout(`live run record: ${result.runPath}`);
    return 0;
  }

  if (command === "sign-off") {
    const runPath = readOption(args, "--run");
    if (!runPath) {
      throw new Error("Missing required option: --run <path-to-run-json>");
    }

    const decision = readOption(args, "--decision");
    if (decision !== "go" && decision !== "no-go") {
      throw new Error("Missing or invalid --decision: must be 'go' or 'no-go'");
    }

    const actor = readOption(args, "--actor");
    const note = readOption(args, "--note");

    await recordExpansionSignOff(runPath, {
      decision,
      ...(actor ? { actor } : {}),
      ...(note ? { note } : {})
    });

    io.stdout(`email-cleanup ${version}`);
    io.stdout(`sign-off recorded: ${decision} for run ${runPath}`);
    return 0;
  }

  if (command === "gate") {
    const runPath = readOption(args, "--run");
    if (!runPath) {
      throw new Error("Missing required option: --run <path-to-run-json>");
    }

    const evidence = await loadGateEvidence(runPath);
    const { metrics } = evidence;
    const signOff = await loadExpansionSignOffFromRun(runPath);
    const evaluation = evaluateExpansionGate(metrics, signOff);

    io.stdout(`email-cleanup ${version}`);
    io.stdout(`evidence: ${evidence.source}`);
    io.stdout(`processed >= 500: ${evaluation.conditions.processed_count_met} (${metrics.processed_count})`);
    io.stdout(`precision >= 98%: ${evaluation.conditions.archive_precision_met} (${metrics.archive_precision_estimate})`);
    io.stdout(`no-touch misses = 0: ${evaluation.conditions.no_touch_misses_met} (${metrics.no_touch_miss_count})`);
    io.stdout(`sign-off go: ${evaluation.conditions.sign_off_met}`);
    io.stdout(`allowed: ${evaluation.allowed}`);
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
