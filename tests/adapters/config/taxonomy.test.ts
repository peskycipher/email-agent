import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";
import { loadTaxonomy, TaxonomyError } from "../../../src/adapters/index.js";

interface Label {
  name: string;
  description: string;
  m365Color: string;
  gmailColor: string;
}

const DEFAULT_NAMES = [
  "Action Needed",
  "Waiting/Follow-up",
  "Important",
  "Invoices",
  "Crypto",
  "Business",
  "Family/Friends",
  "Newsletters",
  "Promos",
  "Notifications",
  "Real-estate",
];

/** The exact shipped labels: the colours go to mail APIs and the descriptions to the prompt. */
const SHIPPED: Label[] = [
  {
    name: "Action Needed",
    description: "Requires a response, task, or decision from the user.",
    m365Color: "preset0",
    gmailColor: "#E67C73",
  },
  {
    name: "Waiting/Follow-up",
    description: "Sent something; waiting for a reply or next step.",
    m365Color: "preset1",
    gmailColor: "#F6BF26",
  },
  {
    name: "Important",
    description: "High priority, time-sensitive, or from a key contact.",
    m365Color: "preset2",
    gmailColor: "#E066FF",
  },
  {
    name: "Invoices",
    description: "Bills, receipts, payment requests, financial documents.",
    m365Color: "preset3",
    gmailColor: "#72C77A",
  },
  {
    name: "Crypto",
    description: "Cryptocurrency, blockchain, DeFi, trading, wallet notifications.",
    m365Color: "preset4",
    gmailColor: "#3ECCE9",
  },
  {
    name: "Business",
    description: "Work-related, professional, clients, projects, contracts.",
    m365Color: "preset5",
    gmailColor: "#5A9FF7",
  },
  {
    name: "Family/Friends",
    description: "Personal messages from family members or close friends.",
    m365Color: "preset6",
    gmailColor: "#F9A8D4",
  },
  {
    name: "Newsletters",
    description: "Subscribed content, digests, periodic publications.",
    m365Color: "preset7",
    gmailColor: "#93C5FD",
  },
  {
    name: "Promos",
    description: "Marketing, sales, discounts, promotional emails.",
    m365Color: "preset8",
    gmailColor: "#FDE68A",
  },
  {
    name: "Notifications",
    description: "System alerts, security notices, 2FA codes, automated notifications.",
    m365Color: "preset9",
    gmailColor: "#D1D5DB",
  },
  {
    name: "Real-estate",
    description: "Property listings, mortgage, rentals, HOA, home services.",
    m365Color: "preset10",
    gmailColor: "#A3A3A3",
  },
];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taxonomy-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sourcePath(): string {
  return join(root, "taxonomy.yaml");
}

function configDir(): string {
  return join(root, "config");
}

function defaultLabel(name: string, index: number): Label {
  return {
    name,
    description: `${name} description`,
    m365Color: `preset${index}`,
    gmailColor: `#${(index + 1).toString(16).padStart(6, "0").toUpperCase()}`,
  };
}

function defaultLabels(): Label[] {
  return DEFAULT_NAMES.map(defaultLabel);
}

async function writeSource(labels: Label[]): Promise<void> {
  await writeFile(sourcePath(), dump(labels), "utf8");
}

async function writeRawSource(body: string): Promise<void> {
  await writeFile(sourcePath(), body, "utf8");
}

async function writeConfig(overrides: unknown[]): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(join(configDir(), "config.yaml"), dump({ taxonomyOverrides: overrides }), "utf8");
}

async function writeRawConfig(body: string): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(join(configDir(), "config.yaml"), body, "utf8");
}

function load(): Promise<unknown> {
  return loadTaxonomy({ taxonomyPath: sourcePath(), configDir: configDir() });
}

async function loadError(): Promise<TaxonomyError> {
  const error = await load().catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TaxonomyError);
  return error as TaxonomyError;
}

