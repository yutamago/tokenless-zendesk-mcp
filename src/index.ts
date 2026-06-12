#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, requireSubdomain } from "./config.js";
import { ZendeskSession, NotLoggedInError } from "./session.js";
import { ZendeskApi } from "./api.js";

const cfg = loadConfig();
const session = new ZendeskSession(cfg);
const api = new ZendeskApi(session, cfg);

const server = new McpServer({
  name: "zendesk-mcp",
  version: "0.3.0",
});

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
      "SSO, and 2FA all work). On success the session cookies are saved and " +
      "reused by every other tool to call the Zendesk REST API. Run this first, " +
      "and again whenever a tool reports the session has expired.",
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
      "valid by calling the API as the current user. Use to decide if " +
      "zendesk_login is needed.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    if (!session.hasSavedSession()) {
      return jsonResult({ loggedIn: false, reason: "no_saved_session" });
    }
    try {
      const user = await api.me();
      return jsonResult({ loggedIn: true, user });
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
      "List the agent's active ticket views with their numeric IDs, titles, and " +
      "cached ticket counts. Use a returned `id` with zendesk_fetch_view_tickets.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    try {
      return jsonResult({ views: await api.listViews() });
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
      "Fetch tickets listed in a Zendesk view, following pagination. Returns " +
      "ticket id, subject, status, priority, requester, assignee, group, and " +
      "timestamps. Get a view id from zendesk_list_views.",
    inputSchema: {
      viewId: z.string().describe("Numeric view id (from zendesk_list_views)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Max tickets to return (default 200). Pages 100 at a time."),
    },
    annotations: readOnly,
  },
  async ({ viewId, limit }) => {
    try {
      return jsonResult(await api.fetchViewTickets(viewId, limit ?? 200));
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
      "Search Zendesk via the REST API (/api/v2/search). Accepts any Zendesk " +
      "search query string (e.g. 'type:ticket status:open assignee:me'). Returns " +
      "matching results, each tagged with its result_type (ticket, user, " +
      "organization, group) and the raw API record.",
    inputSchema: {
      query: z.string().describe("Zendesk search query string."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Max results to return (default 200; API caps search at 1000)."),
    },
    annotations: readOnly,
  },
  async ({ query, limit }) => {
    try {
      return jsonResult({ query, results: await api.search(query, limit ?? 200) });
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
      "Fetch full details for one ticket: subject, description, status, " +
      "priority, type, tags, requester/assignee/submitter, group, organization, " +
      "custom fields (with titles, including the product field when present), " +
      "the full comment thread with authors and timestamps, and a list of " +
      "attachments. Each attachment includes a `content_url` — pass it to " +
      "zendesk_download_attachment to save the file.",
    inputSchema: {
      ticketId: z.string().describe("Numeric ticket id."),
    },
    annotations: readOnly,
  },
  async ({ ticketId }) => {
    try {
      return jsonResult(await api.getTicket(ticketId));
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
      "Zendesk session. Provide the attachment `content_url` from " +
      "zendesk_get_ticket and a `destination`. If `destination` is a directory, " +
      "the attachment's own filename is used; otherwise it is the full file path.",
    inputSchema: {
      url: z
        .string()
        .describe("The attachment content_url from zendesk_get_ticket."),
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
      return jsonResult(await api.downloadAttachment(url, destination));
    } catch (err) {
      return errorResult(err);
    }
  }
);

/* ------------------------------ Tier 1 reads ----------------------------- */

server.registerTool(
  "zendesk_requester_tickets",
  {
    title: "List a requester's tickets",
    description:
      "List tickets requested by a user (their reported tickets), most recent " +
      "first — useful for seeing whether a customer has raised this before. Get " +
      "a user id from zendesk_get_ticket (requester) or zendesk_search_users.",
    inputSchema: {
      userId: z.string().describe("Numeric user id of the requester."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max tickets (default 100)."),
    },
    annotations: readOnly,
  },
  async ({ userId, limit }) => {
    try {
      return jsonResult(await api.requesterTickets(userId, limit ?? 100));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_organization_tickets",
  {
    title: "List an organization's tickets",
    description:
      "List tickets belonging to an organization, most recent first. Get an " +
      "organization id from a ticket (organization field) or a user record.",
    inputSchema: {
      organizationId: z.string().describe("Numeric organization id."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max tickets (default 100)."),
    },
    annotations: readOnly,
  },
  async ({ organizationId, limit }) => {
    try {
      return jsonResult(await api.organizationTickets(organizationId, limit ?? 100));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_ticket_fields",
  {
    title: "List ticket field definitions",
    description:
      "List ticket field definitions, including the valid dropdown/tagger " +
      "option values. Use this to find the exact `value` to pass when setting a " +
      "custom field via zendesk_update_ticket (e.g. the sentiment or product field).",
    inputSchema: {
      activeOnly: z.boolean().optional().describe("Only active fields (default true)."),
    },
    annotations: readOnly,
  },
  async ({ activeOnly }) => {
    try {
      return jsonResult({ fields: await api.ticketFields(activeOnly ?? true) });
    } catch (err) {
      return errorResult(err);
    }
  }
);

/* ------------------------------ Tier 2 reads ----------------------------- */

server.registerTool(
  "zendesk_ticket_metrics",
  {
    title: "Get ticket SLA / timing metrics",
    description:
      "Fetch timing and SLA metrics for one ticket: first reply time, full/agent " +
      "resolution time, reopens, replies, and assignee/requester wait times.",
    inputSchema: {
      ticketId: z.string().describe("Numeric ticket id."),
    },
    annotations: readOnly,
  },
  async ({ ticketId }) => {
    try {
      return jsonResult(await api.ticketMetrics(ticketId));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_list_macros",
  {
    title: "List macros",
    description:
      "List active macros (canned actions) with their ids and titles. Use a " +
      "returned id with zendesk_apply_macro.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    try {
      return jsonResult({ macros: await api.listMacros() });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_search_users",
  {
    title: "Search users",
    description:
      "Find users by a free-text query (name, email, phone, etc.). Returns id, " +
      "name, email, role, and organization.",
    inputSchema: {
      query: z.string().describe("Search text (e.g. an email address or name)."),
      limit: z.number().int().min(1).max(500).optional().describe("Max users (default 50)."),
    },
    annotations: readOnly,
  },
  async ({ query, limit }) => {
    try {
      return jsonResult({ users: await api.searchUsers(query, limit ?? 50) });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_get_user",
  {
    title: "Get a user",
    description: "Fetch one user by id (name, email, role, organization).",
    inputSchema: {
      userId: z.string().describe("Numeric user id."),
    },
    annotations: readOnly,
  },
  async ({ userId }) => {
    try {
      return jsonResult(await api.getUser(userId));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_ticket_audits",
  {
    title: "Get ticket audit trail",
    description:
      "Fetch the full audit trail for a ticket: every change and event " +
      "(field updates, status changes, comments, notifications) with authors " +
      "and timestamps. More complete than the comment thread alone.",
    inputSchema: {
      ticketId: z.string().describe("Numeric ticket id."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max audits (default 100)."),
    },
    annotations: readOnly,
  },
  async ({ ticketId, limit }) => {
    try {
      return jsonResult({ audits: await api.ticketAudits(ticketId, limit ?? 100) });
    } catch (err) {
      return errorResult(err);
    }
  }
);

/* --------------------------------- writes -------------------------------- */

server.registerTool(
  "zendesk_add_comment",
  {
    title: "Add a comment to a ticket",
    description:
      "Add a comment to a ticket. By default the comment is PUBLIC (visible to " +
      "the requester); set isPublic=false for an internal note. This modifies " +
      "the ticket — confirm the wording with the user before sending. Returns " +
      "the updated ticket.",
    inputSchema: {
      ticketId: z.string().describe("Numeric ticket id."),
      body: z.string().describe("The comment text (plain text)."),
      isPublic: z
        .boolean()
        .optional()
        .describe("true = public reply (default), false = internal note."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ ticketId, body, isPublic }) => {
    try {
      return jsonResult(await api.addComment(ticketId, body, isPublic ?? true));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_update_ticket",
  {
    title: "Update a ticket",
    description:
      "Update fields on a ticket: status, priority, type, assignee, group, tags, " +
      "and custom fields. For custom field values, look up the exact `value` with " +
      "zendesk_ticket_fields. Optionally include a comment. This modifies the " +
      "ticket — confirm changes with the user first. Returns the updated ticket.",
    inputSchema: {
      ticketId: z.string().describe("Numeric ticket id."),
      status: z
        .enum(["new", "open", "pending", "hold", "solved", "closed"])
        .optional()
        .describe("New ticket status."),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      type: z.enum(["problem", "incident", "question", "task"]).optional(),
      assigneeId: z.number().int().optional().describe("Assignee user id."),
      groupId: z.number().int().optional().describe("Group id."),
      tags: z.array(z.string()).optional().describe("Replaces the ticket's tags."),
      customFields: z
        .array(
          z.object({
            id: z.number().int(),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
          })
        )
        .optional()
        .describe("Custom field values: [{ id, value }]. Values from zendesk_ticket_fields."),
      comment: z.string().optional().describe("Optional comment to add with the update."),
      commentPublic: z
        .boolean()
        .optional()
        .describe("Whether the optional comment is public (default true)."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ ticketId, status, priority, type, assigneeId, groupId, tags, customFields, comment, commentPublic }) => {
    try {
      const update: Parameters<typeof api.updateTicket>[1] = {};
      if (status) update.status = status;
      if (priority) update.priority = priority;
      if (type) update.type = type;
      if (assigneeId !== undefined) update.assignee_id = assigneeId;
      if (groupId !== undefined) update.group_id = groupId;
      if (tags) update.tags = tags;
      if (customFields) update.custom_fields = customFields;
      if (comment) update.comment = { body: comment, public: commentPublic ?? true };
      return jsonResult(await api.updateTicket(ticketId, update));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_apply_macro",
  {
    title: "Apply a macro to a ticket",
    description:
      "Apply a macro (canned action) to a ticket and persist the resulting " +
      "changes (status, fields, and/or a comment). Get a macro id from " +
      "zendesk_list_macros. This modifies the ticket — confirm with the user " +
      "first. Returns the changes applied and the updated ticket.",
    inputSchema: {
      ticketId: z.string().describe("Numeric ticket id."),
      macroId: z.string().describe("Numeric macro id (from zendesk_list_macros)."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ ticketId, macroId }) => {
    try {
      return jsonResult(await api.applyMacro(ticketId, macroId));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "zendesk_request",
  {
    title: "Call a Zendesk API endpoint (read-only)",
    description:
      "Make a read-only (GET) request to any Zendesk REST API v2 endpoint and " +
      "return the parsed JSON. Use for anything the dedicated tools don't cover " +
      "(audits, satisfaction ratings, organizations, users, ticket metrics, " +
      "etc.). `path` may be a bare resource like 'tickets/123/audits' or a full " +
      "'/api/v2/...' path. Pass query parameters via `query`. See " +
      "https://developer.zendesk.com/api-reference/ for available endpoints.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "API path, e.g. 'tickets/123/audits' or '/api/v2/users/me.json'."
        ),
      query: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Optional query parameters, e.g. { page: 2, per_page: 50 }."),
    },
    annotations: readOnly,
  },
  async ({ path, query }) => {
    try {
      return jsonResult(await api.request(path, query));
    } catch (err) {
      return errorResult(err);
    }
  }
);

/**
 * Run the one-time interactive login, then exit. Exposed as the `login`
 * subcommand so `npx tokenless-zendesk-mcp login` works without a clone or build
 * step — some MCP hosts also don't surface the window the `zendesk_login` tool
 * opens, so a standalone command is more reliable.
 */
async function runLogin() {
  requireSubdomain(cfg); // fail fast with a clear message
  console.error(`Opening browser to sign in to ${cfg.subdomain}.zendesk.com ...`);
  console.error("Complete the login (password / SSO / 2FA) in the window.");
  const { savedTo } = await session.login();
  console.error(`✓ Session saved to ${savedTo}`);
  process.exit(0);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const entry = process.argv[2] === "login" ? runLogin() : main();
entry.catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
