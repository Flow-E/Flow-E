# mandate-mcp

> **Status: early development (v0.1).** The policy engine, agent credentials, signed ledger, MCP
> server and human controls work; demo mode and release prep come next. Nothing here moves real money.

Give an AI agent a **mandate**: a verified identity, a budget and rules, human approval above a
threshold, a kill switch, and a signed receipt for every decision. `mandate-mcp` is an open-source
MCP server that _authorizes_ payments an agent asks for. It never holds or moves funds.

## Connect an agent

```sh
npx mandate init                      # once: issuer keys and a starter mandate.yaml
npx mandate agent add lab-procurement # once per agent: a signed credential
```

Then start one MCP server per agent. Use **absolute paths**, because the client starts the server
from its own working directory.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mandate": {
      "command": "npx",
      "args": ["-y", "mandate-mcp", "serve", "--agent", "lab-procurement"],
      "env": {
        "MANDATE_HOME": "/absolute/path/to/project/.mandate",
        "MANDATE_CONFIG": "/absolute/path/to/project/mandate.yaml"
      }
    }
  }
}
```

**Claude Code**:

```sh
claude mcp add mandate   -e MANDATE_HOME=/absolute/path/to/project/.mandate   -e MANDATE_CONFIG=/absolute/path/to/project/mandate.yaml   -- npx -y mandate-mcp serve --agent lab-procurement
```

On Windows, use `"command": "cmd", "args": ["/c", "npx", "-y", "mandate-mcp", …]` (or `-- cmd /c npx …`
for Claude Code). Until the package is on npm, replace `npx -y mandate-mcp` with
`node /absolute/path/to/mandate-mcp/dist/cli/index.js`.

The agent gets four tools:

| Tool              | What it does                                                                   |
| ----------------- | ------------------------------------------------------------------------------ |
| `check_mandate`   | Remaining budget today, limits, allowed currencies, categories and suppliers   |
| `request_payment` | Runs the rules, records the decision, returns it with a payment id and receipt |
| `get_payment`     | Status of one of the agent's own payments                                      |
| `list_payments`   | The agent's recent payments                                                    |

There is no tool to approve, change policy or unfreeze. The server re-reads `mandate.yaml` and
the credential on every call, so an owner's edit (`status: frozen`, a lower budget) applies at
once. To try it with the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector --cli -e MANDATE_HOME=$PWD/.mandate -e MANDATE_CONFIG=$PWD/mandate.yaml   npx mandate serve --agent lab-procurement --method tools/list
```

## Human control

Only the owner can approve, decline, freeze, or cancel. The agent's tools cannot do any of these.
Every action is a signed ledger entry that records who acted, when, and an optional note.

```sh
npx mandate approve <payment-id> --note "Checked the quote"   # or: decline
npx mandate freeze lab-procurement                          # one agent; unfreeze to undo
npx mandate freeze --all                                    # kill switch: every payment is declined
npx mandate unfreeze --all                                  # release it (frozen agents stay frozen)
npx mandate cooloff-cancel <payment-id>                     # within 10 min of a first payment to a supplier
npx mandate export --out ledger.csv                         # the whole ledger as CSV
npx mandate panel                                           # the control panel in your browser
```

`--by` sets the name recorded for an action (default: your OS user name). Changes take effect on
the agent's next request; no restart is needed.

The **control panel** shows live payment requests, the approval queue, cooling-off payments, each
agent's budget for today, the ledger with its integrity check, a freeze button per agent, the kill
switch, and a CSV export. It is built to be safe on a shared machine:

- It listens on `127.0.0.1` only and refuses requests whose `Host` is not a loopback name, which
  blocks DNS-rebinding attacks.
- Each start prints a new random 256-bit token inside the link's `#fragment`, so the token never
  appears in server or proxy logs. The page removes it from the address bar. Every API call sends
  the token as a header, which other websites cannot forge.
- A strict Content-Security-Policy allows no inline scripts. Supplier names and memos come from the
  agent, so the page renders them as text and never as HTML. The CSV export defuses spreadsheet
  formulas.

