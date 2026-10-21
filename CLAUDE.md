# mandate-mcp

Open-source MCP server that lets companies give AI agents a mandate: identity, budgets and rules, human approval, a kill switch, and signed receipts. v1 authorizes payments only; it never moves real money.

## Principles

- Trust is the product. Fail closed. Never let an agent-facing tool change policy, approve, or unfreeze.
- Money in integer minor units. Base-currency conversion only through the fx table.
- The engine is a pure function: no I/O, no clock calls (pass `now` in context).
- Every decision returns a full rule trace and gets a signed receipt in the hash-chained ledger.

## Layout

src/engine (rules, pure) · src/kya (credentials, Ed25519) · src/ledger (SQLite, hash chain, receipts)
src/mcp (tools, zod schemas) · src/panel (localhost control panel) · src/cli (commander) · src/config (mandate.yaml → engine types)

## Commands

npm run build · npm test · npm run lint · npm run typecheck · npm run coverage · node dist/cli/index.js demo

The npm names `mandate-mcp` and `mandate` belong to other projects; the package name is decided in build step 8. Never write `npx mandate-mcp` or `npx mandate` in docs or printed hints: that runs a stranger's package. Printed commands derive the name from package.json.

## Conventions

- TypeScript strict, ESM, Node 22.12+ (Node 20 is end-of-life and current deps need 22). zod for every external input.
- A new rule needs: engine code, a pass test, a fail test, an ordering test, a README entry.
- Demo data is fictional and labelled as such. No real company names as suppliers.
- Never log private keys, tokens, or full credentials.
- TypeScript stays on 5.9 until typescript-eslint supports TS 7.
- better-sqlite3 ships prebuilt binaries; its node-gyp install script is denied (`allowScripts` in package.json) so installs need no C++ toolchain.
- The ledger is append-only: status changes are new entries, never row updates.

## Out of scope for v1

Real payment rails, custody, KYC, live sanctions lists, hosting, streams/escrow, Intent Exchange.
