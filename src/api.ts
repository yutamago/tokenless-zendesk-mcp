import fs from "node:fs";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { apiBase, baseUrl, requireSubdomain, type Config } from "./config.js";
import { NotLoggedInError, ZendeskSession } from "./session.js";

/**
 * A realistic browser User-Agent. Auth is the session cookie alone, but some
 * edges treat unknown agents differently, so we present as a browser.
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const MAX_RETRIES = 3;
const PAGE_SIZE = 100; // Zendesk's max for most list endpoints.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Query = Record<string, string | number | boolean | undefined | null>;

/* ----------------------------- result shapes ----------------------------- */

export interface ViewSummary {
  id: number;
  title: string;
  active: boolean;
  /** Cached ticket count for the view, or null if Zendesk didn't return one. */
  count: number | null;
}

export interface TicketRow {
  id: number;
  url: string; // agent UI deep-link
  subject: string | null;
  status: string | null;
  priority: string | null;
  type: string | null;
  requester: string | null;
  assignee: string | null;
  group: string | null;
  created_at: string | null;
  updated_at: string | null;
  tags: string[];
}

export interface SearchResult {
  result_type: string | null;
  id: number | null;
  url: string | null;
  /** The raw API record, so callers can read any field the type carries. */
  raw: Record<string, unknown>;
}

export interface CustomFieldValue {
  id: number;
  title: string | null;
  value: unknown;
}

export interface CommentAttachment {
  id: number;
  file_name: string;
  content_url: string;
  content_type: string | null;
  size: number | null;
}

export interface ConversationEvent {
  id: number;
  author: string | null;
  author_id: number | null;
  public: boolean;
  created_at: string | null;
  body: string;
  html_body: string | null;
  attachments: CommentAttachment[];
}

export interface TicketDetail {
  id: number;
  url: string; // agent UI deep-link
  subject: string | null;
  description: string | null;
  status: string | null;
  priority: string | null;
  type: string | null;
  tags: string[];
  requester: string | null;
  assignee: string | null;
  submitter: string | null;
  group: string | null;
  organization: string | null;
  created_at: string | null;
  updated_at: string | null;
  custom_fields: CustomFieldValue[];
  /** Convenience: value of the first custom field whose title matches /product/i. */
  product: string | null;
  conversation: ConversationEvent[];
  attachments: CommentAttachment[];
}

export interface TicketFieldOption {
  name: string;
  value: string;
}

export interface TicketFieldDef {
  id: number;
  title: string | null;
  type: string;
  active: boolean;
  required: boolean;
  /** Dropdown/tagger options, when applicable — the valid values to set. */
  options: TicketFieldOption[];
}

export interface UserSummary {
  id: number;
  name: string | null;
  email: string | null;
  role: string | null;
  organization_id: number | null;
  active: boolean;
  created_at: string | null;
}

export interface MacroSummary {
  id: number;
  title: string;
  active: boolean;
  /** Short human description of what the macro changes, when available. */
  description: string | null;
}

export interface AuditEvent {
  id: number;
  created_at: string | null;
  author_id: number | null;
  author: string | null;
  events: Array<Record<string, unknown>>;
}

/** Flexible set of fields to update on a ticket. */
export interface TicketUpdate {
  status?: string;
  priority?: string;
  type?: string;
  assignee_id?: number;
  group_id?: number;
  tags?: string[];
  custom_fields?: Array<{ id: number; value: unknown }>;
  /** Optional comment to add alongside the update. */
  comment?: { body: string; public?: boolean; html_body?: string };
}

/* -------------------------------- helpers -------------------------------- */

function indexById<T extends { id: number }>(arr: T[] | undefined): Map<number, T> {
  const m = new Map<number, T>();
  for (const x of arr ?? []) m.set(x.id, x);
  return m;
}

function userName(users: Map<number, any>, id: number | null | undefined): string | null {
  if (id == null) return null;
  return users.get(id)?.name ?? null;
}

