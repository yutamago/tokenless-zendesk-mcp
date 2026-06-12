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
 */
export interface Config {
  subdomain: string | undefined;
  sessionDir: string;
  storageStatePath: string;
  /** Where the captured CSRF token (needed for write requests) is persisted. */
  csrfTokenPath: string;
  apiTimeoutMs: number;
  loginTimeoutMs: number;
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
