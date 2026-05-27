import { homedir } from "os";
import { join } from "path";

export type LcmConfig = {
  enabled: boolean;
  databasePath: string;
  contextThreshold: number;
  freshTailCount: number;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  largeFileTokenThreshold: number;
  /** Provider override for large-file text summarization. */
  largeFileSummaryProvider: string;
  /** Model override for large-file text summarization. */
  largeFileSummaryModel: string;
  autocompactDisabled: boolean;
  /** IANA timezone for timestamps in summaries (from TZ env or system default) */
  timezone: string;
  /** When true, retroactively delete HEARTBEAT_OK turn cycles from LCM storage. */
  pruneHeartbeatOk: boolean;
  // ── Vault / Obsidian mirror ────────────────────────────────────────────────
  /** When true, vault mirror generation is enabled. Default: false. */
  vaultEnabled: boolean;
  /** Absolute path to the Obsidian vault root directory. Required when vaultEnabled. */
  vaultPath: string;
  /** Sub-directory inside the vault root where generated files live. Default: "Engram". */
  vaultSubdir: string;
  /** Name for the home note file (without .md extension). Default: "Home". */
  vaultHomeNoteName: string;
  /** Comma-separated list of manually managed folders to protect from cleanup. Default: "Inbox,Manual". */
  vaultManualFolders: string;
  /** When true, remove stale generated files on each build. Default: true. */
  vaultClean: boolean;
  /** When true, write report files (manifest, freshness, build summary). Default: true. */
  vaultReportsEnabled: boolean;
  /** Obsidian surface mode: "curated" (condensed summaries only) or "diagnostic" (full DAG). Default: "curated". */
  obsidianMode: string;
  /** When true, export diagnostic views (summary depth, raw leaf list). Default: false. */
  obsidianExportDiagnostics: boolean;
};