/** Parse the `name=` filename from a Zendesk attachment/content URL. */
function filenameFromUrl(url: string): string | null {
  const m = url.match(/[?&]name=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  // content_url may instead end in the filename path segment.
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last && last.includes(".") ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a download target. If `destination` is an existing directory (or ends
 * with a path separator), append the attachment's own filename; otherwise use it
 * as the literal file path.
 */
function resolveDestination(destination: string, fallbackName: string | null): string {
  const endsWithSep = /[\\/]$/.test(destination);
  let isDir = endsWithSep;
  if (!isDir) {
    try {
      isDir = fs.statSync(destination).isDirectory();
    } catch {
      isDir = false;
    }
  }
  return isDir ? path.join(destination, fallbackName || "attachment") : destination;
}

/* ------------------------------- the client ------------------------------ */

/**
 * Thin Zendesk REST API client authenticated with the saved session cookies.
 * Handles cursor/offset pagination, 429 backoff, and turns auth failures into
 * NotLoggedInError so the MCP layer can prompt for re-login.
 */
export class ZendeskApi {
  private ticketFieldTitles: Map<number, string> | null = null;

  constructor(
    private readonly session: ZendeskSession,
    private readonly cfg: Config
  ) {}

  /* ---- low-level request ---- */

  /** Resolve a path/URL to an absolute API URL with query params applied. */
  private resolveUrl(subdomain: string, pathOrUrl: string, query?: Query): string {
    let url: string;
    if (/^https?:\/\//i.test(pathOrUrl)) {
      url = pathOrUrl;
    } else if (pathOrUrl.startsWith("/api/")) {
      url = `${baseUrl(subdomain)}${pathOrUrl}`;
    } else {
      const rel = pathOrUrl.replace(/^\/+/, "");
      url = `${apiBase(subdomain)}/${rel}`;
    }
    if (query) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      }
      url = u.toString();
    }
    return url;
  }

  /**
   * Perform an authenticated request, retrying on 429/503. GET requests need
   * only the session cookie; write requests (POST/PUT/DELETE) additionally
   * carry the CSRF token. If a write is rejected with an auth error we refresh
   * the token once and retry, to self-heal a stale token.
   */
  private async fetchRaw(
    pathOrUrl: string,
    opts: {
      method?: string;
      query?: Query;
      body?: unknown;
      accept?: string;
    } = {}
  ): Promise<Response> {
    const method = (opts.method ?? "GET").toUpperCase();
    const accept = opts.accept ?? "application/json";
    const isWrite = method !== "GET" && method !== "HEAD";
    const subdomain = requireSubdomain(this.cfg);
    const cookie = await this.session.cookieHeader(subdomain);
    const url = this.resolveUrl(subdomain, pathOrUrl, opts.query);

    let lastErr: unknown;
    let csrfRetried = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers: Record<string, string> = {
        Cookie: cookie,
        Accept: accept,
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
      };
      if (isWrite) {
        headers["X-CSRF-Token"] = await this.session.csrfToken(
          subdomain,
          csrfRetried
        );
        if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.cfg.apiTimeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: ac.signal,
        });
      } catch (err) {
        lastErr = err;
        clearTimeout(timer);
        // Network error / timeout — retry a couple of times with backoff.
        if (attempt < MAX_RETRIES) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new Error(
          `Request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        // A write may fail because the CSRF token went stale — refresh once.
        if (isWrite && !csrfRetried) {
          csrfRetried = true;
          continue;
        }
        throw new NotLoggedInError(`API returned ${res.status} for ${url}`);
      }
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Zendesk API ${res.status} ${res.statusText} for ${url}` +
            (text ? `: ${text.slice(0, 500)}` : "")
        );
      }
      return res;
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** GET a JSON resource. */
  async getJson<T = any>(pathOrUrl: string, query?: Query): Promise<T> {
    const res = await this.fetchRaw(pathOrUrl, { query });
    return (await res.json()) as T;
  }

  /** Send a write (POST/PUT/DELETE) and return the parsed JSON response. */
  private async sendJson<T = any>(
    method: "POST" | "PUT" | "DELETE",
    pathOrUrl: string,
    body?: unknown
  ): Promise<T> {
    const res = await this.fetchRaw(pathOrUrl, { method, body });
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * Page through a list endpoint, accumulating `itemKey` items plus any
   * sideloaded arrays named in `sideloadKeys`. Defaults to cursor pagination
   * (`page[size]`); pass `mode: "offset"` for endpoints that only support
   * offset pagination (e.g. /api/v2/search). Continuation follows
   * `meta.has_more`+`links.next` (cursor) or `next_page` (offset).
   */
  private async paginate(
    pathOrUrl: string,
    opts: {
      itemKey: string;
      query?: Query;
      limit?: number;
      sideloadKeys?: string[];
      mode?: "cursor" | "offset";
    }
  ): Promise<{ items: any[]; sideloads: Record<string, any[]> }> {
    const limit = opts.limit ?? Infinity;
    const sideloads: Record<string, any[]> = {};
    for (const k of opts.sideloadKeys ?? []) sideloads[k] = [];
    const items: any[] = [];

    const sizeParam =
      opts.mode === "offset"
        ? { per_page: PAGE_SIZE }
        : { "page[size]": PAGE_SIZE };
    let next: string | null = this.resolveUrl(
      requireSubdomain(this.cfg),
      pathOrUrl,
      { ...sizeParam, ...(opts.query ?? {}) }
    );

    while (next && items.length < limit) {
      const page: any = await this.getJson(next);
      const batch: any[] = page[opts.itemKey] ?? [];
      items.push(...batch);
      for (const k of opts.sideloadKeys ?? []) {
        if (Array.isArray(page[k])) sideloads[k].push(...page[k]);
      }
      // Cursor pagination signals continuation via meta.has_more + links.next;
      // offset pagination uses next_page. Support both.
      if (page.meta?.has_more && page.links?.next) next = page.links.next;
      else if (page.next_page) next = page.next_page;
      else next = null;
    }

    if (Number.isFinite(limit) && items.length > limit) items.length = limit;
    return { items, sideloads };
  }

  private agentTicketUrl(id: number): string {
    return `${baseUrl(requireSubdomain(this.cfg))}/agent/tickets/${id}`;
  }

  /* ---- ticket_fields title cache (for naming custom fields) ---- */

  private async fieldTitles(): Promise<Map<number, string>> {
    if (this.ticketFieldTitles) return this.ticketFieldTitles;
    const { items } = await this.paginate("/api/v2/ticket_fields.json", {
      itemKey: "ticket_fields",
    });
    const m = new Map<number, string>();
    for (const f of items) m.set(f.id, f.title ?? f.raw_title ?? null);
    this.ticketFieldTitles = m;
    return m;
  }

  /* ---- public operations ---- */

  /** The authenticated user — used to verify the session is still valid. */
  async me(): Promise<{ id: number; name: string; email: string; role: string }> {
    const { user } = await this.getJson<{ user: any }>("/api/v2/users/me.json");
    return { id: user.id, name: user.name, email: user.email, role: user.role };
  }

  /** List the agent's views (id, title, active) with cached ticket counts. */
  async listViews(): Promise<ViewSummary[]> {
    const { items } = await this.paginate("/api/v2/views.json", {
      itemKey: "views",
      query: { active: true },
    });
    const counts = await this.viewCounts(items.map((v) => v.id));
    return items.map((v) => ({
      id: v.id,
      title: v.title,
      active: v.active,
      count: counts.get(v.id) ?? null,
    }));
  }

  /** Cached ticket counts for a set of views (count_many is server-cached). */
  private async viewCounts(ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    // count_many allows at most 20 ids per request — chunk accordingly.
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const data = await this.getJson<{ view_counts: any[] }>(
        "/api/v2/views/count_many.json",
        { ids: chunk.join(",") }
      );
      for (const c of data.view_counts ?? []) {
        if (typeof c.value === "number") out.set(c.view_id, c.value);
      }
    }
    return out;
  }

  /** Fetch tickets in a view, following pagination up to `limit` tickets. */
  async fetchViewTickets(
    viewId: string | number,
    limit = 200
  ): Promise<{ viewId: number; count: number; tickets: TicketRow[] }> {
    const { items, sideloads } = await this.paginate(
      `/api/v2/views/${viewId}/tickets.json`,
      {
        itemKey: "tickets",
        query: { include: "users,groups" },
        sideloadKeys: ["users", "groups"],
        limit,
      }
    );
    const users = indexById(sideloads.users as any[]);
    const groups = indexById(sideloads.groups as any[]);
    const tickets = items.map((t) => this.toRow(t, users, groups));
    return { viewId: Number(viewId), count: tickets.length, tickets };
  }

  /** Zendesk search; returns mixed results preserving each `result_type`. */
  async search(query: string, limit = 200): Promise<SearchResult[]> {
    // /api/v2/search.json uses offset pagination (next_page); cap at `limit`.
    const { items } = await this.paginate("/api/v2/search.json", {
      itemKey: "results",
      query: { query },
      limit,
      mode: "offset",
    });
    return items.map((r) => ({
      result_type: r.result_type ?? null,
      id: typeof r.id === "number" ? r.id : null,
      url:
        r.result_type === "ticket" && typeof r.id === "number"
          ? this.agentTicketUrl(r.id)
          : (r.url ?? null),
      raw: r,
    }));
  }

  private toRow(
    t: any,
    users: Map<number, any>,
    groups: Map<number, any>
  ): TicketRow {
    return {
      id: t.id,
      url: this.agentTicketUrl(t.id),
      subject: t.subject ?? null,
      status: t.status ?? null,
      priority: t.priority ?? null,
      type: t.type ?? null,
      requester: userName(users, t.requester_id),
      assignee: userName(users, t.assignee_id),
      group: t.group_id != null ? (groups.get(t.group_id)?.name ?? null) : null,
      created_at: t.created_at ?? null,
      updated_at: t.updated_at ?? null,
      tags: Array.isArray(t.tags) ? t.tags : [],
    };
  }

  /** Full ticket detail: fields, parties, tags, and the full comment thread. */
  async getTicket(ticketId: string | number): Promise<TicketDetail> {
    const data = await this.getJson<{
      ticket: any;
      users?: any[];
      groups?: any[];
      organizations?: any[];
    }>(`/api/v2/tickets/${ticketId}.json`, {
      include: "users,groups,organizations",
    });
    const t = data.ticket;
    const users = indexById(data.users);
    const groups = indexById(data.groups);
    const organizations = indexById(data.organizations);

    // Comments (the conversation). Sideload users so we can name authors.
    const { items: comments, sideloads } = await this.paginate(
      `/api/v2/tickets/${ticketId}/comments.json`,
      { itemKey: "comments", query: { include: "users" }, sideloadKeys: ["users"] }
    );
    for (const u of sideloads.users ?? []) users.set(u.id, u);

    const titles = await this.fieldTitles();
    const custom_fields: CustomFieldValue[] = (t.custom_fields ?? [])
      .filter((f: any) => f.value !== null && f.value !== undefined && f.value !== "")
      .map((f: any) => ({
        id: f.id,
        title: titles.get(f.id) ?? null,
        value: f.value,
      }));
    const productField = custom_fields.find((f) => f.title && /product/i.test(f.title));

    const conversation: ConversationEvent[] = comments.map((c) =>
      this.toComment(c, users)
    );
    const attachments = conversation.flatMap((c) => c.attachments);

    return {
      id: t.id,
      url: this.agentTicketUrl(t.id),
      subject: t.subject ?? null,
      description: t.description ?? null,
      status: t.status ?? null,
      priority: t.priority ?? null,
      type: t.type ?? null,
      tags: Array.isArray(t.tags) ? t.tags : [],
      requester: userName(users, t.requester_id),
      assignee: userName(users, t.assignee_id),
      submitter: userName(users, t.submitter_id),
      group: t.group_id != null ? (groups.get(t.group_id)?.name ?? null) : null,
      organization:
        t.organization_id != null
          ? (organizations.get(t.organization_id)?.name ?? null)
          : null,
      created_at: t.created_at ?? null,
      updated_at: t.updated_at ?? null,
      custom_fields,
      product: productField ? String(productField.value) : null,
      conversation,
      attachments,
    };
  }

  private toComment(c: any, users: Map<number, any>): ConversationEvent {
    const attachments: CommentAttachment[] = (c.attachments ?? []).map((a: any) => ({
      id: a.id,
      file_name: a.file_name,
      content_url: a.content_url,
      content_type: a.content_type ?? null,
      size: typeof a.size === "number" ? a.size : null,
    }));
    return {
      id: c.id,
      author: userName(users, c.author_id),
      author_id: c.author_id ?? null,
      public: c.public !== false,
      created_at: c.created_at ?? null,
      body: (c.body ?? c.plain_body ?? "").trim(),
      html_body: c.html_body ?? null,
      attachments,
    };
  }

  /**
   * Download an attachment by its `content_url` using the session cookie,
   * writing it to `destination` (a file path, or a directory to save under the
   * original filename).
   */
  async downloadAttachment(
    contentUrl: string,
    destination: string
  ): Promise<{ savedTo: string; bytes: number; contentType: string | null }> {
    const res = await this.fetchRaw(contentUrl, { accept: "*/*" });
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type");
    const cd = res.headers.get("content-disposition") || "";
    const cdName = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    const fallbackName =
      (cdName ? decodeURIComponent(cdName) : null) || filenameFromUrl(contentUrl);
    const savedTo = resolveDestination(destination, fallbackName);
    await mkdir(path.dirname(savedTo), { recursive: true });
    await writeFile(savedTo, buf);
    return { savedTo, bytes: buf.length, contentType };
  }

  /* =============================== Tier 1 reads =========================== */

  /** Tickets requested by a user (their reported tickets), most recent first. */
  async requesterTickets(
    userId: string | number,
    limit = 100
  ): Promise<{ userId: number; count: number; tickets: TicketRow[] }> {
    const { items, sideloads } = await this.paginate(
      `/api/v2/users/${userId}/tickets/requested.json`,
      {
        itemKey: "tickets",
        query: { include: "users,groups", sort_order: "desc" },
        sideloadKeys: ["users", "groups"],
        limit,
      }
    );
    const users = indexById(sideloads.users as any[]);
    const groups = indexById(sideloads.groups as any[]);
    const tickets = items.map((t) => this.toRow(t, users, groups));
    return { userId: Number(userId), count: tickets.length, tickets };
  }

  /** Tickets belonging to an organization, most recent first. */
  async organizationTickets(
    orgId: string | number,
    limit = 100
  ): Promise<{ organizationId: number; count: number; tickets: TicketRow[] }> {
    const { items, sideloads } = await this.paginate(
      `/api/v2/organizations/${orgId}/tickets.json`,
      {
        itemKey: "tickets",
        query: { include: "users,groups" },
        sideloadKeys: ["users", "groups"],
        limit,
      }
    );
    const users = indexById(sideloads.users as any[]);
    const groups = indexById(sideloads.groups as any[]);
    const tickets = items.map((t) => this.toRow(t, users, groups));
    return { organizationId: Number(orgId), count: tickets.length, tickets };
  }

  /**
   * Catalog of ticket fields with their valid dropdown/tagger option values —
   * use this to learn the exact `value` to pass when setting a custom field.
   */
  async ticketFields(activeOnly = true): Promise<TicketFieldDef[]> {
    const { items } = await this.paginate("/api/v2/ticket_fields.json", {
      itemKey: "ticket_fields",
    });
    return items
      .filter((f) => !activeOnly || f.active)
      .map((f) => ({
        id: f.id,
        title: f.title ?? f.raw_title ?? null,
        type: f.type,
        active: !!f.active,
        required: !!f.required,
        options: (f.custom_field_options ?? []).map((o: any) => ({
          name: o.name,
          value: o.value,
        })),
      }));
  }

  /* =============================== Tier 2 reads =========================== */

  /** SLA / timing metrics for one ticket (reply, resolution, reopens, etc.). */
  async ticketMetrics(ticketId: string | number): Promise<Record<string, unknown>> {
    const data = await this.getJson<{ ticket_metric: any }>(
      `/api/v2/tickets/${ticketId}/metrics.json`
    );
    return data.ticket_metric;
  }

  /** List active macros (canned actions) by id and title. */
  async listMacros(limit = 500): Promise<MacroSummary[]> {
    const { items } = await this.paginate("/api/v2/macros/active.json", {
      itemKey: "macros",
      limit,
    });
    return items.map((m) => ({
      id: m.id,
      title: m.title,
      active: !!m.active,
      description: m.description ?? null,
    }));
  }

  /** Look up users by a free-text query (name, email, etc.). */
  async searchUsers(query: string, limit = 50): Promise<UserSummary[]> {
    const { items } = await this.paginate("/api/v2/users/search.json", {
      itemKey: "users",
      query: { query },
      limit,
      mode: "offset",
    });
    return items.map((u) => this.toUser(u));
  }

  /** Fetch one user by id. */
  async getUser(userId: string | number): Promise<UserSummary> {
    const { user } = await this.getJson<{ user: any }>(
      `/api/v2/users/${userId}.json`
    );
    return this.toUser(user);
  }

  private toUser(u: any): UserSummary {
    return {
      id: u.id,
      name: u.name ?? null,
      email: u.email ?? null,
      role: u.role ?? null,
      organization_id: u.organization_id ?? null,
      active: !!u.active,
      created_at: u.created_at ?? null,
    };
  }

  /** Full audit trail (every change/event) for a ticket. */
  async ticketAudits(
    ticketId: string | number,
    limit = 100
  ): Promise<AuditEvent[]> {
    const { items, sideloads } = await this.paginate(
      `/api/v2/tickets/${ticketId}/audits.json`,
      { itemKey: "audits", sideloadKeys: ["users"], limit }
    );
    const users = indexById(sideloads.users as any[]);
    return items.map((a) => ({
      id: a.id,
      created_at: a.created_at ?? null,
      author_id: a.author_id ?? null,
      author: userName(users, a.author_id),
      events: a.events ?? [],
    }));
  }

  /* ================================= writes ============================== */

  /** Add a comment to a ticket. `isPublic=false` makes it an internal note. */
  async addComment(
    ticketId: string | number,
    body: string,
    isPublic = true,
    htmlBody?: string
  ): Promise<TicketDetail> {
    const comment: Record<string, unknown> = { public: isPublic };
    if (htmlBody) comment.html_body = htmlBody;
    else comment.body = body;
    await this.sendJson("PUT", `/api/v2/tickets/${ticketId}.json`, {
      ticket: { comment },
    });
    return this.getTicket(ticketId);
  }

  /** Update fields on a ticket (status, assignee, tags, custom fields, …). */
  async updateTicket(
    ticketId: string | number,
    update: TicketUpdate
  ): Promise<TicketDetail> {
    await this.sendJson("PUT", `/api/v2/tickets/${ticketId}.json`, {
      ticket: update,
    });
    return this.getTicket(ticketId);
  }

  /**
   * Apply a macro to a ticket and persist the result. Zendesk's macro-apply
   * endpoint only previews the changes; we then PUT them so the ticket is
   * actually updated. Returns the updated ticket.
   */
  async applyMacro(
    ticketId: string | number,
    macroId: string | number
  ): Promise<{ applied: Record<string, unknown>; ticket: TicketDetail }> {
    const preview = await this.getJson<{ result: any }>(
      `/api/v2/tickets/${ticketId}/macros/${macroId}/apply.json`
    );
    const full = preview.result?.ticket ?? {};
    // The preview returns the entire post-macro ticket (incl. read-only fields).
    // Only re-send the fields a macro can actually change.
    const MUTABLE = [
      "subject", "priority", "type", "status", "custom_status_id",
      "assignee_id", "group_id", "tags", "custom_fields", "comment",
      "collaborator_ids", "follower_ids",
    ];
    const applied: Record<string, unknown> = {};
    for (const k of MUTABLE) if (k in full) applied[k] = full[k];
    await this.sendJson("PUT", `/api/v2/tickets/${ticketId}.json`, {
      ticket: applied,
    });
    return { applied, ticket: await this.getTicket(ticketId) };
  }

  /** Generic read-only passthrough to any /api/v2 endpoint. */
  async request(pathOrUrl: string, query?: Query): Promise<unknown> {
    return this.getJson(pathOrUrl, query);
  }
}
