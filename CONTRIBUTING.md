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
