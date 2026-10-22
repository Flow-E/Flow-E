# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking
changes.

## [Unreleased]

### Added

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

### Changed

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
