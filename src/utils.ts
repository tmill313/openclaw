// Shared filesystem, path, and process helpers for the CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathExists as fsSafePathExists } from "./infra/fs-safe.js";
import {
  resolveEffectiveHomeDir,
  resolveRequiredHomeDir,
  resolveUserPath,
} from "./infra/home-dir.js";
import { shortenPathWithHome } from "./infra/home-display.js";
import { isPlainObject } from "./infra/plain-object.js";
import { escapeRegExp as escapeRegExpValue } from "./shared/regexp.js";
export { escapeRegExp } from "./shared/regexp.js";
export { sleep } from "./utils/sleep.js";
export { isRecord } from "@openclaw/normalization-core/record-coerce";
export { resolveUserPath };

/** Creates a directory tree if it does not already exist. */
export async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/** Clamps a number to an inclusive min/max range. */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Checks whether a string is empty or contains only whitespace. */
export function isBlank(input: string): boolean {
  return input.trim().length === 0;
}

/** Converts each space-delimited word to title case while preserving whitespace. */
export function titleCase(input: string): string {
  return input
    .split(" ")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");
}

/** Rounds a number to the nearest positive finite step. */
export function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    throw new RangeError("step must be a finite positive number");
  }
  if (!Number.isFinite(value)) {
    return value;
  }
  return Math.round(value / step) * step;
}

/** Clamps a finite percentage to the inclusive 0-100 range. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clampNumber(value, 0, 100);
}

/** Checks whether a finite number is within a finite inclusive min/max range. */
export function isWithinRange(value: number, min: number, max: number): boolean {
  if (min > max) {
    throw new RangeError("min must be less than or equal to max");
  }
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
    return false;
  }
  return value >= min && value <= max;
}

/** Floors a number before clamping it to an inclusive min/max range. */
export function clampInt(value: number, min: number, max: number): number {
  return clampNumber(Math.floor(value), min, max);
}

/** Alias for clampNumber (shorter, more common name) */
export const clamp = clampNumber;

/**
 * Safely parse JSON, returning null on error instead of throwing.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- JSON parsing helper lets callers ascribe the expected payload type.
export function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export { isPlainObject };

/** Normalizes phone-like input into the loose E.164 shape used by channel helpers. */
export function normalizeE164(number: string): string {
  const withoutPrefix = number.replace(/^[a-z][a-z0-9-]*:/i, "").trim();
  const digits = withoutPrefix.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

// Surrogate-safe slicing helpers live in a node-free leaf module so browser/UI
// bundles can import them without pulling in filesystem code. Re-exported here
// to preserve the historical `utils.ts` import surface.
export { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Resolves the OpenClaw config directory from state/config env overrides or home. */
export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return path.dirname(resolveUserPath(configPath, env, homedir));
  }
  const newDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
  try {
    const hasNew = fs.existsSync(newDir);
    if (hasNew) {
      return newDir;
    }
  } catch {
    // best-effort
  }
  return newDir;
}

/** Resolves the effective OpenClaw home directory, if one can be determined. */
export function resolveHomeDir(): string | undefined {
  return resolveEffectiveHomeDir(process.env, os.homedir);
}

function resolveHomeDisplayPrefix(): { home: string; prefix: string } | undefined {
  const home = resolveHomeDir();
  if (!home) {
    return undefined;
  }
  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  if (explicitHome) {
    return { home, prefix: "$OPENCLAW_HOME" };
  }
  return { home, prefix: "~" };
}

/** Replaces the leading home directory in a path with `~` or `$OPENCLAW_HOME`. */
export function shortenHomePath(input: string): string {
  const display = resolveHomeDisplayPrefix();
  if (!display) {
    return input;
  }
  return shortenPathWithHome(input, display);
}

/** Formats elapsed milliseconds using the two largest non-zero duration units. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError("elapsed duration must be a finite non-negative number");
  }

  let remainingSeconds = Math.floor(ms / 1000);
  const parts: string[] = [];
  const units = [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ] as const;

  for (const [unitSeconds, suffix] of units) {
    const value = Math.floor(remainingSeconds / unitSeconds);
    if (value > 0) {
      parts.push(`${value}${suffix}`);
      if (parts.length === 2) {
        break;
      }
    }
    remainingSeconds %= unitSeconds;
  }

  return parts.length > 0 ? parts.join(" ") : "0s";
}

/** Masks recognized secret-shaped tokens while preserving all surrounding text. */
export function redactSecrets(input: string): string {
  // Standalone token grammars: OpenAI sk- + 20 alphanumerics; GitHub ghp_/gho_/ghs_
  // + 20 alphanumerics or github_pat_ + 20 alphanumerics/underscores; Slack xox<letter>-
  // + 10 alphanumerics/dashes; and AWS AKIA + exactly 16 uppercase alphanumerics.
  const redactedTokens = input.replace(
    /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9]{20,}|(?:ghp_|gho_|ghs_)[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[A-Za-z]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9_-])/g,
    (secret) => `${secret.slice(0, 4)}…`,
  );

  // Bearer values use the HTTP-token subset accepted here, with horizontal whitespace around
  // the case-insensitive Bearer scheme. The header spelling and whitespace are left byte-identical.
  return redactedTokens.replace(
    /(Authorization:[\t ]+Bearer[\t ]+)([A-Za-z0-9._~+/=-]{8,})(?![A-Za-z0-9._~+/=-])/gi,
    (_match, prefix: string, secret: string) => `${prefix}${secret.slice(0, 4)}…`,
  );
}

/** Replaces all effective-home occurrences inside a diagnostic string. */
export function shortenHomeInString(input: string): string {
  if (!input) {
    return input;
  }
  const display = resolveHomeDisplayPrefix();
  if (!display) {
    return input;
  }
  if (process.platform === "win32") {
    return input.replace(new RegExp(escapeRegExpValue(display.home), "giu"), display.prefix);
  }
  return input.split(display.home).join(display.prefix);
}

/** Shortens a path for display without changing non-home paths. */
export function displayPath(input: string): string {
  return shortenHomePath(input);
}

/** Shortens home paths embedded in arbitrary display text. */
export function displayString(input: string): string {
  return shortenHomeInString(input);
}

// Gateway startup re-pins this live binding after config/state selection converges so modules
// imported during early CLI bootstrap cannot keep using the superseded configuration root.
export let CONFIG_DIR = resolveConfigDir();

export function pinConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  CONFIG_DIR = resolveConfigDir(env);
  return CONFIG_DIR;
}
/**
 * Check if a file or directory exists at the given path.
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  return await fsSafePathExists(targetPath);
}
