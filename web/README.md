# Flow-E website

The public site and the sandbox for [Flow-E](https://github.com/Flow-E/Flow-E): a Next.js 16 app
(App Router, TypeScript strict, Tailwind 4).

| Route                     | What it is                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `/`                       | What Flow-E is, how it works, the thirteen rules, human control, proof, security, roadmap |
| `/docs`                   | The repository README, synced at build time                                               |
| `/sandbox`                | Signed-in only. Your own fictional company: dashboard, approvals, agents, kill switch     |
| `/app`                    | Signed-in only. Your organisations: real agents with API keys, members and roles          |
| `/api/mcp`                | The remote MCP endpoint for agents (Streamable HTTP, `Authorization: Bearer` agent key)   |
| `/invite/…`, `/approve/…` | One-time links from invitation and approval emails (sign-in, then confirm)                |
| `/dev/outbox`             | Development only: the emails Flow-E would have sent                                       |
| `/gate`                   | The private-preview password page (only while `SITE_PASSWORD` is set)                     |

Sandbox pages: Dashboard, Fake agent (catalog, demo story, custom request, full rule trace),
Ledger (integrity check, CSV, issuer public key, receipt verify), Payment detail (trace,
receipt, download), Mandate (editor validated by the core schema) and Start over.

Everything in the sandbox is fictional. Flow-E authorizes payments; it never moves money.

## Dashboard

The first page of the sandbox and of every organisation: what the agents spend, where, how often
Flow-E says no and why, and what waits for a human. The kill switch, the approval queue,
cooling-off cancels and freezes stay on the same page.

- **Period and agent** from the URL (`?period=today|7d|30d|90d&agent=<id>`, default 30 days):
  shareable and server-rendered. Days are calendar days in the mandate's time zone; "today" is
  charted per hour.
- **Key figures:** approved spend; today against the agents' combined daily budget (approved and
  waiting); waiting for approval (count and amount, whatever the period); share approved without
  a human; Flow-E's declines; payments cancelled in cooling-off; agents that made requests.
- **Charts:** approved spend per day by agent; decisions per day (approved, sent to a human,
  declined, as the engine decided at request time); top suppliers; declines by rule with plain
  names; budget used today per agent; human approvals (count, approved/declined, median wait
  from request to decision); the 10 latest decisions and human actions, linking to each payment.
- **Export this view (CSV):** the export routes take the same `period` and `agent`, and then
  return only the payment entries of the payments requested in that view plus its kill switch
  and freeze entries, in the same formula-safe CSV as the full export.

Every number comes from the ledger already loaded for the page (`src/server/analytics.ts`, pure
and unit-tested): the core's payment fold gives each payment's status after human actions, and
sums stay in integer minor units of the base currency. A request stopped before the amount rule
(kill switch, credential) has no converted amount; it counts at its requested amount when that is
in the base currency, otherwise it is left out of sums. The charts are plain server-rendered SVG
(`src/components/dashboard.tsx`): no chart library and no script, so the CSP nonce is untouched.
Each has a text summary for screen readers and a "Show data table" disclosure; a column's
tooltip is its SVG `<title>`. The colours were checked with a palette validator for both themes.

**Sample history (sandbox only).** An empty sandbox offers "Fill with 30 days of sample history"
on its dashboard. It is offered, not automatic, so the demo story and the fake agent still start
from a clean ledger for anyone who wants that. One click writes about 75 ledger entries of
fictional lab purchasing (`src/server/sample-history.ts`): routine approvals, equipment reviews
decided by a fictional approver, declines for a blocked supplier, the per-payment limit, a split
attempt, the wrong category, a blocked country, the daily budget, a lapsed credential and one
kill-switch episode, a cooling-off cancel, and one equipment purchase from today still waiting.
Every request goes through the real engine and every entry into the same signed hash chain;
only the clock is set back. That is why it runs only on an empty ledger, in one transaction,
oldest first, so ledger order stays time order. The first entry, `sandbox.sample_history`, says
that the entries after it are fictional and backdated, and records when they were really
written. Start over empties the sandbox as before. Organisations have no such path: only the
sandbox store has the method, and organisation timestamps always come from the clock.

## Organisations (phase 2, local only so far)

`/app` lists your organisations and creates new ones (name, base currency CHF or EUR, time
zone). Each organisation has its own issuer key pair, its own mandate (it starts empty and
valid) and its own signed, hash-chained ledger. Pages under `/app/<org>`: Dashboard (see above, plus
a getting-started checklist), Agents and each agent's page
(keys, connection instructions), Mandate, Members, Ledger, Settings.

**Roles.** Written once in `src/server/permissions.ts` and checked by the store on every call,
with the role read from the database:

| Permission                                   | Owner | Approver | Viewer |
| -------------------------------------------- | :---: | :------: | :----: |
| See everything (`org.read`)                  |   ✔   |    ✔     |   ✔    |
| Approve / decline (`payment.resolve`)        |   ✔   |    ✔     |        |
| Cancel in cooling-off (`payment.cancel`)     |   ✔   |    ✔     |        |
| Freeze / unfreeze an agent (`agent.freeze`)  |   ✔   |    ✔     |        |
| Kill switch (`killswitch.set`)               |   ✔   |    ✔     |        |
| Change the mandate, pause (`mandate.update`) |   ✔   |          |        |
| Create agents (`agent.create`)               |   ✔   |          |        |
| Create, rotate, revoke keys (`agent.keys`)   |   ✔   |          |        |
| Invite, revoke invitations (`member.invite`) |   ✔   |          |        |
| Change roles, remove (`member.manage`)       |   ✔   |          |        |
| Rename (`org.settings`)                      |   ✔   |          |        |

