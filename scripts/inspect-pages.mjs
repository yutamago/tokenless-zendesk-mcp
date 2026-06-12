// Scratch introspection tool for tuning selectors against the live stpone instance.
// Run: ZENDESK_SUBDOMAIN=stpone node scripts/inspect-pages.mjs
import fs from "node:fs";
import { loadConfig } from "../dist/config.js";
import { ZendeskSession } from "../dist/session.js";
import { ZendeskScraper } from "../dist/scrape.js";

const cfg = loadConfig();
const session = new ZendeskSession(cfg);
const scraper = new ZendeskScraper(session);
const OUT = "/tmp/zd-dump";
fs.mkdirSync(OUT, { recursive: true });

function pre(label, v) {
  console.log(`\n===== ${label} =====`);
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

// Dump structural hints from a page without printing the whole DOM.
async function structure(page, label) {
  const info = await page.evaluate(() => {
    const testIds = [...new Set([...document.querySelectorAll("[data-test-id]")].map(e => e.getAttribute("data-test-id")))];
    const tables = [...document.querySelectorAll("table")].map(t => ({
      garden: t.getAttribute("data-garden-id"),
      role: t.getAttribute("role"),
      rows: t.querySelectorAll("tbody tr, tr[data-row-id]").length,
      headerCells: [...t.querySelectorAll("thead th")].map(th => (th.textContent||"").trim()).filter(Boolean),
    }));
    const ticketLinks = [...document.querySelectorAll('a[href*="/agent/tickets/"]')].length;
    const viewLinks = [...document.querySelectorAll('a[href*="/agent/filters/"]')].map(a => ({
      href: a.getAttribute("href"), text: (a.textContent||"").trim().slice(0,40)
    })).slice(0, 40);
    return { testIds, tables, ticketLinks, viewLinks };
  });
  pre(`STRUCTURE: ${label}  (testIds: ${info.testIds.length})`, info);
  return info;
}

await session.withPage(async (page, subdomain) => {
  // 1) VIEWS
  await session.gotoAgent(page, subdomain, "/agent/filters/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2500);
  const vinfo = await structure(page, "/agent/filters/");
  fs.writeFileSync(`${OUT}/views.html`, await page.content());

  // Pick first numeric view id from discovered links
  const viewId = (vinfo.viewLinks.map(v => v.href.match(/\/agent\/filters\/(\d+)/)?.[1]).find(Boolean)) || null;
  pre("CHOSEN viewId", viewId);

  let ticketId = null;
  if (viewId) {
    // 2) VIEW TICKETS
    await session.gotoAgent(page, subdomain, `/agent/filters/${viewId}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(3000);
    const tinfo = await structure(page, `/agent/filters/${viewId}`);
    fs.writeFileSync(`${OUT}/view-tickets.html`, await page.content());
    // sample first ticket row outerHTML
    const rowHtml = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/agent/tickets/"]');
      const row = link?.closest("tr");
      return row ? row.outerHTML.slice(0, 4000) : null;
    });
    pre("FIRST TICKET ROW outerHTML", rowHtml);
    ticketId = await page.evaluate(() => document.querySelector('a[href*="/agent/tickets/"]')?.href.match(/tickets\/(\d+)/)?.[1] || null);
  }
  pre("CHOSEN ticketId", ticketId);

  // 3) TICKET DETAIL
  if (ticketId) {
    await session.gotoAgent(page, subdomain, `/agent/tickets/${ticketId}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(4000);
    await structure(page, `/agent/tickets/${ticketId}`);
    fs.writeFileSync(`${OUT}/ticket.html`, await page.content());
    // candidate conversation containers
    const convo = await page.evaluate(() => {
      const cands = ["[data-test-id='omni-log-item']","[data-test-id='convolog-event']","[data-comment-id]","article","[data-test-id*='log']","[data-test-id*='comment']","[data-test-id*='event']"];
      return cands.map(sel => ({ sel, count: document.querySelectorAll(sel).length }));
    });
    pre("CONVERSATION candidate selectors", convo);
    // candidate field/sidebar test-ids
    const fieldIds = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll("[data-test-id]")].map(e=>e.getAttribute("data-test-id")))]
        .filter(id => /field|tag|assign|subject|product|custom/i.test(id||""))
    );
    pre("FIELD-ish test-ids", fieldIds);
  }

  // 4) SEARCH
  await session.gotoAgent(page, subdomain, `/agent/search/?q=${encodeURIComponent("status:open")}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);
  await structure(page, "/agent/search/?q=status:open");
  fs.writeFileSync(`${OUT}/search.html`, await page.content());

  // 5) NOTIFICATIONS
  await session.gotoAgent(page, subdomain, "/agent/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2500);
  const notifIds = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll("[data-test-id]")].map(e=>e.getAttribute("data-test-id")))]
      .filter(id => /notif|bell|inbox/i.test(id||""))
  );
  pre("NOTIFICATION-ish test-ids", notifIds);
  fs.writeFileSync(`${OUT}/agent-home.html`, await page.content());
});

await session.close();
console.log("\nHTML dumps written to", OUT);
process.exit(0);
