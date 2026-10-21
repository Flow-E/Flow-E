# Imprest

Give an AI agent a **mandate**: a verified identity, a budget and rules, human approval above a
threshold, a kill switch, and a signed receipt for every decision. **Imprest** is an open-source
[MCP](https://modelcontextprotocol.io) server that **authorizes** the payments an agent asks for.
It never holds or moves money.

> **Why "Imprest"?** In accounting, an _imprest_ is a fixed float of money entrusted to someone
> for a purpose, spent within rules, accounted for item by item, and topped back up. That is what
> an agent's budget should be.

> **Status: v0.1, early, not yet on npm.** It will be published as `@imprest-hq/mcp`. Until then,
> install from a checkout as shown below. Everything here works locally. It has not had an
> external security review, and it is not a compliance product. See
> [Security model](#security-model).

## The 60-second pitch

AI agents are starting to buy things: lab supplies, compute, data, travel. Most companies won't
let them, because there is no trustworthy way to give an agent a budget and rules, see every
decision, and stop it instantly.

Imprest is that missing layer, and you can add it to an agent in five minutes:

- **Know Your Agent.** Each agent carries a signed credential that names a responsible person.
- **A mandate per agent.** Daily budget, per-payment limit, allowed suppliers, categories,
  countries and currencies, and a threshold above which a human must approve.
- **Humans stay in charge.** An approval queue, a freeze per agent, and a kill switch, from the CLI
  or a local control panel. The agent has no tool to approve, change rules or unfreeze itself.
- **Proof.** Every decision and every human action lands in an append-only, hash-chained ledger,
  and each one gets a signed receipt that an auditor can verify offline.

v1 is free and runs on your machine. Real payment rails, a hosted team dashboard and compliance
features come later (see the [roadmap](#roadmap)).

## Try it in 5 minutes

You need Node.js 22.12 or later, git, and Claude Code or Claude Desktop.

```sh
git clone <this repository> imprest && cd imprest
npm install && npm run build && npm link   # puts the `imprest` command on your PATH
cd .. && imprest demo
```

This sets up a folder called `imprest-demo` holding a **fictional** company, two agents, a supplier
catalog and fresh keys. It also starts the control panel and prints three things:

1. **A command that connects Claude** to the demo agent: `claude mcp add …` for Claude Code, or a
   JSON block for Claude Desktop. Run it, then start Claude.
2. **A link to the control panel.** Open it to watch requests arrive.
3. **A prompt to paste into Claude.** It asks Claude to buy five lab items from the catalog.

You should then see Claude:

- get **declined** buying the cheapest buffer, because the supplier is on the demo blocklist;
- get **approved** buying it from an allowed supplier instead, cancellable for 10 minutes because
  it is a first payment to that supplier;
- send the CHF 6,500 centrifuge to **review**. You approve it in the panel, and Claude sees the
  approval when it checks again;
- get **declined** for the CHF 9,000 column set, which is over the per-payment limit. Splitting it
  into smaller payments is caught too;
- get **declined** for glassware from a supplier that is not on the approved list.

Run `imprest demo --reset` to start over. Every company, person, supplier and price in the
demo is invented; supplier names all start with "Example".

## Use it with your own agents

```sh
imprest init                       # issuer keys in .imprest/ and a starter mandate.yaml
# edit mandate.yaml: your agents, budgets, suppliers, categories
imprest check                      # validate it
imprest agent add lab-procurement  # a signed credential for one agent
```

Then connect each agent with its own MCP server. Use **absolute paths** throughout, because the
client starts the server from its own working directory and may not share your `PATH`.

**Claude Code:**

```sh
claude mcp add imprest \
  -e IMPREST_HOME=/absolute/path/to/project/.imprest \
  -e IMPREST_CONFIG=/absolute/path/to/project/mandate.yaml \
  -- node /absolute/path/to/imprest/dist/cli/index.js serve --agent lab-procurement
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "imprest": {
      "command": "node",
      "args": [
        "/absolute/path/to/imprest/dist/cli/index.js",
        "serve",
        "--agent",
        "lab-procurement"
      ],
      "env": {
        "IMPREST_HOME": "/absolute/path/to/project/.imprest",
        "IMPREST_CONFIG": "/absolute/path/to/project/mandate.yaml"
      }
    }
  }
}
```

`imprest demo` prints both snippets with the real paths filled in. After the first npm release,
`npx -y @imprest-hq/mcp serve …` will replace the `node …/dist/cli/index.js serve …` part. Any MCP client that supports
stdio servers works the same way.

### What the agent can do

| Tool              | What it does                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| `check_mandate`   | Remaining budget today, limits, allowed currencies, categories and suppliers       |
| `request_payment` | Runs the rules, records the decision, and returns it with a payment id and receipt |
| `get_payment`     | Current status of one of the agent's own payments                                  |
| `list_payments`   | The agent's recent payments                                                        |

That is the whole list. No tool can approve, decline, freeze, unfreeze or change a rule.

## How a payment request is decided

Each request runs through these rules in order. The first decline stops evaluation. `review` (a
human must approve) only applies once every hard rule has passed.

| #   | Rule                                                               | If it fails        |
| --- | ------------------------------------------------------------------ | ------------------ |
| 1   | Global kill switch, then the agent's status                        | declined           |
| 2   | Know Your Agent credential: signature, issuer, agent, dates, scope | declined           |
| 3   | Amount above 0; currency in the allowed list                       | declined           |
| 4   | Country not on the global or the agent's blocked list              | declined           |
| 5   | Supplier not blocked; on the allowlist if the agent has one        | declined           |
| 6   | Merchant category code (MCC) allowed                               | declined           |
| 7   | Per-payment limit, in the base currency                            | declined           |
| 8   | Daily budget: today's approved **and pending** spend plus this one | declined           |
| 9   | Velocity: at most N requests per rolling minute (declines count)   | declined           |
| 10  | Split detection: same supplier within 10 min, sum over the limit   | declined           |
| 11  | Business hours (optional)                                          | review             |
| 12  | Human-approval threshold                                           | review             |
| 13  | Cooling-off: the first approved payment to a new supplier          | cancellable 10 min |

Every decision comes with a trace that names each rule and the numbers it used. Money is handled as
whole cents, never as floats. Foreign amounts are converted with your static rate table and rounded
**up**, so a limit is never under-counted. Any error inside the engine produces `declined`.

Good to know:

- **Split detection** also catches a genuine second order from the same supplier inside 10 minutes
  when the two together exceed the per-payment limit. Pending reviews count towards that sum.
- **Supplier names** are compared case- and whitespace-insensitively. Names can be imitated, so
  later versions will use verified supplier identities.

## Human control

```sh
imprest approve <payment-id> --note "Checked the quote"   # or: decline
imprest freeze lab-procurement                          # one agent; unfreeze undoes it
imprest freeze --all                                    # kill switch: decline everything
imprest unfreeze --all                                  # release it (frozen agents stay frozen)
imprest cooloff-cancel <payment-id>                     # within the 10-minute window
imprest export --out ledger.csv                         # the whole ledger as CSV
imprest panel                                           # the control panel in your browser
```

Each action is a signed ledger entry that records who acted (`--by`, which defaults to your OS user
name), when, and an optional note. It takes effect on the agent's next request; nothing needs a
restart. You can also set `status: frozen` or `paused` for an agent in `mandate.yaml`, and that too
applies at once.

The **control panel** shows the approval queue, payments in their cooling-off window, each agent's
budget for today, the ledger with a live integrity check, a freeze button per agent, the kill
switch, and a CSV export.

## Security model

**What it protects.** An agent cannot spend outside its mandate, cannot give itself more authority,
and cannot hide what it did. You can stop it at once, and anyone can check the record later.

**Trust boundaries.**

- **The model** sees only tool results. No tool returns keys, credentials or signatures, and an
  agent can read only its own payments. All input is validated with zod before the engine sees it.
- **The MCP server process** holds the issuer private key, so that it can sign receipts. Anyone who
  can read `.imprest/issuer.key` can issue credentials and sign ledger entries: guard it like a
  production secret.
- **The human owner** acts through the CLI or the panel, both on the same machine.

**Know Your Agent.** The issuer key is Ed25519. The private key is written with mode `0600` and
never printed. On Windows, protect the folder with NTFS permissions instead, because Windows
ignores Unix file modes. Credentials are checked on **every** request, against your issuer public
key only, never against a key the credential carries itself. In v1 a credential file is a bearer
token: whoever holds it can act as that agent.

**Ledger.** Entries are append-only (SQL triggers refuse `UPDATE` and `DELETE`). Each entry's
SHA-256 hash covers all its fields and the previous entry's hash, and each hash is signed with the
issuer key. Signatures are domain-separated, so a receipt signature can never pass as a credential.
`audit` checks the sequence, the links, the hashes and every signature, and names the first
broken entry.

**Control panel.**

- It listens on `127.0.0.1` only and rejects any `Host` header that is not a loopback name, which
  blocks DNS rebinding.
- Each start creates a fresh 256-bit token, carried in the link's `#fragment` so it never reaches a
  server log. The page then removes it from the address bar.
- Every API call needs that token as a header, which other websites cannot forge (no CSRF).
- A strict Content-Security-Policy forbids inline scripts. Text written by the agent is rendered as
  text, never as HTML. The CSV export defuses spreadsheet formulas.

**Fail closed.** Any engine error, a missing or broken `mandate.yaml`, or a missing credential means
the payment is not authorized.

**Known limits, stated plainly.**

- The issuer private key can rewrite history. Protect it.
- Deleting entries from the **end** of the ledger leaves a valid, shorter chain, so `audit` alone
  cannot see it. Any receipt that someone else holds for a removed entry then fails `verify`.
  Anchoring the ledger head externally is on the roadmap.
- Exchange rates are static. Blocked-country and blocked-supplier lists are whatever you configure.
- No accounts: `--by` is a label, not an authenticated identity.

> **Not legal advice.** The country list in the examples is a demo and is **not** sanctions
> screening. Imprest makes no claim of regulatory compliance. Configure your own screening.

## Ledger, receipts and audit

```sh
imprest audit                                     # check the whole chain
imprest receipt <receipt-or-payment-id> > receipt.json
imprest verify receipt.json                       # signature, hash and position in the ledger
imprest verify receipt.json --pubkey issuer.pub --offline   # an auditor with only the public key
```

All commands accept `--home <dir>` and `--config <file>`, or the `IMPREST_HOME` and
`IMPREST_CONFIG` environment variables.

## Configuration

`mandate.yaml` is plain YAML. Unknown keys are errors, so a typo cannot silently switch off a rule.
Amounts are in normal units of the base currency.

```yaml
organisation: 'Example Labs AG (fictional)'
base_currency: CHF
timezone: Europe/Zurich # defines "today" and business hours
fx: { EUR: 0.93, USD: 0.80 } # base-currency units per unit; static in v1
blocked_countries: [RU, BY, IR, KP] # demo list, NOT sanctions screening
blocked_suppliers: []
business_hours: { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }
agents:
  lab-procurement:
    owner: 'Dr. A. Muster, Head of Lab (fictional)'
    status: active # active | paused | frozen
    daily_budget: 20000
    per_payment_limit: 8000
    approval_above: 5000 # optional; leave out for no human review
    currencies: [CHF, EUR]
    categories: ['5169', '5047'] # merchant category codes
    suppliers: { mode: allowlist, allow: ['Example Reagents AG'], block: [] } # or mode: any
    blocked_countries: []
    velocity_per_minute: 6
    business_hours_only: false
```

## Roadmap

**v1 (this package)**: policy engine · Know Your Agent credentials · signed hash-chained ledger ·
MCP server · human control and local panel · demo. Release preparation is next.

**Later**, in a hosted version:

- real payment rails through adapters (Stripe, cards, stablecoins) and live exchange rates;
- a multi-user team dashboard with accounts, live sanctions screening, and an external anchor for
  the ledger head;
- money as a flow (streams and escrow) instead of lump sums;
- an Intent Exchange, where buyers' agents post demand backed by escrow and sellers' agents bid;
- agent buying unions, agent credit and insurance.

## Development

```sh
npm install
npm run build && npm test && npm run lint
npm run test:pack            # pack, install into an empty project, use it like a user
node dist/cli/index.js demo   # the demo from a checkout
```

## Licence

MIT
