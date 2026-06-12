import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { baseUrl, requireSubdomain, type Config } from "./config.js";

/**
 * Ensure Playwright's Chromium build is present, downloading it on first use.
 *
 * The browser is only needed for the interactive `login()` below — the MCP server
 * and every read/write tool talk to the REST API over `fetch` and never launch a
 * browser. So instead of an eager `postinstall` download (which would make every
 * cold `npx` start pay for ~150 MB before answering a single request), we install
 * Chromium lazily here, the first time someone logs in. Progress is streamed to
 * stderr so it never corrupts the stdout MCP JSON-RPC channel.
 */
async function ensureBrowserInstalled(): Promise<void> {
  if (fs.existsSync(chromium.executablePath())) return;

  const require = createRequire(import.meta.url);
  const cli = path.join(
    path.dirname(require.resolve("playwright/package.json")),
    "cli.js"
  );
  console.error("Downloading the Chromium browser for the first-time login ...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      stdio: ["ignore", process.stderr, process.stderr],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`playwright install chromium exited with code ${code}`))
    );
  });
}

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
    await ensureBrowserInstalled();

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
      // back on /agent/* (typically /agent/home/tickets).
      await page.waitForURL(
        (url) =>
          url.host === `${subdomain}.zendesk.com` &&
          url.pathname.startsWith("/agent"),
        { timeout: timeoutMs }
      );

      // The agent app is authenticated and fully ready once it has rendered the
      // CSRF token into the page. We wait for that (instead of networkidle,
      // which never settles because the workspace holds long-lived pubsub
      // connections) — this lets us close the browser promptly and capture the
      // token in one step. waitForFunction also rides out the SPA's client-side
      // redirect to the dashboard, which would otherwise destroy a one-shot
      // evaluate. The token is needed for write requests (the cookie alone only
      // authorizes reads).
      let token: string | null = null;
      try {
        const handle = await page.waitForFunction(
          () =>
            document
              .querySelector('meta[name="csrf-token"]')
              ?.getAttribute("content") || null,
          { timeout: 15_000 }
        );
        token = (await handle.jsonValue()) as string | null;
      } catch {
        /* fall back to HTTP capture below */
      }

      await context.storageState({ path: this.cfg.storageStatePath });
      await context.close();
      await browser.close();

      // Persist the CSRF token. Prefer the one read from the page; if that
      // didn't yield one, fetch it over HTTP with the freshly-saved cookies
      // (refreshCsrfToken writes the file itself).
      if (token) await fsp.writeFile(this.cfg.csrfTokenPath, token, "utf8");
      else await this.refreshCsrfToken(subdomain).catch(() => {});

      return { savedTo: this.cfg.storageStatePath };
    } finally {
      if (browser.isConnected()) await browser.close();
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
