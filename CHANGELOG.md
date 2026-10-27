# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking
changes.

## [Unreleased]

### Added

- **Monthly and project budgets.** Agents can have a `monthly_budget`; `projects:` (cost centres,
  grants) have their own budget per month or in total, shared by the agents that may book to
  them, and `require_project` makes naming one mandatory. Two new rules after the daily budget.
- **Guidance for agents.** Every decline or review answers with `guidance`: what would be approved
  (approved suppliers, what is left of a budget and when it starts again, the usual price), or
  that the agent must not retry.
- Website: an **approval card** with everything to decide (why, budget effect, supplier history,
  similar purchases, usual price), on phones too; a decline needs a reason. A public **`/verify`**
  page where anyone can check a receipt without signing in. A **value report** on the dashboard
  (decided automatically, risky purchases stopped, overpayment avoided, work saved). A
  **getting-started checklist** for new organisations. **Price lists** can be imported from CSV,
  and usual prices are suggested from what was paid. A **what-if replay** shows how the last
  30 days would have been decided under a mandate change before it is saved.
- **Fair-price check**, a new rule between split detection and business hours: the mandate can
  hold usual prices per item (`reference_prices`), and a request more than `above_percent` above
  the usual price goes to a human (or is declined), more than `below_percent` below it too.
  `request_payment` takes optional `item` and `quantity`; the memo is used when there is no
  item. The demo has usual prices for its items and an overpriced seventh catalog item.
  On the website, usual prices are edited on the Mandate page, and the dashboard shows how many
  requests were checked, flagged above or below, and the overpayment avoided.
- `flow-e simulate`: a fake agent for the demo folder (`story`, `buy <n>`, `list`,
  `status <id>`, `mandate`). It talks to Flow-E over MCP stdio like Claude does, and refuses any
  folder not made by `flow-e demo`. `flow-e demo` now points to it.
- The agent-facing tools are defined once in `src/tools/agent-tools.ts` and exported from
  `@flow-e/mcp/core` (`AGENT_TOOLS`, `mandateSummary`, `toPaymentRequest`, `paymentAnswer`,
  `publicPayment`), so the stdio server and the website's remote endpoint answer identically.
- Website (phase 2, local only, not deployed): organisations with owner, approver and viewer
  roles and email invitations; real agents with signed credentials and API keys (shown once,
  stored as SHA-256, rotate, revoke, expiry); a remote MCP endpoint `/api/mcp` (Streamable HTTP,
  Bearer agent key, per-key rate limit); approval emails with one-time Approve and Decline
  links that act only after sign-in and a confirm. Each organisation has its own issuer and
  signed ledger. Migration `web/db/migrations/002_orgs.sql`.
- Website dashboard (local only, not deployed): the sandbox's and each organisation's first page
  shows approved spend, today against budget, approvals waiting, the share approved without a
  human, declines by rule, cooling-off cancels, spend and decisions per day, top suppliers,
  budget per agent, human approval times and recent activity, for today or the last 7, 30 or
  90 days and per agent (URL parameters). Server-rendered SVG charts with data tables; the CSV
  export can be limited to the visible view. Sandboxes can be filled once with 30 days of
  fictional sample history that runs through the real engine and signed ledger.
- Website: real email through Resend (`RESEND_API_KEY`, `EMAIL_FROM`) for invitations and
  approval links. It replaces the unwired SMTP adapter; `SMTP_URL` is no longer read.
- Website: a one-click demo lab organisation ("Example Labs AG (demo, fictional)") with the
  sandbox's lab agent, suppliers and limits, an empty ledger and a ready-made Claude prompt, plus
  a five-minute demo script in `docs/demo-script.md`.
- Website: categories are picked from a list with plain names (chemicals, lab equipment, office
  supplies, ...) instead of typed as four-digit codes; other codes still work. New agents start
  with filled-in example limits instead of placeholders.

### Changed

- **Split detection** now sends a possible split to a person instead of declining it; a payment
  held as a split does not count again towards later ones while it waits.
- Website dashboard: the approval and cooling-off panels follow the agent filter; foreign-currency
  declines count in the decline total (converted at the mandate's rate, or listed separately);
  agents beyond the eighth share one "Other agents" series; the last date label fits on phones.
- Renamed from the working name "Mandate" to **Flow-E** before the first release. It will be
  published as `@flow-e/mcp`, with the CLI command `flow-e`. The state folder is
  `.flow-e/`, the environment variables are `FLOWE_HOME` and `FLOWE_CONFIG`, and signed
  data uses the `flow-e-issuer:`, `flow-e-credential/v1` and `flow-e-receipt/v1` identifiers.
  "Mandate" stays as the name of the concept: `mandate.yaml` and the `check_mandate` tool.

## [0.1.0] - not yet published

First version. Authorizes payments only; never moves money.

### Added

- **Policy engine**: a pure `evaluate()` with 13 ordered rules (kill switch and agent status,
  Know Your Agent credential, amount and currency, country, supplier, category, per-payment
  limit, daily budget, velocity, split detection, business hours, approval threshold,
  cooling-off). It returns a full rule-by-rule trace, handles money as integer minor units with
  exact FX fractions rounded up, and fails closed.
- **Know Your Agent**: `flow-e init` creates an Ed25519 issuer key (mode 0600, never printed,
  never overwritten); `flow-e agent add` issues signed agent credentials, checked on every
  request.
- **Ledger and receipts**: an append-only SQLite ledger in which each entry hashes its
  predecessor and is signed by the issuer. `flow-e audit` names the first broken entry;
  `flow-e receipt` and `flow-e verify` produce and check receipts offline with only the
  public key.
- **MCP server** (`flow-e serve --agent <id>`, stdio) with four agent tools: `check_mandate`,
  `request_payment`, `get_payment` and `list_payments`. No tool can approve, change policy or
  unfreeze. Decisions are evaluated and recorded in one write transaction.
- **Human control**: `approve`, `decline`, `freeze`, `unfreeze` (`--all` is the kill switch),
  `cooloff-cancel`, and `export` (formula-safe CSV), each recorded as a signed ledger entry.
- **Control panel** (`flow-e panel`): a local web page on 127.0.0.1 with a per-start 256-bit
  token, a Host-header check, a strict CSP and text-only rendering of agent input.
- **Demo** (`flow-e demo`): a marked, fictional demo folder with a supplier catalog, ready-made
  Claude Code and Claude Desktop configuration, and a prompt to paste.
- Configuration in `mandate.yaml`, validated with zod; unknown keys are rejected.

### Security

- The demo's blocked-country list is not sanctions screening; see the README's security model
  and its known limits.

[Unreleased]: #unreleased
[0.1.0]: #010---not-yet-published
