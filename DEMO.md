# Flow-E live demo (10 minutes)

For a pilot customer: a lab manager, a head of operations or someone from finance. Everything
shown is fictional: the company, the people, the suppliers and the amounts. Flow-E authorizes,
matches and records purchases; it does not move money. The company pays through its normal
process.

The story has eight steps. Each one is a screen you click through, with what to say.

## Before the call (15 minutes, once)

1. Sign in on the website with an admin address (one listed in `FLOWE_ADMIN_EMAILS`) and set up
   your authenticator app at **Account → Security** if you haven't.
2. Open **`/admin/demo`** and click **Build the demo organisation** (or **Reset: build a fresh
   one**). It takes up to a minute and opens **Lab Alpha (fictional)**: two agents, a price list
   from Example Labware AG and Example Reagents AG, a grant project, 60 days of signed history,
   invoices with a few mismatches, and two requests waiting for a person. Every page shows the
   yellow "Demo organisation, fictional data" banner.
3. For step 1, also create an empty organisation from **Organisations → Create an
   organisation**, named e.g. "Your company (demo)". It shows the checklist from the start.
4. For step 4 on a phone: emails need the domain and Resend set up. Until then, open the
   **Dashboard** of Lab Alpha on your phone and sign in there; the approval card is the same.
5. Open these tabs: the empty organisation, Lab Alpha's **Dashboard**, **Reorder**,
   **Invoices**, **Mandate**, **Report**, and **`/verify`** (public, no sign-in).
6. Download one receipt to your laptop: in Lab Alpha open an approved payment (from the
   Dashboard's recent activity) and click **Download** next to "Signed receipt".

## The demo

### 1. Set up in minutes (1 min, empty organisation)

Show the **Get started** checklist: create an agent, set the mandate, upload a price list,
connect the agent, a first test request, invite an approver. Click **Create an agent** and
create one with a daily budget; go back: that step is ticked.

> "Each step ticks itself off from what you actually did, not from clicking the list. A lab is
> ready in about ten minutes: an agent, its limits and your usual prices."

Open **Mandate** for a moment: budgets per day, month and project, the approval threshold,
suppliers, categories in plain words, business hours. "A form, not a contract. Every change is
recorded with the old and the new value."

### 2. The agent buys (1.5 min, Lab Alpha → Reorder)

Show the reorder list: pipette tips, gloves, PCR master mix, agarose, with stock and minimum.
Choose the **Lab consumables agent** and click **Run reorder**.

> "This is Flow-E's own purchasing agent, so you can start without building one. It has no
> special rights: it asks for each purchase exactly like any AI agent would, through the same
> five tools. It can't approve anything, change your rules or unfreeze itself."

Read the log under **Recent runs**: what it asked for, which supplier, the amount, approved or
sent to a person, and items skipped (stock is fine). Without an AI key the run is labelled
"simulated"; with one, Claude decides, capped per run.

### 3. Flow-E steers it (1 min, same log, then Dashboard)

Point to the petri dishes: the list asked a cheaper supplier outside the approved list. Flow-E
declined, named the approved suppliers, and the agent asked again from Example Labware AG.

> "When Flow-E says no, it also tells the agent how to get a yes: which suppliers are approved,
> how much budget is left and when it resets, or what the usual price is. The agent follows
> that once. It never splits a purchase to get under a limit; splitting is caught and goes to a
> person."

### 4. A person decides in seconds (1.5 min, phone)

On the phone, open the approval waiting on the **Dashboard** (or the link from the approval
email). The card shows amount, supplier and item, the usual price and how far above it the
request is, the effect on today's, this month's and the project's budget, the supplier's
history and the last similar purchases, and which rule sent it to a person, in plain words.

Approve the PCR master mix (above the threshold, normal price). Decline the pipette tips (50%
above the usual price) with a note.

> "Approving needs your second factor. The link in the email works once and expires after 24
> hours. And every approval is a signed entry: the agent sees it, and so does an auditor."

### 5. The invoice meets reality (1 min, Invoices)

Open **Invoices**. Filter **Needs review**: an invoice 8% above what was authorized, one with no
authorization at all, and the same invoice sent twice. Open the mismatch: request →
authorization → order → invoice, with the difference.

> "Flow-E matches each supplier invoice against what it authorized: by reference first, then
> by supplier and amount. Within 2% (at least CHF 5) it passes; anything else waits for a
> person. Matched invoices export as a CSV for accounting."

### 6. Test a rule change on real history (1.5 min, Mandate)

Lower the **Lab consumables agent**'s approval threshold from CHF 1,200 to CHF 600. Before
saving, click **Test against the last 30 days**.

> "Before you change a rule, Flow-E replays the last 30 days of real requests through the new
> rules: how many would have gone to a person instead, how spend changes, and which requests
> exactly. It writes nothing."

Don't save. (Or save, and show the change under **Recent changes** with the old and new value.)

### 7. Finance sees the value (1 min, Report)

Open **Report**: decided automatically versus sent to a person, declines by reason, overpayment
avoided, invoice problems caught, and for each monthly and project budget the pace per day and
the projected run-out day. Change **Minutes per manual approval** and click **Recalculate**.

> "Every number shows how it is counted, and comes only from the signed ledger. Time saved is
> an estimate with its assumption visible; change it to yours. Print it or save it as a PDF for
> your finance team."

### 8. Anyone can check a receipt (30 s, `/verify`)

Open `/verify` (no sign-in) and open the receipt file you downloaded. It says **Valid**, who
signed it, agent, amount, supplier and date, and that its ledger position is consistent.
Change one digit of the amount in the text box and check again: **Not valid**.

> "A supplier or an auditor can check that a purchase was really authorized, without access to
> your account. It uses only the receipt and your published public key. A receipt proves Flow-E
> authorized it; it is not a payment and not a guarantee."

### Close (30 s)

> "Flow-E sits between your agents and your money: a mandate they can't exceed, a person for
> the big decisions, invoices checked against what was authorized, and a record anyone can
> verify. A pilot takes two to three weeks with your own suppliers and rules."

## Reset after the call

- **Lab Alpha:** open `/admin/demo` and click **Reset: build a fresh one**. You leave the old
  Lab Alpha (its signed ledger is kept, as every ledger is, but nobody can open it) and get a
  fresh one with history up to today.
- **The empty organisation:** create a new one next time; organisations can't be deleted yet.
- **Reorder runs** made during the demo are part of Lab Alpha's history and go with the reset.

## If something goes wrong

| What you see                                   | What to do                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| "Set up your authenticator app" when approving | Do it once at **Account → Security**, then approve again                   |
| Approve asks for a code again                  | The second factor lasts 12 hours; enter the current code                   |
| Reorder run says "A run is still going"        | Wait a minute and reload; a run stuck for 10 minutes no longer blocks      |
| Report shows no run-out day                    | Only monthly and project budgets have one; daily budgets reset every day   |
| `/verify` says "unknown issuer"                | The receipt comes from another installation; paste that organisation's key |