test("DEFAULT: loads the 11 defaults in order, frozen, with every field", async () => {
  await writeSource(defaultLabels());

  const taxonomy = (await load()) as Label[];

  expect(taxonomy.map((label) => label.name)).toEqual(DEFAULT_NAMES);
  expect(Object.isFrozen(taxonomy)).toBe(true);
  for (const label of taxonomy) {
    expect(Object.isFrozen(label)).toBe(true);
    expect(label.description).toBe(`${label.name} description`);
    expect(label.m365Color).toMatch(/^preset\d+$/);
    expect(label.gmailColor).toMatch(/^#[0-9A-F]{6}$/);
  }
});

test("OVERRIDE_PATCH: replaces listed fields and keeps the rest of the default", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "Invoices", description: "Vendor invoices", m365Color: "preset6" }]);

  const taxonomy = (await load()) as Label[];

  expect(taxonomy).toHaveLength(11);
  expect(taxonomy.find((label) => label.name === "Invoices")).toEqual({
    name: "Invoices",
    description: "Vendor invoices",
    m365Color: "preset6",
    gmailColor: defaultLabel("Invoices", 3).gmailColor,
  });
});

test("OVERRIDE_ADD: appends a label whose name matches no default", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "Travel", description: "Bookings", m365Color: "preset11", gmailColor: "#123ABC" }]);

  const taxonomy = (await load()) as Label[];

  expect(taxonomy.map((label) => label.name)).toEqual([...DEFAULT_NAMES, "Travel"]);
  expect(taxonomy[11]).toEqual({
    name: "Travel",
    description: "Bookings",
    m365Color: "preset11",
    gmailColor: "#123ABC",
  });
});

test("OVERRIDE_ADD: a new label missing a field is an OVERRIDE_INCOMPLETE error", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "Travel", description: "Bookings", m365Color: "preset11" }]);

  const error = await loadError();

  expect(error.code).toBe("OVERRIDE_INCOMPLETE");
  expect(error.message).toContain("gmailColor");
  expect(error.message).toContain("Travel");
});

test("OVERRIDE_MALFORMED: an entry that is not a mapping names its index", async () => {
  await writeSource(defaultLabels());
  await writeRawConfig("taxonomyOverrides:\n  - just a string\n");

  const error = await loadError();

  expect(error.code).toBe("OVERRIDE_MALFORMED");
  expect(error.message).toContain("taxonomyOverrides[0]");
});

test("OVERRIDE_MALFORMED: an entry with no name names its index and the field", async () => {
  await writeSource(defaultLabels());
  await writeRawConfig("taxonomyOverrides:\n  - description: no name here\n");

  const error = await loadError();

  expect(error.code).toBe("OVERRIDE_MALFORMED");
  expect(error.message).toContain("taxonomyOverrides[0]");
  expect(error.message).toContain("name");
});

test("OVERRIDE_DROP: a matched entry with no other field removes that default", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "Crypto" }]);

  const taxonomy = (await load()) as Label[];

  expect(taxonomy.map((label) => label.name)).toEqual(DEFAULT_NAMES.filter((name) => name !== "Crypto"));
});

test("OVERRIDE_DROP: dropping below the 1-label bound is a LABEL_COUNT_OUT_OF_BOUNDS error", async () => {
  await writeSource(defaultLabels());
  await writeConfig(DEFAULT_NAMES.map((name) => ({ name })));

  const error = await loadError();

  expect(error.code).toBe("LABEL_COUNT_OUT_OF_BOUNDS");
  expect(error.message).toContain("at least 1");
});

test("DUPLICATE: two added labels sharing a name name the duplicate", async () => {
  await writeSource(defaultLabels());
  await writeConfig([
    { name: "Travel", description: "a", m365Color: "preset11", gmailColor: "#111111" },
    { name: "Travel", description: "b", m365Color: "preset12", gmailColor: "#222222" },
  ]);

  const error = await loadError();

  expect(error.code).toBe("DUPLICATE_LABEL_NAME");
  expect(error.message).toContain("Travel");
});

