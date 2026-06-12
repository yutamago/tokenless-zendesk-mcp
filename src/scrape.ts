import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { SELECTORS } from "./selectors.js";
import { ZendeskSession } from "./session.js";

/** Parse the `name=` filename from a Zendesk attachment URL. */
function filenameFromUrl(url: string): string | null {
  const m = url.match(/[?&]name=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Resolve a download target. If `destination` is an existing directory (or ends
 * with a path separator), append the attachment's own filename; otherwise use it
 * as the literal file path.
 */
function resolveDestination(
  destination: string,
  attachmentUrl: string,
  _contentType: string | null
): string {
  const endsWithSep = /[\\/]$/.test(destination);
  let isDir = endsWithSep;
  if (!isDir) {
    try {
      isDir = fs.statSync(destination).isDirectory();
    } catch {
      isDir = false;
    }
  }
  if (isDir) {
    const name = filenameFromUrl(attachmentUrl) || "attachment";
    return path.join(destination, name);
  }
  return destination;
}

export interface ViewSummary {
  id: string;
  title: string;
  count: string | null;
  url: string;
}

export interface TicketRow {
  id: string;
  url: string | null;
  subject: string | null;
  status: string | null;
  assignee: string | null;
  requester: string | null;
  requested: string | null;
  customFields: Record<string, string>; // keyed by Zendesk custom field id
}

export interface ConversationEvent {
  kind: "comment" | "event";
  author: string | null;
  timestamp: string | null;
  visibility: "internal" | "public" | null;
  body: string;
}

export interface Attachment {
  /** Zendesk attachment token — the stable identifier from the URL. */
  token: string;
  filename: string;
  /** Full, authenticated-session URL. Pass this to zendesk_download_attachment. */
  url: string;
  source: "image" | "link" | "text";
}

export interface TicketDetail {
  id: string;
  url: string;
  subject: string | null;
  assignee: string | null;
  tags: string[];
  fields: Record<string, string>; // labelled sidebar fields incl. "stp.one - Productname"
  product: string | null; // convenience: the product field value if found
  conversation: ConversationEvent[];
  attachments: Attachment[];
}

async function waitForAny(page: Page, selector: string, timeout = 20000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout, state: "attached" });
    return true;
  } catch {
    return false;
  }
}

export class ZendeskScraper {
  constructor(private readonly session: ZendeskSession) {}

  /** List the agent's available views (id, title, count). */
  async listViews(): Promise<ViewSummary[]> {
    return this.session.withPage(async (page, subdomain) => {
      await this.session.gotoAgent(page, subdomain, "/agent/filters/");
      await waitForAny(page, SELECTORS.viewLink, 25000);
      await page.waitForTimeout(1500);

      const sel = {
        link: SELECTORS.viewLink,
        countSel: SELECTORS.viewNavItemCount,
      };
      const views = await page.$$eval(
        sel.link,
        (els, s) =>
          els.map((el) => {
            const a = el as HTMLAnchorElement;
            const item = a.closest('[data-test-id^="views_views-list_item-view-"]') || a;
            const countEl = item.querySelector(s.countSel);
            const count = countEl ? (countEl.textContent || "").trim() : null;
            let title = (a.textContent || "").trim();
            // The anchor text includes the trailing count; strip it if present.
            if (count && title.endsWith(count)) {
              title = title.slice(0, title.length - count.length).trim();
            }
            return { href: a.href, title, count };
          }),
        sel
      );

      const seen = new Map<string, ViewSummary>();
      for (const v of views) {
        const id = v.href.match(/\/agent\/filters\/(\d+)/)?.[1];
        if (!id) continue; // skip non-numeric pseudo-views
        if (!seen.has(id)) {
          seen.set(id, {
            id,
            title: v.title || `View ${id}`,
            count: v.count,
            url: v.href,
          });
        }
      }
      return [...seen.values()];
    });
  }

