/**
 * Regression tests for the http-routes.ts 500 error redaction.
 *
 * Lock in the contract that the outer catch handler:
 *   - does NOT echo back the raw `err.message`
 *   - does NOT echo back the database path or other internal state
 *   - DOES return a stable correlation id (`errorId`) the operator can grep
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLcmHttpHandler } from "../../src/surface/http-routes.js";
import type { LcmConfig } from "../../src/db/config.js";

const tempDirs: string[] = [];

beforeEach(() => {
  // Silence the expected `console.error` call our handler now emits on the
  // 500 path. Each test that wants to assert on it sets its own spy.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ── Minimal IncomingMessage / ServerResponse mocks ────────────────────────────

type CapturedResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  payload: unknown;
};

function makeFakeRequest(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}) {
  const req = new EventEmitter() as EventEmitter & {
    method?: string;
    url?: string;
    headers: Record<string, string>;
    destroy: () => void;
  };
  req.method = opts.method ?? "GET";
  req.url = opts.url ?? "/memory/conversations";
  req.headers = opts.headers ?? {};
  req.destroy = () => {
    /* noop for these tests */
  };
  return req;
}

function makeFakeResponse(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    status: 0,
    headers: {},
    body: "",
    payload: undefined,
  };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body: string) {
      captured.body = body;
      try {
        captured.payload = JSON.parse(body);
      } catch {
        captured.payload = body;
      }
    },
  };
  return { res, captured };
}

function makeMinimalConfig(databasePath: string): LcmConfig {
  return {
    enabled: true,
    databasePath,
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
    vaultEnabled: false,
    vaultPath: "",
    vaultSubdir: "Engram",
    vaultHomeNoteName: "Home",
    vaultManualFolders: "Inbox,Manual",
    vaultClean: true,
    vaultReportsEnabled: true,
    obsidianMode: "curated",
    obsidianExportDiagnostics: false,
  } as LcmConfig;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createLcmHttpHandler 500 error redaction", () => {
  it("returns a generic errorId for 500s and does NOT leak err.message", async () => {
    // Force a 500 by pointing the database at a path that's actually a
    // *file* (not a directory) — `getLcmConnection` will try to mkdir
    // the parent and / or open the DB and fail in a way the handler
    // can't pre-validate.
    const dir = mkdtempSync(join(tmpdir(), "engram-http-500-"));
    tempDirs.push(dir);
    // Create a regular file where the DB parent directory would be.
    const blockingFile = join(dir, "blocker");
    writeFileSync(blockingFile, "not a directory");
    // dbPath whose parent is the blocking file — mkdir will throw EEXIST/ENOTDIR.
    const databasePath = join(blockingFile, "subdir", "lcm.db");

    const handler = createLcmHttpHandler({
      config: makeMinimalConfig(databasePath),
    });

    const req = makeFakeRequest({
      method: "GET",
      url: "/memory/conversations",
    });
    const { res, captured } = makeFakeResponse();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handled = await handler(req as any, res as any);
    expect(handled).toBe(true);
    expect(captured.status).toBe(500);

    const payload = captured.payload as { detail?: string; errorId?: string; message?: string };
    expect(payload).toMatchObject({ detail: "internal error" });
    expect(payload.errorId).toMatch(/^[0-9a-f]{12}$/);
    // The pre-hardening behaviour leaked `message`. Lock it out.
    expect(payload).not.toHaveProperty("message");

    // The database path is the most damaging thing that could leak.
    // It must not appear anywhere in the response body.
    expect(captured.body).not.toContain(databasePath);
    expect(captured.body).not.toContain(blockingFile);

    // The full error should be logged server-side with the same errorId
    // so operators can correlate.
    expect(errSpy).toHaveBeenCalled();
    const loggedArgs = errSpy.mock.calls.flat().map((a) => String(a));
    const loggedText = loggedArgs.join(" ");
    expect(loggedText).toContain(payload.errorId!);
  });

  it("returns distinct errorIds for repeated 500s (correlation IDs are random)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-http-500-distinct-"));
    tempDirs.push(dir);
    const blockingFile = join(dir, "blocker2");
    writeFileSync(blockingFile, "blocker");
    const databasePath = join(blockingFile, "subdir", "lcm.db");

    const handler = createLcmHttpHandler({
      config: makeMinimalConfig(databasePath),
    });

    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const req = makeFakeRequest({ method: "GET", url: "/memory/conversations" });
      const { res, captured } = makeFakeResponse();
      await handler(req as any, res as any);
      expect(captured.status).toBe(500);
      const payload = captured.payload as { errorId?: string };
      expect(payload.errorId).toBeTruthy();
      ids.add(payload.errorId!);
    }
    // 3 calls → 3 distinct ids (with overwhelming probability for 12 hex chars).
    expect(ids.size).toBe(3);
  });

  it("preserves the 4xx shape for invalid conversationId on /memory/search", async () => {
    // The 4xx contract should be unchanged by the 5xx hardening. Use a
    // valid temp DB so the route reaches the validation code path.
    const dir = mkdtempSync(join(tmpdir(), "engram-http-400-"));
    tempDirs.push(dir);
    const databasePath = join(dir, "lcm.db");
    const handler = createLcmHttpHandler({
      config: makeMinimalConfig(databasePath),
    });

    const req = makeFakeRequest({
      method: "POST",
      url: "/memory/search",
      headers: { "content-type": "application/json" },
    });
    const { res, captured } = makeFakeResponse();
    const handlerPromise = handler(req as any, res as any);
    // Push a body where conversationId is a hostile non-numeric value.
    req.emit(
      "data",
      Buffer.from(
        JSON.stringify({ query: "hi", conversationId: { evil: true } }),
        "utf8",
      ),
    );
    req.emit("end");
    await handlerPromise;

    expect(captured.status).toBe(400);
    const payload = captured.payload as { detail?: string; errorId?: string };
    expect(payload.detail).toMatch(/invalid conversationId/i);
    // 4xx should NOT carry an errorId — that's reserved for 5xx correlation.
    expect(payload).not.toHaveProperty("errorId");
  });

  it("returns 401 with a clean message when the gateway token is wrong", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-http-401-"));
    tempDirs.push(dir);
    const databasePath = join(dir, "lcm.db");
    const handler = createLcmHttpHandler({
      config: makeMinimalConfig(databasePath),
      gatewayToken: "expected-token-value",
    });

    const req = makeFakeRequest({
      method: "GET",
      url: "/memory/conversations",
      headers: { "x-memory-token": "wrong-token-length-diff" },
    });
    const { res, captured } = makeFakeResponse();
    await handler(req as any, res as any);

    expect(captured.status).toBe(401);
    const payload = captured.payload as { detail?: string };
    expect(payload.detail).toBe("invalid token");
    // No leaked tokens, paths, or internal info.
    expect(captured.body).not.toContain("expected-token-value");
    expect(captured.body).not.toContain(databasePath);
  });
});
