#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { ZendeskSession, NotLoggedInError } from "./session.js";
import { ZendeskScraper } from "./scrape.js";

const cfg = loadConfig();
const session = new ZendeskSession(cfg);
const scraper = new ZendeskScraper(session);

const server = new McpServer({
  name: "zendesk-mcp",
  version: "0.1.0",
});

/** Wrap a handler so errors (esp. NotLoggedInError) become clean tool errors. */
function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

server.registerTool(
  "zendesk_login",
  {
    title: "Log in to Zendesk",
    description:
      "Open a VISIBLE browser window so you can sign in to Zendesk (password, " +
      "SSO, and 2FA all work). On success the session is saved and reused " +
      "headlessly by every other tool. Run this first, and again whenever a " +
      "tool reports the session has expired.",
    inputSchema: {},
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async () => {
    try {
      const { savedTo } = await session.login();
      return jsonResult({ status: "logged_in", sessionSavedTo: savedTo });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_session_status",
  {
    title: "Check Zendesk session status",
    description:
      "Report whether a saved Zendesk session exists and verify it is still " +
      "valid by loading an authenticated page. Use to decide if zendesk_login " +
      "is needed.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    if (!session.hasSavedSession()) {
      return jsonResult({ loggedIn: false, reason: "no_saved_session" });
    }
    try {
      const views = await scraper.listViews();
      return jsonResult({ loggedIn: true, viewCount: views.length });
    } catch (err) {
      if (err instanceof NotLoggedInError) {
        return jsonResult({ loggedIn: false, reason: "session_expired" });
      }
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_list_views",
  {
    title: "List Zendesk views",
    description:
      "List the agent's available ticket views with their numeric IDs and " +
      "titles. Use a returned `id` with zendesk_fetch_view_tickets.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    try {
      return jsonResult({ views: await scraper.listViews() });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_fetch_view_tickets",
  {
    title: "Fetch tickets in a view",
    description:
      "Fetch all tickets listed in a Zendesk view, following pagination. " +
      "Returns ticket id, subject, requester, status, and raw row cells. " +
      "Get a view id from zendesk_list_views.",
    inputSchema: {
      viewId: z
        .string()
        .describe("Numeric view id (from zendesk_list_views)."),
      maxPages: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Safety cap on pages to page through (default 20)."),
    },
    annotations: readOnly,
  },
  async ({ viewId, maxPages }) => {
    try {
      return jsonResult(await scraper.fetchViewTickets(viewId, maxPages ?? 20));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_search",
  {
    title: "Search Zendesk",
    description:
      "Search Zendesk via the agent search UI (/agent/search/?q=...). Accepts " +
      "any Zendesk search query string (e.g. 'status:open assignee:me product'). " +
      "Returns matching ticket rows.",
    inputSchema: {
      query: z.string().describe("Zendesk search query string."),
    },
    annotations: readOnly,
  },
  async ({ query }) => {
    try {
      return jsonResult({ query, results: await scraper.search(query) });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_get_ticket",
  {
    title: "Get ticket details",
    description:
      "Fetch full details for one ticket: subject, assignee, tags, sidebar " +
      "custom fields (including product name when present), the full " +
      "conversation/interaction history with authors and timestamps, and a list " +
      "of attachments. Each attachment includes a `url` — pass it to " +
      "zendesk_download_attachment to save the file.",
    inputSchema: {
      ticketId: z.string().describe("Numeric ticket id."),
    },
    annotations: readOnly,
  },
  async ({ ticketId }) => {
    try {
      return jsonResult(await scraper.getTicket(ticketId));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_download_attachment",
  {
    title: "Download a ticket attachment",
    description:
      "Download an attachment to the local filesystem using the authenticated " +
      "Zendesk session. Provide the attachment `url` from zendesk_get_ticket and " +
      "a `destination`. If `destination` is a directory, the attachment's own " +
      "filename is used; otherwise it is treated as the full file path.",
    inputSchema: {
      url: z
        .string()
        .describe(
          "The attachment URL from zendesk_get_ticket (…/attachments/token/…)."
        ),
      destination: z
        .string()
        .describe(
          "Target file path, or a directory to save into using the original filename."
        ),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ url, destination }) => {
    try {
      return jsonResult(await scraper.downloadAttachment(url, destination));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_inspect",
  {
    title: "Inspect a Zendesk page (diagnostic)",
    description:
      "Diagnostic tool for tuning selectors: navigate to an /agent path (or full " +
      "URL) and return the page's current URL, a screenshot, and trimmed HTML. " +
      "Use when another tool returns empty/partial data so selectors in " +
      "selectors.ts can be adjusted to your Zendesk version.",
    inputSchema: {
      path: z
        .string()
        .describe("An /agent path (e.g. '/agent/tickets/123') or full URL."),
    },
    annotations: readOnly,
  },
  async ({ path }) => {
    try {
      const { url, html, screenshotBase64 } = await scraper.inspect(path);
      return {
        content: [
          { type: "text" as const, text: `URL: ${url}\n\nHTML (trimmed):\n${html}` },
          { type: "image" as const, data: screenshotBase64, mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Clean up the browser on shutdown.
  const shutdown = async () => {
    await session.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
