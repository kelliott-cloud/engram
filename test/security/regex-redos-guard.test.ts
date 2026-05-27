/**
 * Regression tests for the regex/ReDoS guard added in conversation-store.ts.
 *
 * Lock in the contract that `ConversationStore.compileSafeRegex`:
 *   - accepts plain patterns
 *   - rejects empty / too-long / nested-quantifier / inline-flag patterns
 *   - rejects invalid regex syntax
 *
 * Also includes a smoke test that `searchRegex` returns within a generous
 * wall-clock budget against a moderately-sized message table — a sentinel
 * that catches accidental quadratic regressions in the scan loop.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/memory/store/conversation-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("ConversationStore.compileSafeRegex", () => {
  it("accepts a simple literal pattern and returns a RegExp", () => {
    const re = ConversationStore.compileSafeRegex("hello");
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test("hello world")).toBe(true);
    expect(re.test("nope")).toBe(false);
  });

  it("rejects empty patterns", () => {
    expect(() => ConversationStore.compileSafeRegex("")).toThrow(/empty/i);
  });

  it("rejects patterns longer than 256 chars", () => {
    const huge = "a".repeat(257);
    expect(() => ConversationStore.compileSafeRegex(huge)).toThrow(/too long/i);
  });

  it("accepts patterns at the 256-char boundary", () => {
    const at = "a".repeat(256);
    expect(() => ConversationStore.compileSafeRegex(at)).not.toThrow();
  });

  it.each([
    ["(a+)+", "nested + over +"],
    ["(a*)*", "nested * over *"],
    ["(a+)*", "nested * over +"],
    ["(a*)+", "nested + over *"],
  ])("rejects nested quantifier %s (%s)", (pattern) => {
    expect(() => ConversationStore.compileSafeRegex(pattern)).toThrow(/nested quantifier/i);
  });

  it("rejects inline flag groups like (?i)", () => {
    expect(() => ConversationStore.compileSafeRegex("(?i)hello")).toThrow(
      /inline flag group/i,
    );
  });

  it("rejects invalid regex syntax", () => {
    expect(() => ConversationStore.compileSafeRegex("[")).toThrow(/invalid regex/i);
  });

  it("rejects non-string inputs defensively", () => {
    // Cast through unknown — caller type system would normally prevent this,
    // but we still want a clean error rather than a crash on bad input.
    expect(() =>
      ConversationStore.compileSafeRegex(123 as unknown as string),
    ).toThrow(/must be a string/i);
  });
});

describe("ConversationStore.searchRegex budget enforcement", () => {
  it("returns within the wall-clock budget on a 10k-message table", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "engram-redos-smoke-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "smoke.db");

    const db = getLcmConnection(dbPath);
    runLcmMigrations(db, { fts5Available: false });

    const store = new ConversationStore(db, { fts5Available: false });
    const conversation = await store.createConversation({
      sessionId: "redos-smoke-session",
      title: "redos smoke",
    });

    // Seed 10K junk messages directly via SQL — faster than the public
    // createMessage path and sufficient to exercise the scan loop's budget.
    const insert = db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
         VALUES (?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN");
    try {
      for (let i = 0; i < 10_000; i += 1) {
        insert.run(
          conversation.conversationId,
          i + 1,
          i % 2 === 0 ? "user" : "assistant",
          // Mix in occasional matches so the loop has work but isn't trivial.
          i % 250 === 0 ? `needle ${i}` : `noise content ${i} ${"x".repeat(64)}`,
          16,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    const started = Date.now();
    const results = await store.searchMessages({
      query: "needle",
      mode: "regex",
      conversationId: conversation.conversationId,
      limit: 50,
    });
    const elapsed = Date.now() - started;

    // Generous ceiling — the internal budget is 250ms, so 2s gives us
    // a wide safety margin while still catching catastrophic regressions.
    expect(elapsed).toBeLessThan(2_000);
    // Sanity: we should at least find the seeded "needle" rows.
    expect(results.length).toBeGreaterThan(0);
  });
});