test("BAD_NAME: a label name outside the pattern names the label", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "Bills 💸", description: "x", m365Color: "preset11", gmailColor: "#111111" }]);

  const error = await loadError();

  expect(error.code).toBe("INVALID_LABEL_NAME");
  expect(error.message).toContain("Bills 💸");
});

test("BAD_COLOR: preset25 names the label and the m365Color field", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "Travel", description: "x", m365Color: "preset25", gmailColor: "#111111" }]);

  const error = await loadError();

  expect(error.code).toBe("INVALID_LABEL_COLOR");
  expect(error.message).toContain("Travel");
  expect(error.message).toContain("m365Color");
});

test("BAD_COLOR: a non-hex gmailColor names the label and the gmailColor field", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "Travel", description: "x", m365Color: "preset11", gmailColor: "red" }]);

  const error = await loadError();

  expect(error.code).toBe("INVALID_LABEL_COLOR");
  expect(error.message).toContain("Travel");
  expect(error.message).toContain("gmailColor");
});

test("BOUNDS: a merged taxonomy above 50 labels names the upper bound", async () => {
  const many = Array.from({ length: 51 }, (_, index) => ({
    name: `Label${index}`,
    description: "d",
    m365Color: `preset${index % 25}`,
    gmailColor: "#123456",
  }));
  await writeSource(many);

  const error = await loadError();

  expect(error.code).toBe("LABEL_COUNT_OUT_OF_BOUNDS");
  expect(error.message).toContain("at most 50");
});

test("SOURCE_BAD: a missing taxonomy file names the expected path", async () => {
  const error = await loadTaxonomy({ taxonomyPath: join(root, "missing.yaml"), configDir: configDir() }).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(TaxonomyError);
  expect((error as TaxonomyError).code).toBe("SOURCE_UNREADABLE");
  expect((error as Error).message).toContain(join(root, "missing.yaml"));
});

test("SOURCE_BAD: unparseable YAML names the path, not a parser trace", async () => {
  await writeRawSource("name: [unclosed\n");

  const error = await loadError();

  expect(error.code).toBe("SOURCE_INVALID");
  expect(error.message).toContain(sourcePath());
  expect(error.message).toContain("YAML");
});

test("CONFIG_ABSENT: no config.yaml leaves the defaults unchanged", async () => {
  await writeSource(defaultLabels());

  const taxonomy = (await load()) as Label[];

  expect(taxonomy.map((label) => label.name)).toEqual(DEFAULT_NAMES);
});

test("CONFIG_ABSENT: a config.yaml without taxonomyOverrides leaves the defaults unchanged", async () => {
  await writeSource(defaultLabels());
  await writeRawConfig("model:\n  provider: jev\n");

  const taxonomy = (await load()) as Label[];

  expect(taxonomy.map((label) => label.name)).toEqual(DEFAULT_NAMES);
});

test("CONFIG_BAD: unparseable config.yaml names the file", async () => {
  await writeSource(defaultLabels());
  await writeRawConfig("taxonomyOverrides: [unclosed\n");

  const error = await loadError();

  expect(error.code).toBe("CONFIG_INVALID");
  expect(error.message).toContain("config.yaml");
});

test("CONFIG_TYPO: a key reaching for the overrides key is a typed error, never silently stripped (CONFIG_KEY)", async () => {
  await writeSource(defaultLabels());
  // The guard folds case and separators and matches truncated spellings; an interior typo
  // ("taxonmy") stays outside its reach — accepted on a reader Epic 11 replaces (the guard's comment).
  for (const config of ["TaxonomyOverrides: []\n", "taxonomy_overrides: []\n", "taxonomyOverride: []\n"]) {
    await writeRawConfig(config);
    const error = await loadError();
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("rename it");
  }
});

test("CONFIG_TYPO: several near-miss keys are diagnosed in one message, not one per rerun (CONFIG_KEY)", async () => {
  await writeSource(defaultLabels());
  await writeRawConfig("TaxonomyOverrides: []\ntaxonomyOverride: []\n");

  const error = await loadError();

  expect(error.message).toContain('"TaxonomyOverrides"');
  expect(error.message).toContain('"taxonomyOverride"');
});

