import fs from "node:fs/promises";
import path from "node:path";

export type Config = {
  account: string;
  auditLogPath: string;
};

type ConfigFile = {
  account?: string;
  audit_log_path?: string;
};

type LoadConfigOptions = {
  configPath?: string;
  env?: Record<string, string | undefined>;
};

async function readConfigFile(configPath: string): Promise<ConfigFile> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
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

export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env.EMAIL_CLEANUP_CONFIG;
  const fileConfig = configPath ? await readConfigFile(configPath) : {};

  const account = env.MAILBOX_ACCOUNT ?? fileConfig.account;
  if (!account || account.trim().length === 0) {
    throw new Error("Config validation failed: account is required (set MAILBOX_ACCOUNT or account in config)");
  }

  const auditLogPath = env.AUDIT_LOG_PATH ?? fileConfig.audit_log_path ?? path.resolve("data", "audit.jsonl");

  return {
    account,
    auditLogPath
  };
}
