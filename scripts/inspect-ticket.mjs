// Dump one ticket detail page for selector tuning.
// Run: ZENDESK_SUBDOMAIN=stpone node scripts/inspect-ticket.mjs <ticketId>
import fs from "node:fs";
import { loadConfig } from "../dist/config.js";
import { ZendeskSession } from "../dist/session.js";

const ticketId = process.argv[2] || "179537";
const session = new ZendeskSession(loadConfig());

await session.withPage(async (page, subdomain) => {
  await session.gotoAgent(page, subdomain, `/agent/tickets/${ticketId}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(6000); // ticket SPA is heavy
  fs.writeFileSync("/tmp/zd-dump/ticket.html", await page.content());

  const info = await page.evaluate(() => {
    const ids = [...new Set([...document.querySelectorAll("[data-test-id]")].map(e => e.getAttribute("data-test-id")))];
    const pick = (re) => ids.filter(id => re.test(id || ""));
    // candidate conversation containers
    const convoCands = [
      "[data-comment-id]","[data-test-id='omni-log-item']","[data-test-id='convolog-event']",
      "[data-test-id*='comment']","[data-test-id*='event']","[data-test-id*='log']",
      "[data-test-id*='conversation']","article",
    ].map(sel => ({ sel, count: document.querySelectorAll(sel).length }));
    return {
      total: ids.length,
      subjectish: pick(/subject/i),
      assigneeish: pick(/assign/i),
      tagsish: pick(/tag/i),
      fieldish: pick(/field|product|custom/i),
      convoish: pick(/comment|event|log|conversation|message|reply|public|internal/i),
      convoCands,
    };
  });
  console.log(JSON.stringify(info, null, 2));
});
await session.close();
process.exit(0);
