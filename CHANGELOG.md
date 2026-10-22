# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking
changes.

## [Unreleased]

### Added

- `imprest simulate`: a fake agent for the demo folder (`story`, `buy <n>`, `list`,
  `status <id>`, `mandate`). It talks to Imprest over MCP stdio like Claude does, and refuses any
  folder not made by `imprest demo`. `imprest demo` now points to it.

### Changed

- Renamed from the working name "Mandate" to **Imprest** before the first release. It will be
  published as `@imprest-hq/mcp`, with the CLI command `imprest`. The state folder is
  `.imprest/`, the environment variables are `IMPREST_HOME` and `IMPREST_CONFIG`, and signed
  data uses the `imprest-issuer:`, `imprest-credential/v1` and `imprest-receipt/v1` identifiers.
  "Mandate" stays as the name of the concept: `mandate.yaml` and the `check_mandate` tool.

## [0.1.0] - not yet published

First version. Authorizes payments only; never moves money.

### Added

- **Policy engine**: a pure `evaluate()` with 13 ordered rules (kill switch and agent status,
  Know Your Agent credential, amount and currency, country, supplier, category, per-payment
  limit, daily budget, velocity, split detection, business hours, approval threshold,
  cooling-off). It returns a full rule-by-rule trace, handles money as integer minor units with
  exact FX fractions rounded up, and fails closed.
- **Know Your Agent**: `imprest init` creates an Ed25519 issuer key (mode 0600, never printed,
  never overwritten); `imprest agent add` issues signed agent credentials, checked on every
  request.
- **Ledger and receipts**: an append-only SQLite ledger in which each entry hashes its
  predecessor and is signed by the issuer. `imprest audit` names the first broken entry;
  `imprest receipt` and `imprest verify` produce and check receipts offline with only the
  public key.
- **MCP server** (`imprest serve --agent <id>`, stdio) with four agent tools: `check_mandate`,
  `request_payment`, `get_payment` and `list_payments`. No tool can approve, change policy or
  unfreeze. Decisions are evaluated and recorded in one write transaction.
- **Human control**: `approve`, `decline`, `freeze`, `unfreeze` (`--all` is the kill switch),
  `cooloff-cancel`, and `export` (formula-safe CSV), each recorded as a signed ledger entry.
- **Control panel** (`imprest panel`): a local web page on 127.0.0.1 with a per-start 256-bit
  token, a Host-header check, a strict CSP and text-only rendering of agent input.
- **Demo** (`imprest demo`): a marked, fictional demo folder with a supplier catalog, ready-made
  Claude Code and Claude Desktop configuration, and a prompt to paste.
- Configuration in `mandate.yaml`, validated with zod; unknown keys are rejected.

### Security

- The demo's blocked-country list is not sanctions screening; see the README's security model
  and its known limits.

[Unreleased]: #unreleased
[0.1.0]: #010---not-yet-published
