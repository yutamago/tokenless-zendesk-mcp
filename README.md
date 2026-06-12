# Zendesk MCP (browser-driven)

An MCP server that drives the **Zendesk Agent web UI through a headless Playwright
browser** — it uses **no Zendesk REST API and no API token**. It signs in like a
person, then scrapes the rendered agent interface.

## What it can do

| Tool | Description |
|---|---|
| `zendesk_login` | Open a **visible** browser to sign in (password / SSO / 2FA). Saves the session. |
| `zendesk_session_status` | Check whether a saved session exists and is still valid. |
| `zendesk_list_views` | List the agent's views with their numeric IDs. |
| `zendesk_fetch_view_tickets` | Fetch all tickets in a view, following pagination. |
| `zendesk_search` | Search via `/agent/search/?q=…`. |
| `zendesk_get_ticket` | Subject, assignee, tags, custom fields (incl. product), full conversation, and attachments. |
| `zendesk_download_attachment` | Download an attachment (by its `url` from `get_ticket`) to a path or directory. |
| `zendesk_inspect` | Diagnostic: dump a page's HTML + screenshot to tune selectors. |

> Notifications were intentionally left out for now — the tray scraping is wired up
> in git history but was removed until there are real notifications to validate against.

**Attachments.** `zendesk_get_ticket` returns an `attachments` array; each item has a
`token`, `filename`, `url`, and `source` (`image` for inline images, `link` for file
attachments like logs/PDFs). Pass an attachment's `url` to `zendesk_download_attachment`
along with a `destination` (a file path, or a directory to save under the original
filename). Downloads use the authenticated session, so private attachments work.

## How auth works

You sign in **once** in a real browser window — any method works, including SSO
and 2FA. Playwright saves the resulting cookies/localStorage to
`~/.zendesk-mcp/storageState.json`. Every other tool spins up a headless browser
seeded from that file, so reads run with no credentials in code. When the session
expires, tools return a clear "run `zendesk_login`" message.

> The session file holds live auth cookies — it's git-ignored. Treat it like a password.

## Setup

```bash
npm install        # also runs `playwright install chromium`
npm run build
```

### First login

The login step needs a **visible** browser, so it needs a display.

```bash
ZENDESK_SUBDOMAIN=youracme npm run login
```

- **macOS / Windows / Linux desktop:** a Chromium window opens — sign in, done.
- **WSL2:** you need **WSLg** (Windows 11) or an X server so the window can show.
  If `npm run login` can't open a window, run the login step on the Windows host,
  or set `DISPLAY` to your X server.

You can also trigger login from inside Claude with the `zendesk_login` tool, but
the standalone CLI is more reliable since not every MCP host surfaces the window.

## Add to Claude Code

```bash
claude mcp add zendesk -- node /home/angelo/workspaces/oss_ws/zendesk_mcp/dist/index.js
```

Or add to your MCP config (`.mcp.json` / Claude Desktop config):

```json
{
  "mcpServers": {
    "zendesk": {
      "command": "node",
      "args": ["/home/angelo/workspaces/oss_ws/zendesk_mcp/dist/index.js"],
      "env": {
        "ZENDESK_SUBDOMAIN": "youracme"
      }
    }
  }
}
```

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `ZENDESK_SUBDOMAIN` | — (**required**) | The `{subdomain}` in `https://{subdomain}.zendesk.com`. |
| `ZENDESK_SESSION_DIR` | `~/.zendesk-mcp` | Where the saved session lives. |
| `ZENDESK_HEADLESS` | `true` | Set `false` to watch read operations in a real window (debugging). |
| `ZENDESK_NAV_TIMEOUT` | `45000` | Per-navigation timeout in ms. |

## Tuning selectors

The Agent SPA's markup changes between Zendesk releases. All DOM selectors live in
**`src/selectors.ts`**, targeting stable `data-test-id` attributes and href
patterns with fallbacks. If a tool returns empty or partial data:

1. Call `zendesk_inspect` with the relevant path (e.g. `/agent/tickets/123`).
2. Inspect the returned HTML/screenshot to find the right selector.
3. Update `src/selectors.ts`, then `npm run build`.

## Limitations

- This depends on Zendesk's HTML; treat it as best-effort scraping, not a stable API.
- It respects whatever permissions your agent account has — nothing more.
- Heavy/automated use may run afoul of your Zendesk plan's terms; use responsibly.