/** Safely coerce an unknown value to a finite number, or return undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Safely coerce an unknown value to a boolean, or return undefined. */
function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Safely coerce an unknown value to a trimmed non-empty string, or return undefined. */
function toStr(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

// ── Validation helpers ───────────────────────────────────────────────────────
//
// These helpers throw with the configuration source name (env var or plugin
// key) baked into the message so a misconfigured operator gets an immediate,
// clear failure during plugin load rather than a confusing downstream error.

/** Hard maximum path length. POSIX caps at 4096 (PATH_MAX); Windows is shorter. */
const MAX_PATH_LENGTH = 4096;

/** Hard maximum length for free-form scalar config values (timezone, provider/model overrides). */
const MAX_SCALAR_LENGTH = 256;

/**
 * Validate a filesystem path: reject NUL-byte injection and absurd lengths.
 * Returns the input unchanged on success. Pass-through empty strings (the
 * caller decides whether empty is an error for that field).
 */
function validatePath(value: string, sourceName: string): string {
  if (value.length === 0) return value;
  if (value.includes("\0")) {
    throw new Error(`${sourceName} contains illegal NUL character`);
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new Error(
      `${sourceName} exceeds maximum length of ${MAX_PATH_LENGTH} characters (got ${value.length})`,
    );
  }
  return value;
}

/**
 * Validate a free-form scalar string (timezone, provider/model name).
 * Rejects newlines, NUL bytes, and over-length input — these end up in LLM
 * prompts and HTTP headers, so an attacker who can set env vars could
 * otherwise smuggle data downstream.
 */
function validateScalar(value: string, sourceName: string): string {
  if (value.length === 0) return value;
  if (value.includes("\0")) {
    throw new Error(`${sourceName} contains illegal NUL character`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${sourceName} contains illegal newline character`);
  }
  if (value.length > MAX_SCALAR_LENGTH) {
    throw new Error(
      `${sourceName} exceeds maximum length of ${MAX_SCALAR_LENGTH} characters (got ${value.length})`,
    );
  }
  return value;
}

/**
 * Enforce a numeric bound matching the `openclaw.plugin.json` configSchema.
 * Throws on out-of-range values. If the coerced value is not a finite number
 * the caller should not invoke this helper (it falls through to the default).
 */
function enforceNumericBound(
  value: number,
  sourceName: string,
  bounds: { min?: number; max?: number; integer?: boolean },
): number {
  if (bounds.integer && !Number.isInteger(value)) {
    throw new Error(`${sourceName} must be an integer (got ${value})`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(`${sourceName} must be >= ${bounds.min} (got ${value})`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new Error(`${sourceName} must be <= ${bounds.max} (got ${value})`);
  }
  return value;
}

/**
 * Resolve a numeric config value with manifest-aligned bounds enforcement.
 * Falls through to `defaultValue` when neither env nor plugin config supplies
 * a parseable number (preserving the historical "graceful" coercion for
 * invalid string input such as "not-a-number"). Throws when the value parses
 * but violates the documented bound — this matches the JSON-schema contract
 * in `openclaw.plugin.json`.
 */
function resolveBoundedNumber(args: {
  envName: string;
  envRaw: string | undefined;
  pluginKey: string;
  pluginValue: unknown;
  defaultValue: number;
  bounds: { min?: number; max?: number; integer?: boolean };
  parseInt?: boolean;
}): number {
  const fromEnv =
    args.envRaw !== undefined
      ? args.parseInt
        ? parseInt(args.envRaw, 10)
        : parseFloat(args.envRaw)
      : undefined;
  if (fromEnv !== undefined && Number.isFinite(fromEnv)) {
    return enforceNumericBound(fromEnv, args.envName, args.bounds);
  }
  const fromPlugin = toNumber(args.pluginValue);
  if (fromPlugin !== undefined) {
    return enforceNumericBound(fromPlugin, args.pluginKey, args.bounds);
  }
  return args.defaultValue;
}

/**
 * Resolve LCM configuration with three-tier precedence:
 *   1. Environment variables (highest — backward compat)
 *   2. Plugin config object (from plugins.entries.lossless-claw.config)
 *   3. Hardcoded defaults (lowest)
 *
 * All inputs are validated against `openclaw.plugin.json`'s configSchema and
 * against production-safety constraints (NUL bytes, newlines in scalars,
 * path length caps). Misconfigured values throw at plugin-load time rather
 * than surfacing as confusing downstream failures.
 */
export function resolveLcmConfig(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig?: Record<string, unknown>,
): LcmConfig {
  const pc = pluginConfig ?? {};

  // databasePath — reject NUL injection & cap length. The default path is
  // always within bounds; user-provided paths get rejected if hostile.
  const rawDatabasePath =
    env.LCM_DATABASE_PATH
    ?? toStr(pc.dbPath)
    ?? toStr(pc.databasePath)
    ?? join(homedir(), ".openclaw", "lcm.db");
  const databasePath = validatePath(
    rawDatabasePath,
    env.LCM_DATABASE_PATH !== undefined ? "LCM_DATABASE_PATH" : "pluginConfig.dbPath",
  );

  // vaultPath — same path sanitization; if vault is enabled but the path is
  // empty, throw early instead of silently no-op-ing inside vault-mirror.
  const rawVaultPath = env.LCM_VAULT_PATH?.trim() ?? toStr(pc.vaultPath) ?? "";
  const vaultPath = validatePath(
    rawVaultPath,
    env.LCM_VAULT_PATH !== undefined ? "LCM_VAULT_PATH" : "pluginConfig.vaultPath",
  );

  const vaultEnabled =
    env.LCM_VAULT_ENABLED !== undefined
      ? env.LCM_VAULT_ENABLED === "true"
      : toBool(pc.vaultEnabled) ?? false;
  if (vaultEnabled && vaultPath.length === 0) {
    throw new Error(
      "vaultEnabled=true but vaultPath is empty; set LCM_VAULT_PATH or pluginConfig.vaultPath to the Obsidian vault root",
    );
  }

  // Free-form scalars that flow into LLM prompts / provider headers — reject
  // newlines, NUL, and unreasonable lengths so a hostile env var can't smuggle
  // structured payloads downstream. summaryProvider / summaryModel are read
  // by index.ts from pluginConfig directly, but we still validate them here
  // so the misconfiguration surfaces at plugin load.
  validateScalar(
    env.LCM_SUMMARY_PROVIDER?.trim() ?? toStr(pc.summaryProvider) ?? "",
    env.LCM_SUMMARY_PROVIDER !== undefined ? "LCM_SUMMARY_PROVIDER" : "pluginConfig.summaryProvider",
  );
  validateScalar(
    env.LCM_SUMMARY_MODEL?.trim() ?? toStr(pc.summaryModel) ?? "",
    env.LCM_SUMMARY_MODEL !== undefined ? "LCM_SUMMARY_MODEL" : "pluginConfig.summaryModel",
  );
  const largeFileSummaryProvider = validateScalar(
    env.LCM_LARGE_FILE_SUMMARY_PROVIDER?.trim() ?? toStr(pc.largeFileSummaryProvider) ?? "",
    env.LCM_LARGE_FILE_SUMMARY_PROVIDER !== undefined
      ? "LCM_LARGE_FILE_SUMMARY_PROVIDER"
      : "pluginConfig.largeFileSummaryProvider",
  );
  const largeFileSummaryModel = validateScalar(
    env.LCM_LARGE_FILE_SUMMARY_MODEL?.trim() ?? toStr(pc.largeFileSummaryModel) ?? "",
    env.LCM_LARGE_FILE_SUMMARY_MODEL !== undefined
      ? "LCM_LARGE_FILE_SUMMARY_MODEL"
      : "pluginConfig.largeFileSummaryModel",
  );
  const timezone = validateScalar(
    env.TZ ?? toStr(pc.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    env.TZ !== undefined ? "TZ" : "pluginConfig.timezone",
  );

  // obsidianMode — manifest constrains to enum; reject anything else.
  const obsidianModeRaw =
    env.LCM_OBSIDIAN_MODE?.trim() ?? toStr(pc.obsidianMode) ?? "curated";
  if (obsidianModeRaw !== "curated" && obsidianModeRaw !== "diagnostic") {
    throw new Error(
      `${env.LCM_OBSIDIAN_MODE !== undefined ? "LCM_OBSIDIAN_MODE" : "pluginConfig.obsidianMode"} must be "curated" or "diagnostic" (got ${JSON.stringify(obsidianModeRaw)})`,
    );
  }

  return {
    enabled:
      env.LCM_ENABLED !== undefined
        ? env.LCM_ENABLED !== "false"
        : toBool(pc.enabled) ?? true,
    databasePath,
    // contextThreshold must lie in [0, 1] per manifest configSchema.
    contextThreshold: resolveBoundedNumber({
      envName: "LCM_CONTEXT_THRESHOLD",
      envRaw: env.LCM_CONTEXT_THRESHOLD,
      pluginKey: "pluginConfig.contextThreshold",
      pluginValue: pc.contextThreshold,
      defaultValue: 0.75,
      bounds: { min: 0, max: 1 },
    }),
    freshTailCount: resolveBoundedNumber({
      envName: "LCM_FRESH_TAIL_COUNT",
      envRaw: env.LCM_FRESH_TAIL_COUNT,
      pluginKey: "pluginConfig.freshTailCount",
      pluginValue: pc.freshTailCount,
      defaultValue: 32,
      bounds: { min: 1, integer: true },
      parseInt: true,
    }),
    leafMinFanout: resolveBoundedNumber({
      envName: "LCM_LEAF_MIN_FANOUT",
      envRaw: env.LCM_LEAF_MIN_FANOUT,
      pluginKey: "pluginConfig.leafMinFanout",
      pluginValue: pc.leafMinFanout,
      defaultValue: 8,
      bounds: { min: 2, integer: true },
      parseInt: true,
    }),
    condensedMinFanout: resolveBoundedNumber({
      envName: "LCM_CONDENSED_MIN_FANOUT",
      envRaw: env.LCM_CONDENSED_MIN_FANOUT,
      pluginKey: "pluginConfig.condensedMinFanout",
      pluginValue: pc.condensedMinFanout,
      defaultValue: 4,
      bounds: { min: 2, integer: true },
      parseInt: true,
    }),
    condensedMinFanoutHard: resolveBoundedNumber({
      envName: "LCM_CONDENSED_MIN_FANOUT_HARD",
      envRaw: env.LCM_CONDENSED_MIN_FANOUT_HARD,
      pluginKey: "pluginConfig.condensedMinFanoutHard",
      pluginValue: pc.condensedMinFanoutHard,
      defaultValue: 2,
      bounds: { min: 2, integer: true },
      parseInt: true,
    }),
    // incrementalMaxDepth: -1 is the sentinel meaning "unlimited"; manifest
    // bounds encode that with min: -1. Leave the special case intact.
    incrementalMaxDepth: resolveBoundedNumber({
      envName: "LCM_INCREMENTAL_MAX_DEPTH",
      envRaw: env.LCM_INCREMENTAL_MAX_DEPTH,
      pluginKey: "pluginConfig.incrementalMaxDepth",
      pluginValue: pc.incrementalMaxDepth,
      defaultValue: 0,
      bounds: { min: -1, integer: true },
      parseInt: true,
    }),
    leafChunkTokens: resolveBoundedNumber({
      envName: "LCM_LEAF_CHUNK_TOKENS",
      envRaw: env.LCM_LEAF_CHUNK_TOKENS,
      pluginKey: "pluginConfig.leafChunkTokens",
      pluginValue: pc.leafChunkTokens,
      defaultValue: 20000,
      bounds: { min: 1000, integer: true },
      parseInt: true,
    }),
    leafTargetTokens: resolveBoundedNumber({
      envName: "LCM_LEAF_TARGET_TOKENS",
      envRaw: env.LCM_LEAF_TARGET_TOKENS,
      pluginKey: "pluginConfig.leafTargetTokens",
      pluginValue: pc.leafTargetTokens,
      defaultValue: 1200,
      bounds: { min: 100, integer: true },
      parseInt: true,
    }),
    condensedTargetTokens: resolveBoundedNumber({
      envName: "LCM_CONDENSED_TARGET_TOKENS",
      envRaw: env.LCM_CONDENSED_TARGET_TOKENS,
      pluginKey: "pluginConfig.condensedTargetTokens",
      pluginValue: pc.condensedTargetTokens,
      defaultValue: 2000,
      bounds: { min: 100, integer: true },
      parseInt: true,
    }),
    maxExpandTokens: resolveBoundedNumber({
      envName: "LCM_MAX_EXPAND_TOKENS",
      envRaw: env.LCM_MAX_EXPAND_TOKENS,
      pluginKey: "pluginConfig.maxExpandTokens",
      pluginValue: pc.maxExpandTokens,
      defaultValue: 4000,
      bounds: { min: 100, integer: true },
      parseInt: true,
    }),
    largeFileTokenThreshold: resolveBoundedNumber({
      envName: "LCM_LARGE_FILE_TOKEN_THRESHOLD",
      envRaw: env.LCM_LARGE_FILE_TOKEN_THRESHOLD,
      pluginKey: "pluginConfig.largeFileThresholdTokens",
      // Two plugin-config aliases exist; prefer the manifest-blessed name but
      // fall back to the older `largeFileTokenThreshold` for legacy configs.
      pluginValue: pc.largeFileThresholdTokens ?? pc.largeFileTokenThreshold,
      defaultValue: 25000,
      bounds: { min: 1000, integer: true },
      parseInt: true,
    }),
    largeFileSummaryProvider,
    largeFileSummaryModel,
    autocompactDisabled:
      env.LCM_AUTOCOMPACT_DISABLED !== undefined
        ? env.LCM_AUTOCOMPACT_DISABLED === "true"
        : toBool(pc.autocompactDisabled) ?? false,
    timezone,
    pruneHeartbeatOk:
      env.LCM_PRUNE_HEARTBEAT_OK !== undefined
        ? env.LCM_PRUNE_HEARTBEAT_OK === "true"
        : toBool(pc.pruneHeartbeatOk) ?? false,
    vaultEnabled,
    vaultPath,
    vaultSubdir: validateScalar(
      env.LCM_VAULT_SUBDIR?.trim() ?? toStr(pc.vaultSubdir) ?? "Engram",
      env.LCM_VAULT_SUBDIR !== undefined ? "LCM_VAULT_SUBDIR" : "pluginConfig.vaultSubdir",
    ),
    vaultHomeNoteName: validateScalar(
      env.LCM_VAULT_HOME_NOTE_NAME?.trim() ?? toStr(pc.vaultHomeNoteName) ?? "Home",
      env.LCM_VAULT_HOME_NOTE_NAME !== undefined
        ? "LCM_VAULT_HOME_NOTE_NAME"
        : "pluginConfig.vaultHomeNoteName",
    ),
    vaultManualFolders: validateScalar(
      env.LCM_VAULT_MANUAL_FOLDERS?.trim() ?? toStr(pc.vaultManualFolders) ?? "Inbox,Manual",
      env.LCM_VAULT_MANUAL_FOLDERS !== undefined
        ? "LCM_VAULT_MANUAL_FOLDERS"
        : "pluginConfig.vaultManualFolders",
    ),
    vaultClean:
      env.LCM_VAULT_CLEAN !== undefined
        ? env.LCM_VAULT_CLEAN !== "false"
        : toBool(pc.vaultClean) ?? true,
    vaultReportsEnabled:
      env.LCM_VAULT_REPORTS_ENABLED !== undefined
        ? env.LCM_VAULT_REPORTS_ENABLED !== "false"
        : toBool(pc.vaultReportsEnabled) ?? true,
    obsidianMode: obsidianModeRaw,
    obsidianExportDiagnostics:
      env.LCM_OBSIDIAN_EXPORT_DIAGNOSTICS !== undefined
        ? env.LCM_OBSIDIAN_EXPORT_DIAGNOSTICS === "true"
        : toBool(pc.obsidianExportDiagnostics) ?? false,
  };
}
