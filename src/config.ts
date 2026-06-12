import os from "node:os";
import path from "node:path";

/**
 * Runtime configuration, all sourced from environment variables so the server
 * can be pointed at any Zendesk instance without code changes.
 *
 *   ZENDESK_SUBDOMAIN   required — the {subdomain} in https://{subdomain}.zendesk.com
 *   ZENDESK_SESSION_DIR optional — where the persisted Playwright session lives
 *                                  (default: ~/.zendesk-mcp)
 *   ZENDESK_HEADLESS    optional — "false" forces a visible browser for all ops
 *                                  (login is always visible regardless)
 *   ZENDESK_NAV_TIMEOUT optional — navigation/render timeout in ms (default 45000)
 */
export interface Config {
  subdomain: string | undefined;
  sessionDir: string;
  storageStatePath: string;
  headless: boolean;
  navTimeoutMs: number;
}

export function loadConfig(): Config {
  const sessionDir =
    process.env.ZENDESK_SESSION_DIR ||
    path.join(os.homedir(), ".zendesk-mcp");

  return {
    subdomain: process.env.ZENDESK_SUBDOMAIN?.trim() || undefined,
    sessionDir,
    storageStatePath: path.join(sessionDir, "storageState.json"),
    headless: process.env.ZENDESK_HEADLESS !== "false",
    navTimeoutMs: Number(process.env.ZENDESK_NAV_TIMEOUT) || 45000,
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

export function baseUrl(subdomain: string): string {
  return `https://${subdomain}.zendesk.com`;
}
