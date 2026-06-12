// End-to-end verification against the live instance.
// Run: ZENDESK_SUBDOMAIN=stpone node scripts/verify.mjs
import { loadConfig } from "../dist/config.js";
import { ZendeskSession } from "../dist/session.js";
import { ZendeskScraper } from "../dist/scrape.js";

const session = new ZendeskSession(loadConfig());
const z = new ZendeskScraper(session);
const show = (label, v) => console.log(`\n##### ${label} #####\n` + JSON.stringify(v, null, 2));

try {
  const views = await z.listViews();
  show("listViews", views);

  const results = await z.search("status:open");
  show(`search('status:open') -> ${results.length} rows; first 3`, results.slice(0, 3));

  const id = results[0]?.id;
  if (id) {
    const t = await z.getTicket(id);
    show(`getTicket(${id})`, {
      id: t.id,
      subject: t.subject,
      assignee: t.assignee,
      product: t.product,
      tags: t.tags,
      fieldKeys: Object.keys(t.fields),
      fields: t.fields,
      conversationCount: t.conversation.length,
      firstComments: t.conversation.filter((c) => c.kind === "comment").slice(0, 2),
      firstEvents: t.conversation.filter((c) => c.kind === "event").slice(0, 2),
    });
  }

} finally {
  await session.close();
}
process.exit(0);
