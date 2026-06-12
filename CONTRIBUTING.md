# Contributing

## Local development

```bash
npm install          # installs deps (does NOT download Chromium — that's lazy)
npm run build        # tsc -> dist/
ZENDESK_SUBDOMAIN=youracme npm run login   # one-time browser sign-in
ZENDESK_SUBDOMAIN=youracme npm start       # run the MCP server over stdio
```

Chromium is downloaded on first `login` (via Playwright), not at install time, so
the server starts fast when run through `npx`. See `src/session.ts`
(`ensureBrowserInstalled`).

## Releasing

Releases publish to npm automatically when a `v*` tag is pushed. The version comes
from `package.json`, not the tag — keep them in sync (`npm version` does this for
you).

```bash
# from an up-to-date main:
npm version patch        # bumps package.json + package-lock, commits, tags vX.Y.Z
git push --follow-tags   # pushes the commit AND the tag
```

The tag push triggers `.github/workflows/publish.yml`, which builds and runs
`npm publish`. No tokens or secrets are involved — authentication is **npm OIDC
trusted publishing**, and provenance is attached automatically.

You can also re-run a release manually (e.g. if a publish failed for an
infrastructure reason) without re-tagging: trigger the workflow via
**Actions → publish → Run workflow** (`workflow_dispatch`). It publishes whatever
version is currently in `package.json` on the chosen ref.

> npm rejects republishing an existing version, so always bump before releasing.

### How publishing is authenticated (OIDC trusted publishing)

There are no npm tokens in CI. The `publish` job requests a short-lived OIDC token
from GitHub and exchanges it with the npm registry. For the exchange to succeed,
the **trusted-publisher configuration on npm must match the workflow run exactly**:

| Claim         | Must be                              |
|---------------|--------------------------------------|
| repository    | `yutamago/tokenless-zendesk-mcp`     |
| workflow file | `publish.yml`                        |
| environment   | `NPM Publishing`                     |

That last row is why the workflow job declares `environment: NPM Publishing` — if
the job's environment doesn't match the npm config, the token exchange fails with
a misleading `404 "package not found"`. Inspect or change the npm side with:

```bash
npm trust list tokenless-zendesk-mcp
npm trust github tokenless-zendesk-mcp \
  --repo yutamago/tokenless-zendesk-mcp --file publish.yml --env "NPM Publishing"
```

(Trusted-publishing setup requires npm ≥ 11.10 and account 2FA. The CI build uses
`npm install -g npm@latest` because OIDC publishing needs npm ≥ 11.5.1, newer than
some runners bundle. The workflow deliberately does **not** set `registry-url` on
`setup-node`: that would write an `.npmrc` with an empty auth token and stop npm
from falling back to OIDC.)

### Gotchas

- **Tag protection.** A repository ruleset protects all tags (no deletion, update,
  or non-fast-forward; creation is restricted). Repo admins can create release tags
  via their bypass; others cannot. Don't move or delete a published version tag.
- **Branch protection.** `main` requires PRs; admins can push directly. The version
  bump commit needs to reach `main` — open a PR, or push directly if you're an admin.
- **Changing the workflow identity.** If you rename `publish.yml`, move the repo, or
  change the environment name, update the npm trusted-publisher config to match
  (see the table above) or publishing will 404.
