import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_RECENT_DAYS = 7;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export type Config = {
  account: string;
  auditLogPath: string;
  dataDir: string;
  m365TenantId?: string;
  m365ClientId?: string;
  m365ClientSecret?: string;
  vipSenders?: string[];
  financeLegalKeywords?: string[];
  recentDays?: number;
  confidenceThreshold?: number;
};

export type ConfigSnapshot = {
  account: string;
  recentDays: number;
  confidenceThreshold: number;
  vipSenders: string[];
  financeLegalKeywords: string[];
  auditLogPath: string;
};

type ConfigFile = {
  account?: string;
  audit_log_path?: string;
  data_dir?: string;
  m365_tenant_id?: string;
  m365_client_id?: string;
  m365_client_secret?: string;
  vip_senders?: unknown;
  finance_legal_keywords?: unknown;
  recent_days?: unknown;
  confidence_threshold?: unknown;
};

type LoadConfigOptions = {
  configPath?: string;
  env?: Record<string, string | undefined>;
};

async function readConfigFile(configPath: string): Promise<ConfigFile> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    throw new Error(`Failed to read config file: ${configPath}`);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Config file must contain a JSON object");
    }
    return parsed as ConfigFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config file: ${configPath} (${message})`);
  }
}

function parseListFromConfig(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseListFromEnv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseNumberOption(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for ${name}: ${String(value)}`);
  }

  return parsed;
}

export function buildConfigSnapshot(input: {
  account: string;
  auditLogPath: string;
  recentDays?: number;
  confidenceThreshold?: number;
  vipSenders?: string[];
  financeLegalKeywords?: string[];
}): ConfigSnapshot {
  return {
    account: input.account,
    recentDays: input.recentDays ?? DEFAULT_RECENT_DAYS,
    confidenceThreshold: input.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    vipSenders: [...(input.vipSenders ?? [])],
    financeLegalKeywords: [...(input.financeLegalKeywords ?? [])],
    auditLogPath: input.auditLogPath
  };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env.EMAIL_CLEANUP_CONFIG;
  const fileConfig = configPath ? await readConfigFile(configPath) : {};

  const account = env.MAILBOX_ACCOUNT ?? fileConfig.account;
  if (!account || account.trim().length === 0) {
    throw new Error("Config validation failed: account is required (set MAILBOX_ACCOUNT or account in config)");
  }

  const auditLogPath = env.AUDIT_LOG_PATH ?? fileConfig.audit_log_path ?? path.resolve("data", "audit.jsonl");
  const dataDir = env.DATA_DIR ?? fileConfig.data_dir ?? path.resolve("data");

  const recentDays = parseNumberOption(env.RECENT_DAYS, "RECENT_DAYS") ?? parseNumberOption(fileConfig.recent_days, "recent_days");
  const confidenceThreshold =
    parseNumberOption(env.CONFIDENCE_THRESHOLD, "CONFIDENCE_THRESHOLD") ??
    parseNumberOption(fileConfig.confidence_threshold, "confidence_threshold");

  return {
    account,
    auditLogPath,
    dataDir,
    m365TenantId: env.M365_TENANT_ID ?? fileConfig.m365_tenant_id,
    m365ClientId: env.M365_CLIENT_ID ?? fileConfig.m365_client_id,
    m365ClientSecret: env.M365_CLIENT_SECRET ?? fileConfig.m365_client_secret,
    vipSenders: parseListFromEnv(env.VIP_SENDERS) ?? parseListFromConfig(fileConfig.vip_senders),
    financeLegalKeywords: parseListFromEnv(env.FINANCE_LEGAL_KEYWORDS) ?? parseListFromConfig(fileConfig.finance_legal_keywords),
    recentDays,
    confidenceThreshold
  };
}
