# mandate-mcp

> **Status: early development (v0.1).** The policy engine works; the MCP server, credentials,
> ledger and control panel are being built. Nothing here moves real money.

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

## Configuration

See [`mandate.example.yaml`](mandate.example.yaml). Validate a file with:

```sh
npx mandate check mandate.yaml
```

## Roadmap

1. ~~Project skeleton~~ · 2. ~~Policy engine~~ · 3. Know Your Agent credentials · 4. Hash-chained
   ledger and signed receipts · 5. MCP server · 6. Human control (CLI and local panel) · 7. Demo mode
   and docs · 8. Release

## Licence

MIT