test("CONFIG_TOLERANT: a legitimate taxonomy* key that is not the override key is left for Epic 11 (CONFIG_KEY)", async () => {
  await writeSource(defaultLabels());
  await writeRawConfig("taxonomyFile: custom.yaml\n");

  const labels = (await load()) as Label[];

  expect(labels.map((label) => label.name)).toEqual(DEFAULT_NAMES);
});

test("CONFIG_NOT_A_MAPPING: a scalar config.yaml is told what a config must be, not blamed on taxonomyOverrides", async () => {
  await writeSource(defaultLabels());
  await writeRawConfig("just a scalar value\n");

  const error = await loadError();

  expect(error.code).toBe("CONFIG_INVALID");
  expect(error.message).toContain("must be a YAML mapping");
  expect(error.message).toContain("a scalar value");
  expect(error.message).not.toContain('"taxonomyOverrides" must be a list');
});

test("CONFIG_NOT_A_MAPPING: a list config.yaml gets the same diagnosis (CONFIG_KEY)", async () => {
  await writeSource(defaultLabels());
  await writeRawConfig("- one\n- two\n");

  const error = await loadError();

  expect(error.code).toBe("CONFIG_INVALID");
  expect(error.message).toContain("must be a YAML mapping");
  expect(error.message).toContain("a list");
});

test("CONFIG_BAD: a non-list taxonomyOverrides names the file and the key", async () => {
  await writeSource(defaultLabels());
  await writeRawConfig("taxonomyOverrides: nope\n");

  const error = await loadError();

  expect(error.code).toBe("CONFIG_INVALID");
  expect(error.message).toContain("config.yaml");
  expect(error.message).toContain("taxonomyOverrides");
});

test("the shipped repo taxonomy.yaml loads the 11 AC labels exactly, in order, frozen", async () => {
  // No `taxonomyPath`: this goes through the module-relative default, i.e. the file the
  // repo actually ships, so a typo or a wrong preset/hex in taxonomy.yaml fails here.
  const taxonomy = (await loadTaxonomy({ configDir: configDir() })) as Label[];

  expect(taxonomy.map((label) => ({ ...label }))).toEqual(SHIPPED);
  expect(Object.isFrozen(taxonomy)).toBe(true);
  for (const label of taxonomy) expect(Object.isFrozen(label)).toBe(true);
});

test("SOURCE_BAD: an unreadable (non-ENOENT) taxonomy path is SOURCE_UNREADABLE", async () => {
  // A directory makes readFile fail with EISDIR, which is not ENOENT.
  const error = await loadTaxonomy({ taxonomyPath: root, configDir: configDir() }).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(TaxonomyError);
  expect((error as TaxonomyError).code).toBe("SOURCE_UNREADABLE");
  expect((error as Error).message).toContain("could not be read");
});

test("CONFIG_BAD: an unreadable (non-ENOENT) config path names that path", async () => {
  await writeSource(defaultLabels());
  const asFile = join(root, "not-a-dir");
  await writeFile(asFile, "x", "utf8"); // ENOTDIR, not ENOENT, when its child is read

  const error = await loadTaxonomy({ taxonomyPath: sourcePath(), configDir: asFile }).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(TaxonomyError);
  expect((error as TaxonomyError).code).toBe("CONFIG_INVALID");
  expect((error as Error).message).toContain(join(asFile, "config.yaml"));
});

test("SOURCE_BAD: a taxonomy file that is not a list is SOURCE_INVALID", async () => {
  await writeRawSource("name: not a list\n");

  const error = await loadError();

  expect(error.code).toBe("SOURCE_INVALID");
  expect(error.message).toContain("list of labels");
});

