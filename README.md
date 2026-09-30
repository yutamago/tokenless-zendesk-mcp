# Tokenless Zendesk MCP Server

An MCP server for Zendesk. You sign in **once** in a real browser (Playwright) —
any method works, including SSO and 2FA — and the resulting **session cookies are
then used to call the Zendesk REST API** directly. No API token, OAuth client, or
admin setup required: it acts with exactly your agent account's permissions.

This is the same way Zendesk's own agent web UI talks to its API — a valid session
cookie is all a `GET` request needs (no CSRF token is required for reads).

## What it can do

**Reads**

| Tool | Description |
|---|---|
| `zendesk_login` | Open a **visible** browser to sign in (password / SSO / 2FA). Saves the session cookies + CSRF token. |
| `zendesk_session_status` | Check whether a saved session exists and is still valid (calls the API as the current user). |
| `zendesk_list_views` | List the agent's active views with numeric IDs, titles, and cached ticket counts. |
| `zendesk_fetch_view_tickets` | Fetch tickets in a view, following pagination (`limit` caps the count). |
| `zendesk_search` | Search via `/api/v2/search` — any Zendesk query string; returns results tagged by type. |
| `zendesk_get_ticket` | Subject, status, parties, tags, custom fields (incl. product), full comment thread, and attachments. |
| `zendesk_download_attachment` | Download an attachment (by its `content_url` from `get_ticket`) to a path or directory. |
| `zendesk_requester_tickets` | List the tickets a user has requested (their history) — "have they reported this before?". |
| `zendesk_organization_tickets` | List tickets belonging to an organization. |
| `zendesk_ticket_fields` | Field definitions **with valid dropdown/tagger option values** — look up the `value` to set a custom field. |
| `zendesk_ticket_metrics` | SLA / timing metrics for a ticket (reply time, resolution time, reopens, replies). |
| `zendesk_list_macros` | List active macros with ids and titles (for `zendesk_apply_macro`). |
| `zendesk_search_users` | Find users by free-text (name, email, …). |
| `zendesk_get_user` | Fetch one user by id. |
| `zendesk_ticket_audits` | Full audit trail (every change/event) for a ticket. |
| `zendesk_request` | Read-only passthrough to **any** `/api/v2` endpoint — for anything the dedicated tools don't cover. |