An organisation always keeps at least one owner. Invitations go by email with a one-time link
(7 days, single use); accepting needs a sign-in with the invited address. The owner also sees
the link once, to pass it on another way.

**Agents and keys.** An owner creates an agent with a starting mandate; the organisation's
issuer signs its Know Your Agent credential in the core's format (90 days, renewed
automatically). An agent key is `flowe_ak_` plus 32 random bytes (base64url), shown once.
Only its SHA-256 and a visible prefix are stored. Keys can expire, be rotated (old one revoked,
new one shown once) and be revoked; at most five are active per agent. Keys work only on
`/api/mcp`.

**Remote MCP endpoint.** `POST /api/mcp`, Streamable HTTP, stateless (`src/server/mcp-endpoint.ts`).
The key decides the organisation and the agent. The four tools are the core's shared
definitions (`src/tools/agent-tools.ts`), so they match the stdio server exactly. Each payment
is evaluated and recorded in one transaction with the organisation row locked, so a freeze or
kill switch that lands first always wins. A missing, wrong, revoked or expired key gets `401`
with a JSON-RPC error and `WWW-Authenticate: Bearer`. Limits: 60 requests per minute per key
(in memory, per server instance: with several instances the real limit is a multiple), 64 KB
per request. No cookies, no CORS. It is the only path the `SITE_PASSWORD` gate lets through.
Connect Claude Code with the command on the agent's page:

```bash
claude mcp add --transport http flow-e https://<site>/api/mcp --header "Authorization: Bearer flowe_ak_…"
```

**Approval emails.** A payment that needs review emails every owner and approver: amount,
supplier, agent, reason, and Approve and Decline links. Each link is a one-time token (hash
stored) bound to that person, that payment and that action, valid 24 hours. Opening a link
changes nothing: it asks for a sign-in as that person, shows the payment and acts only on the
confirm button (a POST), which re-checks the link, the person's current role and the payment's
status. Once a payment is decided, all its links are spent.

**Email delivery** is an adapter (`src/server/email.ts`). In development emails go to the
`email_outbox` table and `/dev/outbox` shows them (only with `NODE_ENV` not production and
`FLOWE_DEV_LOGIN=1`); production refuses the outbox. The SMTP adapter reads `EMAIL_FROM` and
`SMTP_URL` but is not wired to a transport yet. Plain text plus simple HTML, no tracking.

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

Organisations live in `db/migrations/002_orgs.sql` (`src/server/org-store.ts`): `orgs`,
`org_members`, `org_invitations`, `org_agents`, `agent_keys`, `org_ledger_entries` (same
append-only triggers as the sandbox ledger), `approval_tokens` and `email_outbox`. The sandbox
tables are untouched. Every table has RLS enabled and no policies.

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
| `FLOWE_KEY_ENCRYPTION_KEY`             | everywhere      | yes    | 32 random bytes, base64. Encrypts every issuer private key (sandboxes and organisations)                  |
| `FLOWE_SANDBOX_KEY`                    | older name      | yes    | Same key under its old name; still read when `FLOWE_KEY_ENCRYPTION_KEY` is not set. Set only one          |
| `EMAIL_FROM`, `SMTP_URL`               | later           | yes    | Real email delivery. Not wired yet: setting either makes sending fail on purpose until it is              |
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

Changing the key-encryption key later makes existing sandboxes and organisations unreadable.
To move from `FLOWE_SANDBOX_KEY` to the new name, give `FLOWE_KEY_ENCRYPTION_KEY` the same value.

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
- Organisations: every store method takes the signed-in user and checks their role from
  `org_members` against `src/server/permissions.ts`. A non-member gets the same answer whether
  or not the organisation exists. Ids from forms and URLs are only ever looked up inside the
  user's organisation.
- Secrets handed out (agent keys, invitation and approval links) are 32 random bytes; only
  their SHA-256 is stored, and the ledger records key ids and prefixes, never keys. Errors are
  logged by name only. One-time links sit in URL paths, so they appear in access logs: they are
  single-use, short-lived and useless without signing in as their recipient.
- After sign-in, `?next=` only accepts our own `/sandbox`, `/app`, `/invite` and `/approve`
  paths.
- The whole site is `noindex` during the preview.

## Deploy (not done yet)

### Supabase

Project `khxqgpbgijnhckwlkorg` (Zurich), URL `https://khxqgpbgijnhckwlkorg.supabase.co`,
publishable key `sb_publishable__LHTIX5Dmr0Fg1ctdUztJA_Ak2sFoKm` (public).

1. SQL editor: run `db/migrations/001_init.sql`, then `002_orgs.sql`. Both are idempotent.
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
3. Environment variables (Production and Preview): `FLOWE_SANDBOX_KEY` (or
   `FLOWE_KEY_ENCRYPTION_KEY` with the same value), `FLOWE_SESSION_SECRET`, `SITE_PASSWORD`,
   `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and
   `FLOWE_SITE_URL` (links in emails and on agent pages must not follow the request's Host
   header). Never set `FLOWE_DEV_LOGIN` there. Organisations need real email first
   (`EMAIL_FROM`, `SMTP_URL` and a wired transport): production refuses the dev outbox.
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
- Organisations (phase 2): verified locally only, with PGlite, the dev outbox and the dev
  login: tests for every action and role, isolation, invitations, keys, approval links and the
  MCP endpoint through the SDK client; the MCP Inspector CLI over HTTP; a browser walkthrough.
  Not run against Supabase, a real mail transport, or more than one server instance.
