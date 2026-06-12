// End-to-end verification against the live instance, using the saved session
// cookies to call the Zendesk REST API.
// Run (after `npm run build` and `npm run login`):
//   ZENDESK_SUBDOMAIN=youracme node scripts/verify.mjs
import { loadConfig } from "../dist/config.js";
import { ZendeskSession } from "../dist/session.js";
import { ZendeskApi } from "../dist/api.js";

const session = new ZendeskSession(loadConfig());
const api = new ZendeskApi(session, loadConfig());
const show = (label, v) => console.log(`\n##### ${label} #####\n` + JSON.stringify(v, null, 2));

const me = await api.me();
show("me", me);

const views = await api.listViews();
show(`listViews -> ${views.length}; first 3`, views.slice(0, 3));

const results = await api.search("type:ticket status:open", 5);
show(`search('type:ticket status:open') -> ${results.length}; first 2`, results.slice(0, 2));

const id = results.find((r) => r.result_type === "ticket")?.id;
if (id) {
  const t = await api.getTicket(id);
  show(`getTicket(${id})`, {
    id: t.id,
    subject: t.subject,
    status: t.status,
    assignee: t.assignee,
    requester: t.requester,
    organization: t.organization,
    product: t.product,
    tags: t.tags,
    customFieldCount: t.custom_fields.length,
    conversationCount: t.conversation.length,
    attachmentCount: t.attachments.length,
    firstComment: t.conversation[0],
  });
}

process.exit(0);
