import os from "node:os";
import path from "node:path";

/**
 * Runtime configuration, all sourced from environment variables so the server
 * can be pointed at any Zendesk instance without code changes.
 *
 *   ZENDESK_SUBDOMAIN     required — the {subdomain} in https://{subdomain}.zendesk.com
 *   ZENDESK_SESSION_DIR   optional — where the persisted Playwright session lives
 *                                    (default: ~/.zendesk-mcp)
 *   ZENDESK_API_TIMEOUT   optional — per-request timeout in ms (default 30000)
 *   ZENDESK_LOGIN_TIMEOUT optional — how long the visible login window waits for
 *                                    you to finish signing in, in ms (default 300000)
 *
 * GDPR Compliance Content Sanitization (on by default — see sanitizer.ts):
 *
 *   ZENDESK_GDPR_SANITIZATION  optional — "false"/"0"/"off" disables PII redaction
 *                                         of tool output (default: enabled)
 *   ZENDESK_GDPR_MODEL         optional — Hugging Face model id of the ONNX PII model
 *                                         (default bardsai/eu-pii-anonimization-multilang)
 *   ZENDESK_GDPR_MODEL_DTYPE   optional — weight variant to load: q8 or fp32 (default q8)
 *   ZENDESK_GDPR_MODEL_DIR     optional — where model files are cached
 *                                         (default: {ZENDESK_SESSION_DIR}/models)
 *   ZENDESK_GDPR_KEEP_ENTITIES optional — comma-separated entity types to leave
 *                                         unredacted (default FINANCIAL_AMOUNT)
 *   ZENDESK_GDPR_ALLOWLIST     optional — comma-separated terms never redacted,
 *                                         e.g. product names (case-insensitive)
 *   ZENDESK_GDPR_THRESHOLD     optional — probability (0–1) a token must have of
 *                                         being PII to be redacted (default 0.5)
 *   ZENDESK_GDPR_PSEUDONYMS    optional — "false" uses plain [TYPE] placeholders
 *                                         instead of numbered [TYPE_n] (default: on)
 */
export interface Config {
  subdomain: string | undefined;
  sessionDir: string;
  storageStatePath: string;
  /** Where the captured CSRF token (needed for write requests) is persisted. */
  csrfTokenPath: string;
  apiTimeoutMs: number;
  loginTimeoutMs: number;
  gdpr: GdprConfig;
}

/** Settings for the "GDPR Compliance Content Sanitization" option. */
export interface GdprConfig {
  /** Redact personal data from every tool result before it reaches the LLM. */
  enabled: boolean;
  /** Hugging Face model id of an XLM-R token-classification model with ONNX weights. */
  model: string;
  /** Which quantization of the weights to load (q8, q4, fp32, …). */
  dtype: string;
  /** Local cache for the downloaded model files. */
  modelDir: string;
  /** Entity types (e.g. FINANCIAL_AMOUNT) that are detected but deliberately not redacted. */
  keepEntities: Set<string>;
  /** Terms (e.g. product names) that are never redacted, matched case-insensitively. */
  allowlist: string[];
  /** Minimum 1 − P("O") for a token to be redacted; lower catches more. */
  threshold: number;
  /** Number placeholders per distinct value ("[PERSON_NAME_2]") instead of "[PERSON_NAME]". */
  pseudonyms: boolean;
}

/** Comma-separated env list, trimmed, empties dropped. */
function envList(value: string): string[] {
  return value
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** A number in (0, 1]; anything else falls back to the default. */
function envProbability(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value?.trim() && n > 0 && n <= 1 ? n : fallback;
}

/** Anything but an explicit "off" value counts as enabled. */
function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !/^(0|false|no|off|disabled?)$/i.test(value.trim());
}

export function loadConfig(): Config {
  const sessionDir =
    process.env.ZENDESK_SESSION_DIR ||
    path.join(os.homedir(), ".zendesk-mcp");

  return {
    subdomain: process.env.ZENDESK_SUBDOMAIN?.trim() || undefined,
    sessionDir,
    storageStatePath: path.join(sessionDir, "storageState.json"),
    csrfTokenPath: path.join(sessionDir, "csrf.txt"),
    apiTimeoutMs: Number(process.env.ZENDESK_API_TIMEOUT) || 30_000,
    loginTimeoutMs: Number(process.env.ZENDESK_LOGIN_TIMEOUT) || 300_000,
    gdpr: {
      enabled: envFlag(process.env.ZENDESK_GDPR_SANITIZATION, true),
      model:
        process.env.ZENDESK_GDPR_MODEL?.trim() ||
        "bardsai/eu-pii-anonimization-multilang",
      dtype: process.env.ZENDESK_GDPR_MODEL_DTYPE?.trim() || "q8",
      modelDir:
        process.env.ZENDESK_GDPR_MODEL_DIR || path.join(sessionDir, "models"),
      keepEntities: new Set(
        envList(process.env.ZENDESK_GDPR_KEEP_ENTITIES ?? "FINANCIAL_AMOUNT").map((e) =>
          e.toUpperCase()
        )
      ),
      allowlist: envList(process.env.ZENDESK_GDPR_ALLOWLIST ?? ""),
      threshold: envProbability(process.env.ZENDESK_GDPR_THRESHOLD, 0.5),
      pseudonyms: envFlag(process.env.ZENDESK_GDPR_PSEUDONYMS, true),
    },
  };
}

/** Throws a clear, user-facing error if the subdomain isn't configured. */
export function requireSubdomain(cfg: Config): string {
  if (!cfg.subdomain) {
    throw new Error(
      "ZENDESK_SUBDOMAIN is not set. Set it to your Zendesk subdomain " +
        "(the part before .zendesk.com) in the MCP server's env config."
    );
  }
  return cfg.subdomain;
}

/** Origin for the instance, e.g. https://youracme.zendesk.com */
export function baseUrl(subdomain: string): string {
  return `https://${subdomain}.zendesk.com`;
}

/** REST API v2 base, e.g. https://youracme.zendesk.com/api/v2 */
export function apiBase(subdomain: string): string {
  return `${baseUrl(subdomain)}/api/v2`;
}