  /** Fetch all ticket rows for a view, following pagination. */
  async fetchViewTickets(
    viewId: string,
    maxPages = 20
  ): Promise<{ viewId: string; pages: number; tickets: TicketRow[] }> {
    return this.session.withPage(async (page, subdomain) => {
      await this.session.gotoAgent(page, subdomain, `/agent/filters/${viewId}`);
      await waitForAny(page, SELECTORS.ticketRow, 25000);

      const all = new Map<string, TicketRow>();
      let pages = 0;

      while (pages < maxPages) {
        pages++;
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(600);
        for (const r of await this.extractTicketRows(page)) all.set(r.id, r);

        const next = await page.$(SELECTORS.paginationNext);
        if (!next) break;
        const usable = await next
          .evaluate(
            (el) =>
              !(el as HTMLButtonElement).disabled &&
              el.getAttribute("aria-disabled") !== "true"
          )
          .catch(() => false);
        if (!usable) break;

        const firstIdBefore = await page
          .$eval(SELECTORS.ticketRow, (r) => r.getAttribute("aria-describedby"))
          .catch(() => null);
        await next.click().catch(() => {});
        // Wait for the first row to change (page turned).
        await page
          .waitForFunction(
            ([sel, prev]) =>
              document.querySelector(sel)?.getAttribute("aria-describedby") !== prev,
            [SELECTORS.ticketRow, firstIdBefore] as const,
            { timeout: 8000 }
          )
          .catch(() => {});
      }

      return { viewId, pages, tickets: [...all.values()] };
    });
  }

