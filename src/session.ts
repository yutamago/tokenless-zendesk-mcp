import fs from "node:fs";
import fsp from "node:fs/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { baseUrl, requireSubdomain, type Config } from "./config.js";

/**
 * Thrown when an operation needs an authenticated session but none exists
 * (or it has expired). The MCP layer turns this into a clear instruction to
 * run the `zendesk_login` tool.
 */
export class NotLoggedInError extends Error {
  constructor() {
    super(
      "Not logged in to Zendesk (no valid saved session). " +
        "Run the `zendesk_login` tool first — it opens a browser window so you " +
        "can sign in (including SSO/2FA). The session is then reused automatically."
    );
    this.name = "NotLoggedInError";
  }
}

/**
 * Owns the Playwright browser session for the lifetime of the MCP process.
 *
 * Auth model: the user logs in once via a *visible* browser (`login()`), we save
 * the resulting cookies/localStorage to `storageState.json`, and every later
 * operation spins up a context seeded from that file — so reads run headlessly
 * with no credentials in code. When the session expires, reads detect the
 * redirect to the sign-in page and throw NotLoggedInError.
 */
export class ZendeskSession {
  private browser: Browser | null = null;

  constructor(private readonly cfg: Config) {}

  private async ensureSessionDir(): Promise<void> {
    await fsp.mkdir(this.cfg.sessionDir, { recursive: true });
  }

  hasSavedSession(): boolean {
    return fs.existsSync(this.cfg.storageStatePath);
  }

  private async launch(headless: boolean): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await chromium.launch({ headless });
    return this.browser;
  }

  /**
   * Open a visible browser at the Zendesk sign-in page and wait for the user to
   * finish authenticating (any method: password, SSO, 2FA). Detected by landing
   * on an authenticated /agent route. Persists the session on success.
   */
  async login(timeoutMs = 300_000): Promise<{ savedTo: string }> {
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
      await context.close();
      return { savedTo: this.cfg.storageStatePath };
    } finally {
      await browser.close();
    }
  }

  /**
   * Run `fn` with an authenticated page seeded from the saved session.
   * Throws NotLoggedInError if there is no session or it has expired.
   */
  async withPage<T>(fn: (page: Page, subdomain: string) => Promise<T>): Promise<T> {
    const subdomain = requireSubdomain(this.cfg);
    if (!this.hasSavedSession()) throw new NotLoggedInError();

    const browser = await this.launch(this.cfg.headless);
    const context: BrowserContext = await browser.newContext({
      storageState: this.cfg.storageStatePath,
    });
    context.setDefaultTimeout(this.cfg.navTimeoutMs);
    context.setDefaultNavigationTimeout(this.cfg.navTimeoutMs);

    const page = await context.newPage();
    try {
      return await fn(page, subdomain);
    } finally {
      await context.close();
    }
  }

  /**
   * Navigate to an /agent path and assert we stayed authenticated.
   * Detects the redirect-to-login that signals an expired session.
   */
  async gotoAgent(page: Page, subdomain: string, pathOrUrl: string): Promise<void> {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${baseUrl(subdomain)}${pathOrUrl}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const current = new URL(page.url());
    const onLogin =
      current.pathname.startsWith("/access") ||
      current.pathname.startsWith("/auth") ||
      current.host !== `${subdomain}.zendesk.com`;
    if (onLogin) throw new NotLoggedInError();
  }

  async close(): Promise<void> {
    if (this.browser && this.browser.isConnected()) {
      await this.browser.close();
    }
    this.browser = null;
  }
}
