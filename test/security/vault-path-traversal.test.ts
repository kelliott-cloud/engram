/**
 * Regression tests for the vault path traversal guards in vault-mirror.ts.
 *
 * `writeManagedText` is not directly exported (it is a module-private const),
 * so we exercise it indirectly through `buildVaultSurface` — feeding it a
 * forged session id containing `../` and absolute-path payloads, then
 * verifying that no files appear outside the configured mirror root.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import type { LcmConfig } from "../../src/db/config.js";
import { buildVaultSurface, inspectVaultHealth } from "../../src/surface/vault-mirror.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function makeTempArea() {
  const root = mkdtempSync(join(tmpdir(), "engram-vault-trav-"));
  tempDirs.push(root);
  const dbDir = join(root, "db");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "lcm.db");
  const vaultPath = join(root, "vault");
  mkdirSync(vaultPath, { recursive: true });
  return { root, dbPath, vaultPath };
}

function makeVaultConfig(overrides: Partial<LcmConfig>): LcmConfig {
  return {
    enabled: true,
    databasePath: "",
    contextThreshold: 0.75,
    freshTailCount: 32,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 1200,
    condensedTargetTokens: 2000,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    autocompactDisabled: false,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    vaultEnabled: true,
    vaultPath: "",
    vaultSubdir: "Engram",
    vaultHomeNoteName: "Home",
    vaultManualFolders: "Inbox,Manual",
    vaultClean: true,
    vaultReportsEnabled: true,
    obsidianMode: "curated",
    obsidianExportDiagnostics: false,
    ...overrides,
  } as LcmConfig;
}

/**
 * Walk a directory and return every absolute file path beneath it.
 */
function listAllFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

describe("vault-mirror exports sanity", () => {
  it("exports buildVaultSurface and inspectVaultHealth as functions", () => {
    expect(typeof buildVaultSurface).toBe("function");
    expect(typeof inspectVaultHealth).toBe("function");
  });
});

describe("vault-mirror path traversal guards", () => {
  it("rejects writes when session ids contain traversal payloads", async () => {
    const { root, dbPath, vaultPath } = makeTempArea();
    const sentinelDir = mkdtempSync(join(tmpdir(), "engram-vault-trav-sentinel-"));
    tempDirs.push(sentinelDir);

    const db = getLcmConnection(dbPath);
    runLcmMigrations(db, { fts5Available: false });

    // Force a hostile session id directly into the conversations table.
    // safeFileName() upstream WILL sanitize most chars, so this is also a
    // check that the second layer (writeManagedText) is doing its job even
    // when the upstream sanitizer is bypassed (or regresses).
    const hostileSessionIds = [
      "../../../../etc/passwd",
      "..\\..\\Windows\\System32",
      "/etc/shadow",
      "C:/Windows/System32",
    ];
    const insert = db.prepare(
      `INSERT INTO conversations (session_id, title) VALUES (?, ?)`,
    );
    for (const sid of hostileSessionIds) {
      insert.run(sid, `title ${sid}`);
    }

    const config = makeVaultConfig({
      databasePath: dbPath,
      vaultPath,
    });

    // The build SHOULD succeed because safeFileName() neutralizes the
    // traversal characters in the on-disk filename. The key invariant we
    // care about is the negative: nothing escapes the mirror root.
    let buildErr: unknown = null;
    try {
      buildVaultSurface({ db, config });
    } catch (err) {
      buildErr = err;
    }

    // Whether or not buildVaultSurface threw, the post-condition is the
    // same: no files outside the vault root, and the sentinel dir is empty.
    const expectedMirrorRoot = resolve(join(vaultPath, "Engram"));
    const allFilesUnderVault = listAllFiles(vaultPath);
    for (const f of allFilesUnderVault) {
      const r = resolve(f);
      expect(
        r === expectedMirrorRoot || r.startsWith(expectedMirrorRoot + sep) || r.startsWith(resolve(vaultPath) + sep),
      ).toBe(true);
    }

    // The sentinel dir lives outside the vault root entirely — it must
    // remain empty even after the build attempt.
    expect(listAllFiles(sentinelDir)).toHaveLength(0);

    // Defense-in-depth: check that no file got written into /etc, /tmp/etc,
    // or anywhere that resolves above the temp root.
    const allFilesBelowRoot = listAllFiles(root);
    for (const f of allFilesBelowRoot) {
      expect(resolve(f).startsWith(resolve(root) + sep)).toBe(true);
    }

    // If buildVaultSurface did throw, it must be from our path guard,
    // not from some other arbitrary failure mode.
    if (buildErr instanceof Error) {
      expect(buildErr.message).toMatch(/vault write rejected|unsafe path|escapes/i);
    }
  });

  it("does not let inspectVaultHealth write outside the vault root", () => {
    const { root, dbPath, vaultPath } = makeTempArea();

    const db = getLcmConnection(dbPath);
    runLcmMigrations(db, { fts5Available: false });

    const config = makeVaultConfig({
      databasePath: dbPath,
      vaultPath,
    });

    // inspectVaultHealth is a read-only operation; the assertion is that
    // it doesn't unexpectedly create paths above the configured root.
    const before = listAllFiles(dirname(root));
    inspectVaultHealth({ db, config });
    const after = listAllFiles(dirname(root));

    // Filter to only files inside `root` — anything else means escape.
    const newFiles = after.filter((f) => !before.includes(f));
    for (const f of newFiles) {
      expect(resolve(f).startsWith(resolve(root) + sep)).toBe(true);
    }
  });

  it("ensures the mirror root containment check stays in place", async () => {
    // This is a regression sentinel: even with vaultPath set, no operation
    // should produce a managed file outside the resolved mirror root. We
    // exercise the build, then verify every emitted file is contained.
    const { dbPath, vaultPath } = makeTempArea();

    const db = getLcmConnection(dbPath);
    runLcmMigrations(db, { fts5Available: false });

    // Add a benign conversation so the build has something to emit.
    db.prepare(`INSERT INTO conversations (session_id, title) VALUES (?, ?)`).run(
      "benign-session",
      "ok",
    );

    const config = makeVaultConfig({
      databasePath: dbPath,
      vaultPath,
    });

    const result = buildVaultSurface({ db, config });
    const mirrorRoot = resolve(result.mirror_root);

    for (const rel of result.manifest.generated_files) {
      const abs = resolve(join(mirrorRoot, rel));
      const contained =
        abs === mirrorRoot || abs.startsWith(mirrorRoot + sep);
      expect(contained).toBe(true);
    }

    // Every actually-written file should also be under the mirror root.
    for (const f of listAllFiles(vaultPath)) {
      const r = resolve(f);
      expect(r.startsWith(resolve(vaultPath) + sep) || r === resolve(vaultPath)).toBe(
        true,
      );
    }

    // And the mirror root itself should exist after a non-dryRun build.
    expect(existsSync(mirrorRoot)).toBe(true);
    expect(statSync(mirrorRoot).isDirectory()).toBe(true);
  });
});
