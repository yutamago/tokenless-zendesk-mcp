#!/usr/bin/env node
/**
 * Standalone login helper. Run `npm run login` (after `npm run build`) to open a
 * visible browser, sign in to Zendesk once, and persist the session cookies the
 * MCP server then replays against the Zendesk REST API. Handy because some MCP
 * hosts don't surface the interactive browser window the in-tool `zendesk_login`
 * opens.
 */
import { loadConfig, requireSubdomain } from "./config.js";
import { ZendeskSession } from "./session.js";

async function main() {
  const cfg = loadConfig();
  requireSubdomain(cfg); // fail fast with a clear message
  const session = new ZendeskSession(cfg);

  console.error(`Opening browser to sign in to ${cfg.subdomain}.zendesk.com ...`);
  console.error("Complete the login (password / SSO / 2FA) in the window.");
  const { savedTo } = await session.login();
  console.error(`✓ Session saved to ${savedTo}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Login failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
