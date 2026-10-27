# Flow-E demo script (5 minutes)

For showing Flow-E to a lab: a head of lab, a lab manager or someone in finance. Everything in the
demo is fictional: the company, the suppliers, the prices and the money. Flow-E never moves money.

## Before the call (10 minutes, once per demo)

1. Sign in at the website and open **Organisations → Create the demo lab**. Flow-E creates
   "Example Labs AG (demo, fictional)" and opens its lab procurement agent.
2. Click **Create key**, copy the key, and connect Claude Code on your laptop:
   copy the **Claude Code** command from "Connect the agent", replace `flowe_ak_YOUR_KEY`, run it.
   Check with `claude mcp list` that `flow-e` shows "Connected".
3. Open the **sandbox** in a second tab and, if it is empty, click
   **Fill with 30 days of sample history**. This is the dashboard you show first.
4. Have three tabs ready: sandbox dashboard, demo lab dashboard, a terminal with `claude`.
   Copy the **Demo prompt to paste into Claude** from the agent page.

Tip: use a fresh demo lab per call (it takes 20 seconds), so its ledger starts empty.

## The demo

**1. The problem (30 s).** "Your team will soon let AI agents order reagents and consumables. Who
decides what an agent may buy, from whom, up to how much, and who can prove afterwards what
happened?"

**2. The dashboard (60 s, sandbox tab).** One month of a fictional lab's purchasing:

- approved spend, today against the daily budget, payments waiting for a person;
- the share approved without anyone touching it (the time saved);
- **"Why Flow-E said no"**: budget, per-payment limit, split payment, blocked supplier, in plain words;
- budget per agent, top suppliers, how long approvals take.

Switch to 7 days, then to one agent. "Everything here comes from a signed ledger, nothing is
typed in by hand."

**3. A real AI agent buys (90 s, terminal).** Paste the demo prompt into Claude. While it works,
say what to expect:

| Item                                   | What Flow-E does | Why                                                               |
| -------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| Cheapest buffer (Example Chem Trading) | declines         | Supplier on the block list                                        |
| Buffer from Example Reagents           | approves         | All rules pass; new supplier, so cancellable for 10 minutes       |
| Centrifuge, CHF 6,500                  | asks a person    | Above CHF 5,000                                                   |
| HPLC column set, CHF 9,000             | declines         | Above the CHF 8,000 per-payment limit; splitting it is caught too |
| Glassware kit (Example Glass)          | declines         | Not an approved supplier                                          |
| Nitrile gloves, CHF 240                | approves         | Small, routine                                                    |

"Claude chose the cheapest buffer first. Flow-E stopped it: price is not the only rule."

**4. The human stays in charge (60 s, demo lab tab).**

- **Approvals**: approve the centrifuge. Ask Claude "what's the status of the centrifuge payment
  now?": it sees "approved, by you".
- **Kill switch**: turn it on, ask Claude to buy gloves again: declined. Turn it off.
- **Mandate**: show that limits, suppliers and categories are a page, not a contract. Changes
  apply to the next request and are themselves in the ledger.

**5. Proof (30 s, demo lab tab).** Open the **Ledger**: every request, decision and approval is a
signed entry chained to the one before. Open the gloves payment and download its receipt: anyone
can check it with the organisation's public key, without access to Flow-E.

**6. Close (30 s).** "Flow-E sits between your agents and your money: identity, budgets, rules,
human approval, a kill switch and signed receipts. It works with any agent that speaks MCP."
Then ask the pilot questions.

## Pilot questions

1. How do you order lab supplies today, and who approves what above which amount?
2. Which suppliers and categories would you allow an agent first?
3. What would make you trust an agent with a budget: limits, approvals, audit, all three?
4. Who else would need to say yes (finance, IT security, compliance)?
5. Would you try it for four weeks with one team and one agent?

## If something goes wrong

- **Claude doesn't see the flow-e tools**: run `claude mcp list`. If flow-e is missing, Claude
  was started in another folder; if it fails to connect, the key is wrong or revoked: create a
  new key and add it again.
- **Everything is declined**: the kill switch is on, or the agent is frozen (demo lab →
  Controls).
- **"Too many requests"**: the demo allows 10 requests per minute per agent; wait a minute.
