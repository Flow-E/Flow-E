# Flow-E website

The public site and the sandbox for [Flow-E](https://github.com/Flow-E/Flow-E): a Next.js 16 app
(App Router, TypeScript strict, Tailwind 4).

| Route      | What it is                                                                                |
| ---------- | ----------------------------------------------------------------------------------------- |
| `/`        | What Flow-E is, how it works, the thirteen rules, human control, proof, security, roadmap |
| `/docs`    | The repository README, synced at build time                                               |
| `/sandbox` | Signed-in only. Your own fictional company: approvals, cooling-off, agents, kill switch   |
| `/gate`    | The private-preview password page (only while `SITE_PASSWORD` is set)                     |

Sandbox pages: Overview, Fake agent (catalog, demo story, custom request, full rule trace),
Ledger (integrity check, CSV, issuer public key, receipt verify), Payment detail (trace,
receipt, download), Mandate (editor validated by the core schema) and Start over.

Everything in the sandbox is fictional. Flow-E authorizes payments; it never moves money.

## How it uses the core

The site runs the real engine, not a copy. The core package exports a pure entry point,
`@flow-e/mcp/core` (`src/core.ts` in the repo root): the rule engine, the config schema
(`parseConfigObject`), receipts and Ed25519, and the ledger fold. It imports no file system,
SQLite, CLI or MCP code; `test/core.test.ts` checks that.

The site imports it from the repository's own build, `../dist/core.js` (a `resolveAlias` in
`next.config.ts` and a `paths` entry in `tsconfig.json`), not from npm. So the site always runs
the engine of the same commit, and the npm package stays free of `web/` (`npm pack` lists only
`dist`). `npm run sync` (run before `dev`, `build`, `lint`, `typecheck` and `test`) copies the
README sections into `src/content/readme.generated.ts` and builds the core.

## Storage

`src/server/store.ts` keeps each sandbox in two tables (`db/migrations/001_init.sql`):

- `sandboxes`: one active row per owner, with the mandate, the agent credentials and the
  issuer key pair. The private key is encrypted with AES-256-GCM under `FLOWE_SANDBOX_KEY`.
- `ledger_entries`: the hash-chained, signed ledger. Triggers refuse `UPDATE`, `DELETE` and
  `TRUNCATE`; status changes are new entries. Every write locks its sandbox row
  (`SELECT … FOR UPDATE`) so two requests cannot fork the chain.

Start over archives the old sandbox (its ledger stays) and creates a new one with new keys.

Locally the store uses PGlite (Postgres in the process, in `web/.data/pglite`, migrated on
start). With `DATABASE_URL` set it uses Postgres through postgres.js. Production refuses PGlite.

Receipts from the site verify offline with the core CLI and the public key only:

```bash
node ../dist/cli/index.js verify receipt.json --pubkey issuer.pub
```

## Run it locally

Needs Node 22.12 or newer.

```bash
npm install --prefix ..
```

```bash
npm install
```

Copy `.env.example` to `.env.local`, fill in the two keys and set `FLOWE_DEV_LOGIN=1`, then:

```bash
npm run dev
```

Checks: `npm run lint`, `npm run typecheck`, `npm test` (in-memory PGlite, no setup needed),
`npm run build`.

## Environment variables

| Name                                   | Where           | Secret | Purpose                                                                                                   |
| -------------------------------------- | --------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `FLOWE_SANDBOX_KEY`                    | everywhere      | yes    | 32 random bytes, base64. Encrypts each sandbox's issuer private key                                       |
| `FLOWE_SESSION_SECRET`                 | everywhere      | yes    | 32+ random characters. Signs the session cookie                                                           |
| `SITE_PASSWORD`                        | optional        | yes    | Private-preview gate for every page. Remove to make the site public                                       |
| `DATABASE_URL`                         | production      | yes    | Postgres connection string (Supabase transaction pooler)                                                  |
| `FLOWE_PGLITE_DIR`                     | local, optional | no     | PGlite folder. Default `web/.data/pglite`                                                                 |
| `FLOWE_DEV_LOGIN`                      | local only      | no     | `1` = sign in with any email. Ignored when `NODE_ENV=production`                                          |
| `NEXT_PUBLIC_SUPABASE_URL`             | production      | no     | Supabase project URL, for the email sign-in link                                                          |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | production      | no     | Supabase publishable key (public by design)                                                               |
| `FLOWE_SITE_URL`                       | production, opt | no     | The site's public origin for sign-in links, e.g. `https://flow-e.vercel.app`. Default: the request's host |

