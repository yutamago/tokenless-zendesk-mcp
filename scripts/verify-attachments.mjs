// Verify attachment listing + download against a live ticket.
// Run: ZENDESK_SUBDOMAIN=stpone node scripts/verify-attachments.mjs [ticketId]
import { loadConfig } from "../dist/config.js";
import { ZendeskSession } from "../dist/session.js";
import { ZendeskScraper } from "../dist/scrape.js";

const ticketId = process.argv[2] || "179537";
const session = new ZendeskSession(loadConfig());
const z = new ZendeskScraper(session);

try {
  const t = await z.getTicket(ticketId);
  console.log(`\n## attachments for #${ticketId}: ${t.attachments.length}`);
  console.log(JSON.stringify(t.attachments.slice(0, 8), null, 2));

  if (t.attachments[0]) {
    const a = t.attachments[0];
    const res = await z.downloadAttachment(a.url, "/tmp/zd-downloads/");
    console.log("\n## download result:", JSON.stringify(res, null, 2));
  } else {
    console.log("\n(no attachments to download)");
  }
} finally {
  await session.close();
}
process.exit(0);