  private async extractTicketRows(page: Page): Promise<TicketRow[]> {
    return page.$$eval(
      SELECTORS.ticketRow,
      (rows, s) =>
        rows
          .map((row) => {
            // ID: from aria-describedby="generic-table-row-{id}", fallback to id cell "#123".
            const describedBy = row.getAttribute("aria-describedby") || "";
            let id = describedBy.match(/generic-table-row-(\d+)/)?.[1] || null;
            const idCell = row.querySelector(s.cellId)?.textContent?.trim() || "";
            if (!id) id = idCell.replace(/[^\d]/g, "") || null;
            if (!id) return null;

            const subjectAnchor = row.querySelector<HTMLAnchorElement>(
              `${s.cellSubject} a`
            );
            const subject =
              subjectAnchor?.textContent?.trim() ||
              row.querySelector(s.cellSubject)?.textContent?.trim() ||
              null;
            const url = subjectAnchor?.href || null;

            const statusEl =
              row.querySelector(s.cellStatusBadge) || row.querySelector(s.cellStatus);
            const status = statusEl?.textContent?.trim() || null;

            const assignee =
              row.querySelector(s.cellAssignee)?.textContent?.trim() || null;
            const requester =
              row.querySelector(s.cellRequester)?.textContent?.trim() || null;
            const requested =
              row.querySelector(s.cellDate)?.textContent?.trim() || null;

            const customFields: Record<string, string> = {};
            row
              .querySelectorAll(`[data-test-id^="${s.cellCustomFieldPrefix}"]`)
              .forEach((c) => {
                const fid = (c.getAttribute("data-test-id") || "").slice(
                  s.cellCustomFieldPrefix.length
                );
                const val = (c.textContent || "").trim();
                if (fid && val) customFields[fid] = val;
              });

            return { id, url, subject, status, assignee, requester, requested, customFields };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null),
      {
        cellId: SELECTORS.cellId,
        cellSubject: SELECTORS.cellSubject,
        cellStatus: SELECTORS.cellStatus,
        cellStatusBadge: SELECTORS.cellStatusBadge,
        cellAssignee: SELECTORS.cellAssignee,
        cellRequester: SELECTORS.cellRequester,
        cellDate: SELECTORS.cellDate,
        cellCustomFieldPrefix: SELECTORS.cellCustomFieldPrefix,
      }
    );
  }

  /** Search via the agent search UI: /agent/search/?q=... */
  async search(query: string): Promise<TicketRow[]> {
    return this.session.withPage(async (page, subdomain) => {
      const url = `/agent/search/?q=${encodeURIComponent(query)}`;
      await this.session.gotoAgent(page, subdomain, url);
      await page.waitForLoadState("networkidle").catch(() => {});
      await waitForAny(page, SELECTORS.ticketRow, 25000);
      await page.waitForTimeout(800);
      return this.extractTicketRows(page);
    });
  }

  /** Full ticket detail: subject, assignee, tags, sidebar fields, conversation. */
  async getTicket(ticketId: string): Promise<TicketDetail> {
    return this.session.withPage(async (page, subdomain) => {
      await this.session.gotoAgent(page, subdomain, `/agent/tickets/${ticketId}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await waitForAny(page, SELECTORS.conversationItem, 25000);
      await page.waitForTimeout(1500);

      const subject = await this.readSubject(page);
      const assignee = await this.readAssignee(page);
      const tags = await this.readTags(page);
      const fields = await this.readSidebarFields(page);
      const conversation = await this.readConversation(page);
      const attachments = await this.readAttachments(page);

      const productKey = Object.keys(fields).find((k) => /product/i.test(k));
      const product = productKey ? fields[productKey] : null;

      return {
        id: ticketId,
        url: page.url(),
        subject,
        assignee,
        tags,
        fields,
        product,
        conversation,
        attachments,
      };
    });
  }

  /**
   * Collect attachments referenced anywhere in the ticket conversation. Zendesk
   * serves them as /attachments/token/{token}/?name={filename}, whether rendered
   * as an <img>, an <a> link, or inline markdown text — we scan all three and
   * dedupe by token+filename.
   */
  private async readAttachments(page: Page): Promise<Attachment[]> {
    return page.evaluate(() => {
      const re = /\/attachments\/token\/([^/]+)\/\?name=([^"')\s>]+)/g;
      const byKey = new Map<string, { token: string; filename: string; url: string; source: "image" | "link" | "text" }>();
      const origin = location.origin;

      const add = (rawUrl: string, source: "image" | "link" | "text") => {
        const m = rawUrl.match(/\/attachments\/token\/([^/?]+)\/\?name=([^"')\s>&]+)/);
        if (!m) return;
        const token = m[1];
        let filename = m[2];
        try { filename = decodeURIComponent(filename); } catch { /* keep raw */ }
        const abs = rawUrl.startsWith("http") ? rawUrl : origin + rawUrl;
        const key = `${token}|${filename}`;
        if (!byKey.has(key)) byKey.set(key, { token, filename, url: abs, source });
      };

      document.querySelectorAll<HTMLImageElement>('img[src*="/attachments/token/"]')
        .forEach((el) => add(el.getAttribute("src") || el.src, "image"));
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/attachments/token/"]')
        .forEach((el) => add(el.getAttribute("href") || el.href, "link"));

      // Inline markdown text (e.g. "![](https://.../attachments/token/.../?name=image.png)").
      const container =
        document.querySelector('[data-test-id="omni-log-container"]') || document.body;
      const html = container.innerHTML;
      let t: RegExpExecArray | null;
      while ((t = re.exec(html)) !== null) add(t[0], "text");

      return [...byKey.values()];
    });
  }

  /**
   * Download an attachment (by its full URL) using the authenticated browser
   * session, writing it to `destination`. If `destination` is a directory, the
   * attachment's own filename is appended. Returns the saved path and byte count.
   */
  async downloadAttachment(
    attachmentUrl: string,
    destination: string
  ): Promise<{ savedTo: string; bytes: number; contentType: string | null }> {
    return this.session.withPage(async (page) => {
      const resp = await page.request.get(attachmentUrl);
      if (!resp.ok()) {
        throw new Error(
          `Download failed: HTTP ${resp.status()} ${resp.statusText()} for ${attachmentUrl}`
        );
      }
      const body = await resp.body();
      const contentType = resp.headers()["content-type"] || null;
      const savedTo = resolveDestination(destination, attachmentUrl, contentType);
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(savedTo), { recursive: true });
      await writeFile(savedTo, body);
      return { savedTo, bytes: body.length, contentType };
    });
  }

  /** Subject is rendered as an <input>; read its value. */
  private async readSubject(page: Page): Promise<string | null> {
    const el = await page.$(SELECTORS.ticketSubject);
    if (!el) return (await page.title())?.trim() || null;
    const v = await el.evaluate(
      (e) => (e as HTMLInputElement).value || e.textContent || ""
    );
    return v.replace(/\s+/g, " ").trim() || null;
  }

  /** Assignee value = "Agent / Group", reading only the selected tags. */
  private async readAssignee(page: Page): Promise<string | null> {
    return page.evaluate((s) => {
      const txt = (sel: string) =>
        document.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() || "";
      const agent = txt(s.agent);
      const group = txt(s.group);
      const combined = [agent, group].filter(Boolean).join(" / ");
      return combined || null;
    }, { agent: SELECTORS.assigneeAgentTag, group: SELECTORS.assigneeGroupTag });
  }

  private async readTags(page: Page): Promise<string[]> {
    return page.$$eval(SELECTORS.tagItem, (els) =>
      els.map((e) => (e.textContent || "").trim()).filter(Boolean)
    );
  }

  /** Read labelled sidebar custom fields (incl. "stp.one - Productname"). */
  private async readSidebarFields(page: Page): Promise<Record<string, string>> {
    return page.evaluate(
      (s) => {
        const out: Record<string, string> = {};
        const containers = document.querySelectorAll<HTMLElement>(s.customFieldContainer);
        for (const c of Array.from(containers)) {
          // Label: direct text of the <label>, excluding nested buttons/icons.
          const labelEl = c.querySelector("label");
          let label = "";
          if (labelEl) {
            label = Array.from(labelEl.childNodes)
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent || "")
              .join(" ")
              .replace(/\*/g, "")
              .replace(/\s+/g, " ")
              .trim();
          }
          if (!label) continue;

          // Value: dropdown faux-input, else input/textarea/select, else checkbox state.
          let value = "";
          const dropdown = c.querySelector(s.dropdownButton);
          if (dropdown) value = (dropdown.textContent || "").trim();
          if (!value) {
            const field = c.querySelector<HTMLInputElement>("input, textarea, select");
            if (field) {
              if (field.type === "checkbox") value = field.checked ? "true" : "false";
              else value = field.value || "";
            }
          }
          value = value.replace(/\s+/g, " ").trim();
          if (label && value) out[label] = value;
        }
        return out;
      },
      {
        customFieldContainer: SELECTORS.customFieldContainer,
        dropdownButton: SELECTORS.dropdownButton,
      }
    );
  }

  /** Read the omni-log: comments (message history) + interaction-history events. */
  private async readConversation(page: Page): Promise<ConversationEvent[]> {
    return page.$$eval(
      SELECTORS.conversationItem,
      (items, s) =>
        items
          .map((ev) => {
            const isComment =
              ev.getAttribute("data-test-id") === "omni-log-comment-item";
            const ariaLabel = ev.getAttribute("aria-label") || "";

            const author =
              ev.querySelector(s.convSender)?.textContent?.trim() ||
              // aria-label often reads "Internal note from {Author}, {time}"
              ariaLabel.match(/from\s+(.+?),/)?.[1]?.trim() ||
              null;

            const timestamp =
              ev.querySelector("time")?.getAttribute("datetime") ||
              ev.querySelector("time")?.textContent?.trim() ||
              ev.querySelector(s.eventTitle)?.textContent?.trim() ||
              ariaLabel.split(",").slice(1).join(",").trim() ||
              null;

            const internalTag = ev.querySelector(s.convInternalTag);
            const visibility: "internal" | "public" | null = isComment
              ? internalTag
                ? "internal"
                : "public"
              : null;

            const bodyEl = ev.querySelector(s.convBody);
            const body = ((bodyEl || ev).textContent || "")
              .replace(/\s+/g, " ")
              .trim();

            return {
              kind: isComment ? ("comment" as const) : ("event" as const),
              author,
              timestamp,
              visibility,
              body,
            };
          })
          .filter((e) => e.body.length > 0),
      {
        convSender: SELECTORS.convSender,
        convBody: SELECTORS.convBody,
        convInternalTag: SELECTORS.convInternalTag,
        eventTitle: SELECTORS.eventTitle,
      }
    );
  }

  /** Diagnostic helper: dump trimmed HTML + a screenshot for selector tuning. */
  async inspect(
    pathOrUrl: string
  ): Promise<{ url: string; html: string; screenshotBase64: string }> {
    return this.session.withPage(async (page, subdomain) => {
      await this.session.gotoAgent(page, subdomain, pathOrUrl);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(2000);
      const html = await page.content();
      const shot = await page.screenshot({ fullPage: false });
      return {
        url: page.url(),
        html:
          html.length > 200_000 ? html.slice(0, 200_000) + "\n<!-- truncated -->" : html,
        screenshotBase64: shot.toString("base64"),
      };
    });
  }
}
