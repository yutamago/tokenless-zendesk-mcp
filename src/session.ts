import fs from "node:fs";
import fsp from "node:fs/promises";
import { chromium } from "playwright";
import { baseUrl, requireSubdomain, type Config } from "./config.js";

/**
 * Thrown when an operation needs an authenticated session but none exists
 * (or it has expired). The MCP layer turns this into a clear instruction to
 * run the `zendesk_login` tool.
 */
export class NotLoggedInError extends Error {
  constructor(detail?: string) {
    super(
      "Not logged in to Zendesk (no valid saved session). " +
        "Run the `zendesk_login` tool first — it opens a browser window so you " +
        "can sign in (including SSO/2FA). The session is then reused automatically." +
        (detail ? ` (${detail})` : "")
    );
    this.name = "NotLoggedInError";
  }
}

/** One cookie as persisted by Playwright's storageState. */
interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since epoch, or -1 for a session cookie. */
  expires: number;
}

/** Does `host` fall under the scope of a cookie's `domain` attribute? */
function domainMatches(host: string, cookieDomain: string): boolean {
  const d = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  return host === d || host.endsWith(`.${d}`);
}

/**
 * Owns Zendesk authentication for the lifetime of the MCP process.
 *
 * Auth model: the user logs in once via a *visible* browser (`login()`), we save
 * the resulting cookies to `storageState.json` via Playwright. Every later
 * operation reads those cookies and replays them as a `Cookie` header against the
 * Zendesk REST API — Zendesk's own agent UI authenticates the same way, and a
 * valid session cookie is all a GET request needs (no CSRF token required for
 * reads). When the session expires the API returns 401/403 and we surface
 * NotLoggedInError.
 */
export class ZendeskSession {
  constructor(private readonly cfg: Config) {}

  private async ensureSessionDir(): Promise<void> {
    await fsp.mkdir(this.cfg.sessionDir, { recursive: true });
  }

  hasSavedSession(): boolean {
    return fs.existsSync(this.cfg.storageStatePath);
  }

  /**
   * Open a visible browser at the Zendesk sign-in page and wait for the user to
   * finish authenticating (any method: password, SSO, 2FA). Detected by landing
   * on an authenticated /agent route. Persists the session cookies on success.
   */
  async login(timeoutMs = this.cfg.loginTimeoutMs): Promise<{ savedTo: string }> {
    const subdomain = requireSubdomain(this.cfg);
    await this.ensureSessionDir();

    // Login is ALWAYS headed — the user must see and drive the sign-in.
    const browser = await chromium.launch({ headless: false });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${baseUrl(subdomain)}/agent/`, {
        waitUntil: "domcontentloaded",
      });

      // Wait until we're on an authenticated agent route. Zendesk bounces
      // unauthenticated users to /access/* or an IdP domain; success lands
      // back on /agent/*.
      await page.waitForURL(
        (url) =>
          url.host === `${subdomain}.zendesk.com` &&
          url.pathname.startsWith("/agent"),
        { timeout: timeoutMs }
      );
      // Give the SPA a moment to settle so all auth cookies are written.
      await page.waitForLoadState("networkidle").catch(() => {});

      await context.storageState({ path: this.cfg.storageStatePath });

      // Capture the CSRF token the agent app embeds in the page — it's required
      // for write requests (the session cookie alone only authorizes reads).
      const token = await page
        .evaluate(() =>
          document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content")
        )
        .catch(() => null);
      if (token) await fsp.writeFile(this.cfg.csrfTokenPath, token, "utf8");

      await context.close();
      return { savedTo: this.cfg.storageStatePath };
    } finally {
      await browser.close();
    }
  }

  /**
   * Build the `Cookie` request header for API calls against this instance,
   * from the cookies saved at login. Only cookies scoped to the instance host
   * and not expired are included. Throws NotLoggedInError when there's no
   * usable session.
   */
  async cookieHeader(subdomain: string): Promise<string> {
    if (!this.hasSavedSession()) throw new NotLoggedInError();

    let cookies: StoredCookie[];
    try {
      const raw = await fsp.readFile(this.cfg.storageStatePath, "utf8");
      cookies = (JSON.parse(raw)?.cookies ?? []) as StoredCookie[];
    } catch (err) {
      throw new NotLoggedInError(
        `could not read session file: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const host = `${subdomain}.zendesk.com`;
    const nowSec = Date.now() / 1000;
    const usable = cookies.filter(
      (c) =>
        domainMatches(host, c.domain) &&
        (c.expires === -1 || c.expires > nowSec)
    );

    if (usable.length === 0) {
      throw new NotLoggedInError("saved session has no valid cookies for this instance");
    }
    return usable.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /**
   * The CSRF token required for write requests. Returns the token captured at
   * login if present, otherwise fetches a fresh one. Pass `forceRefresh` to
   * re-fetch (e.g. after a write was rejected with an auth error).
   */
  async csrfToken(subdomain: string, forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      try {
        const cached = (await fsp.readFile(this.cfg.csrfTokenPath, "utf8")).trim();
        if (cached) return cached;
      } catch {
        /* fall through to refresh */
      }
    }
    return this.refreshCsrfToken(subdomain);
  }

  /**
   * Fetch the agent app shell with the session cookie and parse the CSRF token
   * out of its `<meta name="csrf-token">` tag, persisting it for reuse. The
   * token is stable for the life of the session.
   */
  async refreshCsrfToken(subdomain: string): Promise<string> {
    const cookie = await this.cookieHeader(subdomain);
    const res = await fetch(`${baseUrl(subdomain)}/agent/`, {
      headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" },
    });
    if (res.status === 401 || res.status === 403) {
      throw new NotLoggedInError(`agent shell returned ${res.status}`);
    }
    const html = await res.text();
    const token = html.match(
      /<meta name="csrf-token" content="([^"]+)"/
    )?.[1];
    if (!token) {
      throw new Error(
        "Could not find a CSRF token in the agent page. Re-run zendesk_login."
      );
    }
    await this.ensureSessionDir();
    await fsp.writeFile(this.cfg.csrfTokenPath, token, "utf8");
    return token;
  }
}
