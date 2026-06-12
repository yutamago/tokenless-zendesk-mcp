/**
 * Centralized DOM selectors for the Zendesk Agent Workspace UI.
 *
 * These were tuned against a live instance (Garden design system, generic-table +
 * omni-log). We target stable `data-test-id` attributes. Markup can still drift
 * between Zendesk releases — if a scraper returns empty/partial data, use the
 * `zendesk_inspect` tool to dump the live HTML and adjust the selectors here.
 *
 * NOTE: ticket links in tables are RELATIVE hrefs ("tickets/123", "users/123"),
 * so attribute selectors must match `tickets/` not `/agent/tickets/`. Read the
 * `.href` DOM property to get the resolved absolute URL.
 */
export const SELECTORS = {
  // ---- Views (left nav) ----
  viewLink: 'a[href*="/agent/filters/"]',
  viewNavItem: '[data-test-id^="views_views-list_item-view-"]',
  viewNavItemCount: '[data-test-id="views_views-list_item_count"]',

  // ---- Ticket list table (shared by views + search results) ----
  ticketRow: '[data-test-id="generic-table-row"]',
  cellId: '[data-test-id="generic-table-cells-id"]',
  cellSubject: '[data-test-id="ticket-table-cells-subject"]',
  cellStatus: '[data-test-id="ticket-table-cells-status"]',
  cellStatusBadge: '[data-test-id^="status-badge-"]',
  cellAssignee: '[data-test-id="ticket-table-cells-assignee"]',
  cellRequester: '[data-test-id="ticket-table-cells-requester"]',
  cellDate: '[data-test-id="generic-table-cells-date"]',
  cellCustomFieldPrefix: 'ticket-table-cells-custom-field-',
  // Pagination (Garden cursor/page nav under the table).
  paginationNext: [
    '[data-test-id="generic-table-pagination"] button[aria-label="Next page"]',
    '[data-test-id="generic-table-pagination"] button[aria-label="Go to next page"]',
    'nav[aria-label="Pagination"] button[aria-label="Next page"]',
  ].join(", "),

  // ---- Ticket detail ----
  // Subject is an <input>; read its `.value`, not textContent.
  ticketSubject: '[data-test-id="omni-header-subject"]',
  assignee: '[data-test-id="assignee-field"]',
  assigneeGroupTag: '[data-test-id="assignee-field-selected-group-tag"]',
  assigneeAgentTag: '[data-test-id="assignee-field-selected-agent-tag"]',
  tagItem: '[data-test-id="ticket-system-field-tags-item-selected"]',
  // Custom form fields: container test-ids look like
  //   ticket-form-field-dropdown-field-{id}, ...-text-field-{id}, ...-checkbox-field-{id}
  customFieldContainer: '[data-test-id^="ticket-form-field-"]',
  dropdownButton: '[data-test-id="ticket-form-field-dropdown-button"]',

  // Conversation / interaction history (omni-log).
  conversationItem:
    '[data-test-id="omni-log-comment-item"], [data-test-id="interaction-history-event"]',
  convSender: '[data-test-id="omni-log-item-sender"]',
  convBody: '[data-test-id="omni-log-message-content"]',
  convInternalTag: '[data-test-id="omni-log-internal-note-tag"]',
  eventTitle: '[data-test-id="ticket-event-title-relative"]',
} as const;
