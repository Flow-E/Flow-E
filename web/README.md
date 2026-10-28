# Flow-E website

The public site and the sandbox for [Flow-E](https://github.com/Flow-E/Flow-E): a Next.js 16 app
(App Router, TypeScript strict, Tailwind 4).

| Route                     | What it is                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `/`                       | For companies: the problem, how it works, a lab example, trust, rules, FAQ, pilot form   |
| `/docs`                   | The repository README, synced at build time                                              |
| `/sandbox`                | Signed-in only. Your own fictional company: dashboard, approvals, agents, kill switch    |
| `/app`                    | Signed-in only. Your organisations: real agents with API keys, members and roles         |
| `/app/<org>/invoices`     | Supplier invoices: upload or type in, matched against the authorizations, CSV export     |
| `/sandbox/invoices`       | The same for the sandbox, typed-in invoices only (fictional)                             |
| `/app/<org>/report`       | Printable value report (also `/sandbox/report`): every number with its method            |
| `/app/<org>/reorder`      | "Run reorder": the reorder list and Flow-E's own purchasing agent, with each run's log   |
| `/api/mcp`                | The remote MCP endpoint for agents (Streamable HTTP, `Authorization: Bearer` agent key)  |
| `/verify`                 | Public, no password: paste a receipt to check it was authorized (POSTs to `/api/verify`) |
| `/keys/<issuer>.pub`      | Public, no password: an issuer's published public key (PEM; `.json` adds its name)       |
| `/api/pilot`              | The home page’s pilot form posts here (route handler, 303 back to `/#pilot`)             |
| `/admin/pilots`           | Pilot requests; mark contacted or declined. Only `FLOWE_ADMIN_EMAILS`, others 404        |
| `/invite/…`, `/approve/…` | One-time links from invitation and approval emails (sign-in, then confirm)               |
| `/account/security`       | Signed-in only. Set up, check or turn off the authenticator app (second factor)          |
| `/account/verify`         | Signed-in only. Enter a code from the authenticator app (or a recovery code), then on    |
| `/dev/outbox`             | Development only: the emails Flow-E would have sent                                      |
| `/gate`                   | The private-preview password page (only while `SITE_PASSWORD` is set)                    |

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
(keys, connection instructions), Invoices (see below), Mandate, Members, Ledger, Settings.

**Roles.** Written once in `src/server/permissions.ts` and checked by the store on every call,
with the role read from the database:

| Permission                                   | Owner | Approver | Viewer |
| -------------------------------------------- | :---: | :------: | :----: |
| See everything (`org.read`)                  |   ✔   |    ✔     |   ✔    |
| Approve / decline (`payment.resolve`)        |   ✔   |    ✔     |        |
| Cancel in cooling-off (`payment.cancel`)     |   ✔   |    ✔     |        |
| Freeze / unfreeze an agent (`agent.freeze`)  |   ✔   |    ✔     |        |
| Kill switch (`killswitch.set`)               |   ✔   |    ✔     |        |
| Invoices: record, decide (`invoice.record`)  |   ✔   |    ✔     |        |
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

**Second factor (authenticator app).** Owners and approvers must have an authenticator app
(TOTP: any app such as 1Password, Google Authenticator or Aegis) and have entered a code in
this session before they approve or decline (also through an email link), change the mandate
or create agents, create, rotate or revoke keys, invite or manage members, or use the kill
switch. Viewers are never asked, and neither is the sandbox. The check is in one place,
`requireStrongSession` in `src/server/strong-session.ts`, called by the organisation actions
(`src/app/app/actions.ts`) and the `/approve/…` page and its confirm action. Without an app the
person is sent to `/account/security` ("Set up an authenticator app before you approve
payments"); with one, to `/account/verify` and then back to the page they were on. People with
an app also enter a code right after signing in.

- TOTP is our own implementation of RFC 6238 on `node:crypto` (`src/server/totp.ts`): SHA-1,
  6 digits, 30 seconds, one step either side, tested against the RFC's vectors. A code works
  once: the last accepted step is stored and the same or an older one is refused.
- Set-up shows the key as text and as a QR code (the `qrcode` package, rendered on the server
  to an SVG string: no script, CSP-safe), is confirmed with a first code, then shows 10
  one-time recovery codes once. Turning it off (or moving to a new phone: off, then set up
  again) needs a current code or a recovery code.
- A passed code is stored in the signed session cookie (`mfaAt`). It lasts as long as the
  session and at most 12 hours; a new sign-in asks again. At most 8 code attempts per person per
  15 minutes (in memory, per instance).
- Storage: `user_mfa` (`db/migrations/005_mfa.sql`): the secret encrypted with the
  key-encryption key (AES-256-GCM, like issuer keys), the last used step, and SHA-256 hashes of
  the unused recovery codes. Codes, secrets and recovery codes are never logged.
- Lost phone and no recovery codes: for now someone with database access deletes the person's
  `user_mfa` row; they then set it up again.

**Email delivery** is an adapter (`src/server/email.ts`). In development emails go to the
`email_outbox` table and `/dev/outbox` shows them (only with `NODE_ENV` not production and
`FLOWE_DEV_LOGIN=1`); production refuses the outbox. With `RESEND_API_KEY` and `EMAIL_FROM`
set, emails go out through the Resend HTTP API instead, in any environment (10 second timeout,
no retries). Setting only one of the two makes every send fail on purpose. A failed send never
fails the request: it is logged with the HTTP status and Resend's message, never the key or the
body (bodies hold one-time links). Without either, production refuses to send. Plain text plus
simple HTML, no tracking.

## Invoices

Supplier invoices are matched against what Flow-E authorized, with the core's
`src/control/invoices.ts` (tolerance from the mandate's `invoice_check`). Pages:

| Route                                  | What                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `/app/<org>/invoices`                  | List with filter: needs review, matched, all. Each row links its payment  |
| `/app/<org>/invoices/new`              | Add invoice: upload a file or type it in. `?reference=&supplier=` prefill |
| `/app/<org>/invoices/<id>`             | Match in plain words, the difference, request → … → status, accept/reject |
| `/app/<org>/invoices/upload`           | `POST`, same-origin only: keeps the file, returns the read fields (JSON)  |
| `/app/<org>/invoices/files/<file>`     | Download the stored file (members only, always as an attachment)          |
| `/app/<org>/invoices/export`           | Matched and accepted invoices as formula-safe CSV for accounting          |
| `/sandbox/invoices`, `…/new`, `…/<id>` | The same for the sandbox: typed in only, no files, fictional              |

- **Recording** (`invoice.record`: owner, approver) appends a signed `invoice.recorded` entry;
  accepting or rejecting one that did not match (rejecting needs a reason) appends
  `invoice.resolved`. Viewers read. Statuses: matched, mismatch, unmatched, duplicate, then
  accepted or rejected by a person. The payment page links "Add invoice" prefilled with the
  payment id as reference and shows the invoice's status.
- **Upload**: PDF, PNG or JPEG (checked by the file's first bytes), at most 4 MB (Vercel refuses request bodies above 4.5 MB). With
  `ANTHROPIC_API_KEY` set, the server asks Claude (`claude-haiku-5-5`, Messages API, 30 s
  timeout) for supplier, number, date, total, currency and reference, validates the answer and
  shows it in the form. A person checks and confirms; nothing is recorded before that, and the
  entry then says `source: extracted`. Without the key the file is still kept and the form is
  empty ("Automatic reading is off"). The file, the key and the model's answer are never logged.
- **Files** live in `org_invoice_files` (`db/migrations/004_invoice_files.sql`) with their
  SHA-256, which also goes into the invoice's ledger entry. They are kept 10 years (Swiss
  bookkeeping rules). Deleting them is not built yet, and files uploaded but never confirmed
  stay too.
- **Invoices by email** is a placeholder on the list page: not built.

## Value report

`/app/<org>/report` and `/sandbox/report` (`src/server/value-report.ts`, `budget-outlook.ts`):
computed from the ledger and the mandate only, for the last 7, 30 or 90 days, with a print
stylesheet ("Print or save as PDF"). Every number shows how it is counted. Decided
automatically and sent to a person; approval work saved, only next to its editable assumption
(`?minutes=`, default 5 minutes per manual approval); declines by reason; overpayment avoided
(flagged above the usual price, then declined or cancelled); invoice problems caught and the
amount billed above the authorization; daily budget pace; and for each monthly and project
budget the pace per day and the **projected run-out day** (approved plus waiting, as the engine
counts it; monthly budgets paced on this month so far, total project budgets on the last 30
days). Tested on a fixed ledger with known numbers (`test/value-report.test.ts`).

## What-if replay

The Mandate page's "Test against the last 30 days" (`src/server/replay.ts`) replays every
request of the period through the same engine with the rules as typed, before saving. It reads
the ledger only and writes nothing (tested on frozen entries). Two limits are shown with the
result: requests stopped by the kill switch, a frozen agent or a credential problem keep their
decision; and requests decided before Flow-E recorded the item and project with each request
(before 27 Oct 2026; told apart by the rules in their recorded trace) can't be checked against
usual prices or project budgets, so they are counted as "inexact".

## Public receipt check

`/verify` uses only the pasted receipt and the issuer's **published** public key
(`/keys/<issuer>.pub`, served by `src/app/keys/[file]/route.ts`; only keys whose issuer id
matches the key itself are published), or a key the person pastes. No lookups by payment id,
no search, nothing else from the account. It shows valid or forged, the name published with
the key, agent, amount, currency and date as signed, and whether the entry's **ledger position**
is consistent (the first entry starts from the genesis hash and no other does, it does not link
to itself, it is not dated in the future), plus what a receipt proves and what it doesn't.
Rate-limited per address and per instance; 32 KB per receipt, 4 KB per key.

## Run reorder

`/app/<org>/reorder` (`src/server/reorder.ts`, `reorder-agent.ts`, migration `006_reorder.sql`):
a reorder list per organisation (item, preferred supplier, quantity, optional stock and
minimum, category, country) and a **Run reorder** button (owners and approvers:
`reorder.manage`, `reorder.run`). The agent connects in memory to the very same MCP server an
external agent uses, as the chosen agent, so it can only check its mandate, ask for payments,
read its own payments and record orders. It never approves, changes a mandate or unfreezes
(tested). With `ANTHROPIC_API_KEY` set, Claude (`claude-opus-5-5`, effort low) decides, capped at
12 tool calls and 20,000 tokens per run; without it, a deterministic **simulated** run asks for
the usual price times the quantity for each due item, follows one supplier or project hint, and
records the order when approved. Each run keeps a short plain-language log; one run per
organisation at a time.

## Mandate page

Sandbox and organisations share one form (`src/app/sandbox/mandate/mandate-form.tsx`), turned
into `mandate.yaml` JSON by `src/lib/mandate-form-data.ts` and validated by the core schema in
the store. Nobody edits YAML. It has:

- **Organisation**: time zone, exchange rates, always-blocked countries and suppliers, business
  hours.
- **Fair price**: an editable table of usual prices (item, supplier, price, currency, unit,
  other words; add and remove rows). A price in another currency needs an exchange rate. A CSV
  price list can be imported: columns Supplier, Item, Unit, Price, Currency and optionally
  Keywords, with English or German headers (Lieferant, Artikel, Einheit, Preis, Währung,
  Stichworte), comma or semicolon separated. Currency defaults to the base currency; prices
  become integer minor units with the core's `parseAmount` (so JPY takes no decimals). Every
  line that cannot be imported is listed with its line number and reason. Template:
  `public/price-list-template.csv` (fictional suppliers). Items bought from the same supplier at
  least three times in 90 days are suggested with their median price and supplier; the owner
  adds them to the table and can still change them.
- **Invoices**: the tolerance before an invoice is flagged (percent and minimum amount; the
  larger counts).
- **Projects**: id, name, budget per month or in total, optional end date, and the agents that
  may book to it (none ticked: every agent).
- **Per agent**: everything in `agents.<id>` including the optional monthly budget and "every
  purchase must name a project".

Saving keeps stored values the form does not show, and an untouched form records nothing. A
rejected save lists each problem in plain words and marks the field. Below the form,
**Recent changes** shows the latest `config.updated` ledger entries: who, when, the note, and
each setting's old → new value (older entries without values name the changed settings).

The dashboard's **Get started** checklist (`src/server/getting-started.ts`) has six steps, each
ticked from data: create an agent; set the mandate (a change saved on the Mandate page, i.e. a
`config.updated` entry; creating an agent does not count); upload a price list (usual prices
exist); connect the agent (a key was used or a request arrived); make a first test request (a
payment exists); invite an approver (a second owner or approver, or a pending invitation for
one). It disappears when all six are done; viewers and approvers see it without links.

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

Invoice files live in `db/migrations/004_invoice_files.sql` (`org_invoice_files`, RLS enabled
and no policies); see Invoices above.

The second factor lives in `db/migrations/005_mfa.sql` (`src/server/mfa.ts`): one `user_mfa`
row per person, RLS enabled and no policies.

Pilot requests from the home page live in `db/migrations/003_pilot_requests.sql`
(`src/server/pilot.ts`): one row per request, `status` new, contacted or declined. The form posts
to `/api/pilot`: zod-validated with a cap on every field, a honeypot field, at most 5 requests per
client address per 10 minutes (in memory, per instance, like `/api/verify`), and the content is
never logged. A failed notification email never fails the request.

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

| Name                                   | Where           | Secret | Purpose                                                                                                              |
| -------------------------------------- | --------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `FLOWE_KEY_ENCRYPTION_KEY`             | everywhere      | yes    | 32 random bytes, base64. Encrypts every issuer private key (sandboxes and organisations)                             |
| `FLOWE_SANDBOX_KEY`                    | older name      | yes    | Same key under its old name; still read when `FLOWE_KEY_ENCRYPTION_KEY` is not set. Set only one                     |
| `RESEND_API_KEY`                       | production      | yes    | Resend API key (sending access is enough). With `EMAIL_FROM`, sends invitation and approval emails                   |
| `EMAIL_FROM`                           | production      | no     | Sender, e.g. `Flow-E <approvals@yourdomain>`. The domain must be verified in Resend                                  |
| `FLOWE_SESSION_SECRET`                 | everywhere      | yes    | 32+ random characters. Signs the session cookie                                                                      |
| `SITE_PASSWORD`                        | optional        | yes    | Private-preview gate for every page. Remove to make the site public                                                  |
| `DATABASE_URL`                         | production      | yes    | Postgres connection string (Supabase transaction pooler)                                                             |
| `FLOWE_PGLITE_DIR`                     | local, optional | no     | PGlite folder. Default `web/.data/pglite`                                                                            |
| `FLOWE_DEV_LOGIN`                      | local only      | no     | `1` = sign in with any email. Ignored when `NODE_ENV=production`                                                     |
| `NEXT_PUBLIC_SUPABASE_URL`             | production      | no     | Supabase project URL, for the email sign-in link                                                                     |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | production      | no     | Supabase publishable key (public by design)                                                                          |
| `FLOWE_SITE_URL`                       | production, opt | no     | The site's public origin for sign-in links, e.g. `https://flow-e.vercel.app`. Default: the request's host            |
| `FLOWE_LEADS_TO`                       | optional        | no     | One address that gets an email for each pilot request (through the mailer above; dev: outbox)                        |
| `FLOWE_ADMIN_EMAILS`                   | optional        | no     | Comma-separated emails that may open `/admin/pilots` after signing in. Unset: nobody                                 |
| `ANTHROPIC_API_KEY`                    | optional        | yes    | Reads uploaded invoices (a person confirms) and runs "Run reorder" with Claude. Unset: form empty, reorder simulated |

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
- Owners and approvers need an authenticator-app code per session for approvals, mandate,
  keys, members and the kill switch (see "Second factor" above).
- After sign-in, `?next=` only accepts our own `/sandbox`, `/app`, `/invite`, `/approve` and
  `/account` paths.
- The whole site is `noindex` during the preview.

## Deploy (not done yet)

### Supabase

Project `khxqgpbgijnhckwlkorg` (Zurich), URL `https://khxqgpbgijnhckwlkorg.supabase.co`,
publishable key `sb_publishable__LHTIX5Dmr0Fg1ctdUztJA_Ak2sFoKm` (public).

1. SQL editor: run `db/migrations/001_init.sql`, then `002_orgs.sql`, then
   `003_pilot_requests.sql`, then every later file in number order: `004_invoice_files.sql`
   (invoice files), `005_mfa.sql` (second factor), `006_reorder.sql` (reorder list and runs).
   All are idempotent.
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
   (`RESEND_API_KEY`, `EMAIL_FROM`): production refuses the dev outbox.
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