**Writes** (require the CSRF token — see [Writes](#writes-csrf) below)

| Tool | Description |
|---|---|
| `zendesk_add_comment` | Add a public reply or internal note to a ticket. |
| `zendesk_update_ticket` | Set status, priority, type, assignee, group, tags, and custom fields (optionally with a comment). |
| `zendesk_apply_macro` | Apply a macro and persist its changes (status/fields/comment) to a ticket. |

**Attachments.** `zendesk_get_ticket` returns an `attachments` array; each item has
an `id`, `file_name`, `content_url`, `content_type`, and `size`. Pass an attachment's
`content_url` to `zendesk_download_attachment` along with a `destination` (a file
path, or a directory to save under the original filename). Downloads use the
authenticated session, so private attachments work.

**`zendesk_request`** unlocks the rest of the [Zendesk REST
API](https://developer.zendesk.com/api-reference/) for reads — e.g.
`tickets/123/audits`, `ticket_metrics`, `organizations`, `users/123`,
`satisfaction_ratings`. It is GET-only by design (write operations would require a
CSRF token, which is out of scope).

## How auth works

You sign in **once** in a real browser window. Playwright saves the resulting
cookies to `~/.zendesk-mcp/storageState.json`. Every other tool reads the cookies
scoped to your instance and replays them as a `Cookie` header against
`https://{subdomain}.zendesk.com/api/v2/…`. When the session expires the API
returns 401/403 and the tool returns a clear "run `zendesk_login`" message.

> The session file holds live auth cookies — it's git-ignored. Treat it like a password.

### Writes (CSRF)

`GET` requests authenticate with the session cookie alone. Write requests
(`POST`/`PUT`/`DELETE`) additionally require Zendesk's **CSRF token** — the same
one the agent UI uses. It's captured at login (from the agent page's
`<meta name="csrf-token">`) and saved to `~/.zendesk-mcp/csrf.txt`. The token is
stable for the life of the session; if it ever goes stale, the server fetches a
fresh one automatically and retries the write once. The write tools
(`zendesk_add_comment`, `zendesk_update_ticket`, `zendesk_apply_macro`) modify
real tickets — confirm changes with the user before sending.

## GDPR Compliance Content Sanitization

**On by default.** Before any tool result is handed to the LLM, every string in
it is scanned for personally identifiable information and each detected value is
replaced with a placeholder naming its type:

```text
"Hi, I'm Marie Dubois, email marie@company.fr, tel +33 6 12 34 56 78"
→ "Hi, I'm [PERSON_NAME_1], email [EMAIL_ADDRESS_1], tel [PHONE_NUMBER_1]"
```

Placeholders are **numbered per distinct value** and stay the same for the life
of the server process. Marie Dubois is `[PERSON_NAME_1]` in every ticket, search
result and comment, so the LLM can tell people apart and follow them across
tickets without seeing who they are. The value → placeholder mapping lives only
in memory and is never returned by a tool. Numbering is per value, ignoring case
and treating spaces, hyphens, underscores and dots alike. So "Hans-Mueller" and
"hans mueller" match, but "Thomas" alone gets a different number from "Thomas Becker".

- **Detection runs locally.** It uses
  [bardsai/eu-pii-anonimization-multilang](https://huggingface.co/bardsai/eu-pii-anonimization-multilang)
  (Apache-2.0), a multilingual PII model for the 24 EU languages with 35 entity
  types. These include names, contact details, addresses, identity documents,
  bank and card numbers, and the GDPR Art. 9 special categories (health,
  biometric, ethnic origin, political opinions, …). It runs in-process from the
  model's ONNX weights via transformers.js. Ticket content is never sent to a
  third party for this.
- **Safety nets.** Emails, IBANs, payment card numbers (Luhn-checked), IPv4
  addresses and international phone numbers are also matched by pattern. Any value detected once in a result is
  redacted everywhere else in that result too. For example, a requester name
  recognized in its own field is also removed from comment bodies.
- **Numeric ids are kept**, so the LLM can still chain tools, e.g. from
  `requester_id` to `zendesk_get_user`. Money amounts are detected but kept by
  default (see `ZENDESK_GDPR_KEEP_ENTITIES`).
- **URLs keep working.** A redacted Zendesk URL, such as an attachment
  `content_url` whose filename contained a name, is mapped back to the real URL
  when the LLM passes it to `zendesk_download_attachment` or `zendesk_request`.
- **Fails closed.** If the model can't be loaded, tools return an error instead
  of unredacted data.

The model (~280 MB for the default `q8` weights) downloads on first use into
`~/.zendesk-mcp/models`. The server starts loading it in the background at
startup. To download it ahead of time instead:

```bash
npx -y tokenless-zendesk-mcp download-model
```

Sanitization adds CPU time: roughly 0.1–0.5 s for a typical ticket, and more for
large searches or long threads. Results are cached per string. Detection is
statistical, so it lowers the risk of exposing personal data but can't guarantee
that nothing slips through. Names inside filenames (`passport_john_smith.pdf`)
are often missed.

**Tuning:**

- **Allowlist.** The model tags some product and company names as
  `PROPER_NAME` or `ORGANIZATION_NAME`. List terms that must never be redacted,
  such as your own products or a shared support mailbox, in
  `ZENDESK_GDPR_ALLOWLIST`, e.g.
  `ZENDESK_GDPR_ALLOWLIST="SEPTEO Avocat,support@septeo.com"`. Matching is
  case-insensitive and whole-word. Only the allowlisted part of a detection is
  kept, so "Zendesk" on the list still leaves the rest of "Zendesk Suite"
  redacted.
- **Threshold.** A token is redacted when the model's probability that it is PII
  reaches `ZENDESK_GDPR_THRESHOLD` (default `0.5`). Lower values redact more,
  mostly by adding false positives: in testing, `0.3` and `0.15` started
  redacting "Zendesk" and "Microsoft Teams" without catching any of the misses.
  Higher values redact less.
- **Plain placeholders.** `ZENDESK_GDPR_PSEUDONYMS=false` switches back to
  un-numbered `[PERSON_NAME]` placeholders.

Set `ZENDESK_GDPR_SANITIZATION=false` to turn sanitization off.

## Add to Claude Code

No clone, no build — just point your MCP config at `npx`. Add to your `.mcp.json`
(or Claude Desktop config), replacing `youracme` with your Zendesk subdomain:

```json
{
  "mcpServers": {
    "zendesk": {
      "command": "npx",
      "args": ["-y", "tokenless-zendesk-mcp"],
      "env": {
        "ZENDESK_SUBDOMAIN": "youracme"
      }
    }
  }
}
```

Or with the CLI: `claude mcp add zendesk -e ZENDESK_SUBDOMAIN=youracme -- npx -y tokenless-zendesk-mcp`

### First login

You sign in **once** in a real browser window. Run the bundled `login` subcommand
(it downloads Chromium on first use, then opens the window):

```bash
ZENDESK_SUBDOMAIN=youracme npx -y tokenless-zendesk-mcp login
```

- **macOS / Windows / Linux desktop:** a Chromium window opens — sign in, done.
- **WSL2:** you need **WSLg** (Windows 11) or an X server so the window can show.
  If the window can't open, run the login on the Windows host, or set `DISPLAY`.

You can also trigger login from inside Claude with the `zendesk_login` tool, but
the standalone command is more reliable since not every MCP host surfaces the window.

## From source (contributors)

```bash
npm install
npm run build
ZENDESK_SUBDOMAIN=youracme npm run login   # one-time browser sign-in
```

Then point your MCP config at the build instead of npx:

```json
{
  "mcpServers": {
    "zendesk": {
      "command": "node",
      "args": ["/path/to/tokenless-zendesk-mcp/dist/index.js"],
      "env": { "ZENDESK_SUBDOMAIN": "youracme" }
    }
  }
}
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the release process and how
publishing is configured.

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `ZENDESK_SUBDOMAIN` | — (**required**) | The `{subdomain}` in `https://{subdomain}.zendesk.com`. |
| `ZENDESK_SESSION_DIR` | `~/.zendesk-mcp` | Where the saved session lives. |
| `ZENDESK_API_TIMEOUT` | `30000` | Per-request timeout in ms. |
| `ZENDESK_LOGIN_TIMEOUT` | `300000` | How long the login window waits for you to finish signing in, in ms. |
| `ZENDESK_GDPR_SANITIZATION` | `true` | GDPR Compliance Content Sanitization — redact PII from all tool output. `false` disables it. |
| `ZENDESK_GDPR_MODEL` | `bardsai/eu-pii-anonimization-multilang` | Hugging Face id of the ONNX PII model. |
| `ZENDESK_GDPR_MODEL_DTYPE` | `q8` | Weight variant to load: `q8` (280 MB) or `fp32` (1.1 GB). |
| `ZENDESK_GDPR_MODEL_DIR` | `~/.zendesk-mcp/models` | Where the model is cached (default: `{ZENDESK_SESSION_DIR}/models`). |
| `ZENDESK_GDPR_KEEP_ENTITIES` | `FINANCIAL_AMOUNT` | Comma-separated entity types to leave unredacted (empty = redact everything). |
| `ZENDESK_GDPR_ALLOWLIST` | — | Comma-separated terms never redacted, e.g. product names (case-insensitive, whole-word). |
| `ZENDESK_GDPR_THRESHOLD` | `0.5` | Probability (0–1) a token must have of being PII to be redacted. Lower = redact more. |
| `ZENDESK_GDPR_PSEUDONYMS` | `true` | Numbered placeholders (`[PERSON_NAME_1]`) that stay the same for the session. `false` = plain `[PERSON_NAME]`. |

## Verify

After building and logging in:

```bash
ZENDESK_SUBDOMAIN=youracme node scripts/verify.mjs
```

It calls `me`, `listViews`, `search`, and `getTicket` against your live instance.

## Notes & limitations

- Auth is session-cookie based. Cookies expire (and SSO sessions time out), so
  you'll re-run `zendesk_login` periodically.
- It respects whatever permissions your agent account has — nothing more.
- The API is paginated; list tools cap results (`limit`) and page 100 at a time.
  Rate-limited (429) responses are retried honoring `Retry-After`.
- Writes are supported via the session CSRF token (see [Writes](#writes-csrf)).
  They act with your agent permissions — review changes before sending.
