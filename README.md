# mandate-mcp

> **Status: early development (v0.1).** The policy engine, agent credentials and signed ledger
> work; the MCP server and control panel are being built. Nothing here moves real money.

Give an AI agent a **mandate**: a verified identity, a budget and rules, human approval above a
threshold, a kill switch, and a signed receipt for every decision. `mandate-mcp` is an open-source
MCP server that _authorizes_ payments an agent asks for. It never holds or moves funds.

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
   ledger and signed receipts~~ · 5. MCP server · 6. Human control (CLI and local panel) · 7. Demo mode
   and docs · 8. Release

## Licence

MIT