## How a payment request is decided

Every request runs through these rules, in this order. The first decline stops evaluation.
`review` (a human must approve) only happens when every hard rule passed.

| #   | Rule                                        | Outcome when it fails |
| --- | ------------------------------------------- | --------------------- |
| 1   | Global kill switch, then agent status       | declined              |
| 2   | Know Your Agent credential                  | declined              |
| 3   | Amount above 0; currency allowed            | declined              |
| 4   | Country not blocked                         | declined              |
| 5   | Supplier not blocked; on allowlist if set   | declined              |
| 6   | Category (MCC) allowed                      | declined              |
| 7   | Per-payment limit (in base currency)        | declined              |
| 8   | Daily budget (approved + pending review)    | declined              |
| 9   | Velocity: max N requests per rolling minute | declined              |
| 10  | Split detection: same supplier, 10 minutes  | declined              |
| 11  | Business hours (optional)                   | review                |
| 12  | Human-approval threshold                    | review                |
| 13  | Cooling-off: first payment to a supplier    | cancellable 10 min    |

Every decision returns a trace naming each rule and the numbers it used. Money is handled in
integer minor units; foreign amounts are converted with a static rate table and rounded up.

> The blocked-country list in the example is a demo. It is **not** sanctions screening and not
> legal advice: configure your own screening.

## Know Your Agent credentials

```sh
npx mandate init                      # issuer key pair in .mandate/ and a starter mandate.yaml
npx mandate agent add lab-procurement # signed credential in .mandate/credentials/
```

- The issuer key is Ed25519. `.mandate/issuer.key` is written with mode `0600` and never printed;
  on Windows, protect the folder with NTFS permissions instead. `init` refuses to overwrite an
  existing key, because that would invalidate every credential.
- A credential names the agent, its responsible owner and organisation, its scopes, and when it
  was issued and expires (default 90 days). It is checked on **every** request: signature, issuer,
  agent id, validity window and scope. A failure is a decline with a clear reason.
- In v1 the credential file is a bearer token: whoever holds it can act as that agent. Keep it as
  safe as a password. To stop an agent at once, freeze it.

## Ledger and receipts

Every decision is written to an append-only SQLite ledger (`.mandate/ledger.db`) and gets a
signed receipt.

- Each entry stores the SHA-256 hash of the entry before it, so changing, removing or reordering
  any entry breaks the chain. SQL triggers refuse `UPDATE` and `DELETE`.
- Each entry hash is signed with the issuer key. Someone who edits the file and recomputes the
  hashes still cannot forge the signatures.
- A receipt is the entry plus its signature, as canonical JSON. Anyone with only the issuer
  **public** key can verify it offline.

```sh
npx mandate audit                          # check the whole chain; names the first broken entry
npx mandate receipt <receipt-or-payment-id> > receipt.json
npx mandate verify receipt.json            # signature, hash, and position in the local ledger
npx mandate verify receipt.json --pubkey issuer.pub --offline   # an auditor with only the public key
```

**Who sees what.** The MCP server process reads the issuer private key so that it can sign
receipts. The model only sees tool results: no tool returns keys, credentials or signatures, and
an agent can only read its own payments.

Limits, stated plainly: the issuer private key can rewrite history, so protect it. Deleting
entries from the **end** of the ledger is not visible to `audit` alone. Any receipt someone else
holds for a removed entry fails `verify`, and anchoring the ledger head externally is on the
roadmap.

## Configuration

See [`mandate.example.yaml`](mandate.example.yaml). Validate a file with:

```sh
npx mandate check mandate.yaml
```

## Roadmap

1. ~~Project skeleton~~ · 2. ~~Policy engine~~ · 3. ~~Know Your Agent credentials~~ · 4. ~~Hash-chained
   ledger and signed receipts~~ · 5. ~~MCP server~~ · 6. ~~Human control (CLI and local panel)~~ · 7. Demo mode
   and docs · 8. Release

## Licence

MIT