Generate a sandbox key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Changing `FLOWE_SANDBOX_KEY` later makes existing sandboxes unreadable; their owners would
have to start over.

## Security

- `src/proxy.ts`: the password gate (HMAC-signed `flowe_gate` cookie, 7 days, httpOnly) and
  headers on every response: a CSP with a per-request nonce and `strict-dynamic`,
  `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`. All pages are rendered per request because of the nonce.
- Sessions: a signed, httpOnly cookie (12 hours). Every sandbox action reads the owner from
  the session, never from the form, so one user cannot reach another user's sandbox.
- Sign-in: Supabase Auth email links with PKCE, all server side (`src/server/supabase-auth.ts`,
  `/auth/callback`). The verifier lives in an httpOnly cookie scoped to `/auth/callback`, so a
  forwarded or intercepted link is useless in another browser. Supabase tokens are never stored;
  only the user id and email go into Flow-E's session.
- The whole site is `noindex` during the preview.

## Deploy (not done yet)

### Supabase

Project `khxqgpbgijnhckwlkorg` (Zurich), URL `https://khxqgpbgijnhckwlkorg.supabase.co`,
publishable key `sb_publishable__LHTIX5Dmr0Fg1ctdUztJA_Ak2sFoKm` (public).

1. SQL editor: run `db/migrations/001_init.sql` once. It is idempotent.
2. Project Settings → Database → Connection string → **Transaction pooler** (port 6543). That
   is `DATABASE_URL`, with the database password filled in. The client uses
   `prepare: false`, which the pooler needs.
3. RLS is enabled on both tables with no policies: the publishable key can read nothing. The
   server connects with the database role, which bypasses RLS.
4. Authentication → URL Configuration: **Site URL** = the Vercel address; **Redirect URLs** add
   `https://<your-vercel-address>/**` and `http://localhost:3150/**`. Sign-in links may only
   return to these.
5. The built-in email service sends only a few emails per hour: fine for testing. Before a
   public launch, set up custom SMTP (Authentication → Emails) with the Flow-E domain.

### Vercel

1. Import the GitHub repository Flow-E/Flow-E. **Root Directory:** `web`. Keep "Include files
   outside the root directory in the Build Step" on (the site builds the core from `..`).
2. **Install Command:** `npm ci --prefix .. --ignore-scripts && npm ci --ignore-scripts`.
   Build command and output stay at the Next.js defaults (`npm run build` builds the core
   first).
3. Environment variables (Production and Preview): `FLOWE_SANDBOX_KEY`,
   `FLOWE_SESSION_SECRET`, `SITE_PASSWORD`, `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Never set `FLOWE_DEV_LOGIN` there.
4. Region: Frankfurt (`fra1`) or Zurich-near, to sit next to the database.

### What is and is not verified

- Verified: everything locally with PGlite, the production build, the receipt round trip
  through the core CLI.
- Email sign-in: unit-tested against Supabase's documented endpoints (`/auth/v1/otp`,
  `/auth/v1/token?grant_type=pkce`, request shapes checked against `@supabase/auth-js`
  2.118.0), and run end to end in a browser against a local fake of those endpoints: link
  requested, link opened, sandbox opened; a reused link and a link without the browser's
  verifier are both refused. Not yet run against the real Supabase project.
- Not run: the Postgres adapter against a real Supabase database. It shares every query and
  test with PGlite, but has not met the pooler yet.