test("SOURCE_BAD: a non-mapping label entry names its position", async () => {
  await writeRawSource("- just a string\n");

  const error = await loadError();

  expect(error.code).toBe("SOURCE_INVALID");
  expect(error.message).toContain("label 1");
});

test("SOURCE_BAD: a label entry missing name names its position", async () => {
  await writeRawSource("- description: no name\n");

  const error = await loadError();

  expect(error.code).toBe("SOURCE_INVALID");
  expect(error.message).toContain('missing "name"');
});

test("BAD_COLOR: a patch that sets an invalid colour is rejected like an add", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "Invoices", gmailColor: "red" }]);

  const error = await loadError();

  expect(error.code).toBe("INVALID_LABEL_COLOR");
  expect(error.message).toContain("Invoices");
  expect(error.message).toContain("gmailColor");
});

test("OVERRIDE_DROP: a later entry re-adding a dropped name becomes a new label", async () => {
  await writeSource(defaultLabels());
  await writeConfig([
    { name: "Crypto" },
    { name: "Crypto", description: "mine", m365Color: "preset11", gmailColor: "#123456" },
  ]);

  const taxonomy = (await load()) as Label[];

  expect(taxonomy.map((label) => label.name)).toEqual([
    ...DEFAULT_NAMES.filter((name) => name !== "Crypto"),
    "Crypto",
  ]);
  expect(taxonomy[10]).toEqual({
    name: "Crypto",
    description: "mine",
    m365Color: "preset11",
    gmailColor: "#123456",
  });
});

test("OVERRIDE_DROP: re-adding a dropped name without its fields fails loudly", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "Crypto" }, { name: "Crypto", description: "mine" }]);

  const error = await loadError();

  expect(error.code).toBe("OVERRIDE_INCOMPLETE");
  expect(error.message).toContain("Crypto");
});

test("AC3: one override set that patches, adds and drops has exactly those three effects", async () => {
  await writeSource(defaultLabels());
  await writeConfig([
    { name: "Invoices", description: "Vendor invoices" },
    { name: "Travel", description: "Bookings", m365Color: "preset11", gmailColor: "#123456" },
    { name: "Crypto" },
  ]);

  const taxonomy = (await load()) as Label[];

  expect(taxonomy).toHaveLength(11);
  expect(taxonomy.map((label) => label.name)).toEqual([
    ...DEFAULT_NAMES.filter((name) => name !== "Crypto"),
    "Travel",
  ]);
  expect(taxonomy.find((label) => label.name === "Invoices")).toEqual({
    ...defaultLabel("Invoices", 3),
    description: "Vendor invoices",
  });
});

test("OVERRIDE_MALFORMED: an unknown field fails loudly instead of dropping the label", async () => {
  await writeSource(defaultLabels());
  // A mistyped key must not be stripped into a name-only entry, which means "drop".
  await writeConfig([{ name: "Invoices", gmailColour: "#123456" }]);

  const error = await loadError();

  expect(error.code).toBe("OVERRIDE_MALFORMED");
  expect(error.message).toContain("gmailColour");
  expect(error.message).toContain("taxonomyOverrides[0]");
});

test("OVERRIDE_MALFORMED: a null entry names its index", async () => {
  await writeSource(defaultLabels());
  await writeConfig([null]);

  const error = await loadError();

  expect(error.code).toBe("OVERRIDE_MALFORMED");
  expect(error.message).toContain("taxonomyOverrides[0]");
});

test("BAD_NAME: an added label with an empty name is rejected", async () => {
  await writeSource(defaultLabels());
  await writeConfig([{ name: "", description: "x", m365Color: "preset11", gmailColor: "#123456" }]);

  const error = await loadError();

  expect(error.code).toBe("INVALID_LABEL_NAME");
});

test("CONFIG_ABSENT: an empty taxonomyOverrides list leaves the defaults unchanged", async () => {
  await writeSource(defaultLabels());
  await writeConfig([]);

  const taxonomy = (await load()) as Label[];

  expect(taxonomy.map((label) => label.name)).toEqual(DEFAULT_NAMES);
});
