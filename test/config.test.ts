import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.ts";

test("loadConfig reads file and lets env override values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"));
  const configPath = path.join(dir, "config.json");

  await fs.writeFile(
    configPath,
    JSON.stringify({
      account: "file@example.com",
      audit_log_path: path.join(dir, "from-file.jsonl"),
      vip_senders: ["file-vip@example.com"],
      finance_legal_keywords: ["invoice"]
    }),
    "utf8"
  );

  const config = await loadConfig({
    configPath,
    env: {
      MAILBOX_ACCOUNT: "env@example.com",
      VIP_SENDERS: "env-vip@example.com, env-legal@example.com"
    }
  });

  assert.equal(config.account, "env@example.com");
  assert.equal(config.auditLogPath, path.join(dir, "from-file.jsonl"));
  assert.deepEqual(config.vipSenders, ["env-vip@example.com", "env-legal@example.com"]);
  assert.deepEqual(config.financeLegalKeywords, ["invoice"]);
});

test("loadConfig throws clear validation error when required keys are missing", async () => {
  await assert.rejects(
    loadConfig({
      env: {}
    }),
    /Config validation failed: account is required \(set MAILBOX_ACCOUNT or account in config\)/
  );
});

test("loadConfig throws clear parse error for invalid config files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"));
  const configPath = path.join(dir, "bad.json");
  await fs.writeFile(configPath, "{ this is not valid json", "utf8");

  await assert.rejects(loadConfig({ configPath, env: {} }), /Failed to parse config file/);
});

test("loadConfig rejects unexpanded ${PLACEHOLDER} values in the config file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"));
  const configPath = path.join(dir, "config.json");

  await fs.writeFile(
    configPath,
    JSON.stringify({
      account: "${MAILBOX_ACCOUNT}",
      vip_senders: ["${VIP_SENDERS}"],
      data_dir: "${DATA_DIR}"
    }),
    "utf8"
  );

  await assert.rejects(
    loadConfig({ configPath, env: {} }),
    /unexpanded .*PLACEHOLDER.* values at: account, vip_senders\[0\], data_dir/
  );
});
