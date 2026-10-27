import Link from 'next/link';
import { WorkedExample } from '@/components/home-example';
import { css } from '@/components/home-styles';
import '@/components/home.css';
import { PilotForm, type PilotNotice } from '@/components/pilot-form';
import { GITHUB_URL, SiteFooter, SiteHeader } from '@/components/site-chrome';
import { ButtonLink, Pill } from '@/components/ui';

const RULES: readonly [string, string, 'declined' | 'review' | 'note'][] = [
  [
    'Global kill switch, then the agent’s status',
    'Stops everything at once, or one agent',
    'declined',
  ],
  ['Know Your Agent credential', 'Signature, issuer, agent, dates and scope', 'declined'],
  ['Amount and currency', 'Above zero, in an allowed currency', 'declined'],
  ['Country', 'Not on the organisation’s or the agent’s blocked list', 'declined'],
  ['Supplier', 'Not blocked; on the approved list if the agent has one', 'declined'],
  ['Category', 'Merchant category code allowed for this agent', 'declined'],
  ['Per-payment limit', 'Converted to the base currency, rounded up', 'declined'],
  ['Daily budget', 'Today’s approved and pending spend, plus this one', 'declined'],
  ['Monthly budget', 'Optional: the same, per calendar month', 'declined'],
  [
    'Project budget',
    'Per project or cost centre, shared by the agents that book to it',
    'declined',
  ],
  ['Velocity', 'At most N requests per rolling minute', 'declined'],
  ['Split detection', 'Same supplier within 10 minutes, over the limit together', 'review'],
  ['Fair price', 'Optional: far above or below the item’s usual price, a person decides', 'review'],
  ['Business hours', 'Optional: outside them, a person decides', 'review'],
  ['Human-approval threshold', 'Above it, a person decides', 'review'],
  ['Cooling-off', 'A first payment to a new supplier stays cancellable for 10 minutes', 'note'],
];

const PROBLEMS: readonly [string, string][] = [
  [
    'A card has no judgement.',
    'Handing an agent a company card or a shop login gives it a credit line, not a policy. The card does not know your approved suppliers, your project budgets, or what a rack of pipette tips usually costs.',
  ],
  [
    'Approvals get lost.',
    'Who said yes to that order, and on what basis? Without a record it lives in a chat thread or an inbox, and an audit has to piece it together months later.',
  ],
  [
    'Budgets drift quietly.',
    'Small orders slip under every limit. Two orders a few minutes apart can add up to more than anyone would have approved in one go.',
  ],
  [
    'Stopping takes too long.',
    'When an agent goes wrong you need one switch that stops it now, not a round of cancelled cards and changed passwords.',
  ],
];

const CAPABILITIES: readonly [string, string, string][] = [
  [
    'Budgets hold, per day, month and project.',
    'Pending requests count too, so two orders cannot both squeeze under the same line. Projects and cost centres share one budget across agents.',
    'bg-paper',
  ],
  [
    'A person decides what needs a person.',
    'Above your threshold, an approval card reaches the right people with the reason, the budget effect, the supplier’s history and the usual price. It works on a phone. Declining asks for a reason.',
    'bg-surface',
  ],
  [
    'Overpriced offers stop before they are bought.',
    'Set usual prices, or import a price list. An offer far above them goes to a person; one suspiciously far below does too, because it is often the wrong product.',
    'bg-sunken',
  ],
  [
    'Every no says what would be a yes.',
    'Agents get guidance with each decline: the approved suppliers, what is left of a budget and when it starts again. They correct themselves instead of asking you.',
    'bg-paper',
  ],
  [
    'Try a rule change on last month first.',
    'Before you save a new limit, replay the last 30 days under it and see which decisions would have changed.',
    'bg-surface',
  ],
  [
    'See what the rules did for you.',
    'The dashboard’s value report shows what was decided without anyone, the risky purchases stopped, the overpayment avoided and the work saved.',
    'bg-sunken',
  ],
];

const FAQ: readonly [string, React.ReactNode][] = [
  [
    'Does Flow-E hold or move our money?',
    'No. It answers yes, no or “ask a person”. The order then goes through the channels you already use: a supplier account, an invoice, a purchase order. Flow-E needs no card and no access to a bank account.',
  ],
  [
    'Which agents does it work with?',
    'Any agent that speaks the Model Context Protocol (MCP), such as Claude. Each agent connects to Flow-E’s MCP endpoint with its own key and asks before every purchase.',
  ],
  [
    'What stops an agent from buying without asking?',
    'Flow-E decides; it cannot reach into a shop. It is strongest when the agent has no other way to pay: no card and no stored shop password, so an order only goes out after a yes. Keys can be revoked at any time, and the kill switch declines every request at once.',
  ],
  [
    'What happens when something goes wrong?',
    'Flow-E fails closed. An error in the engine, a broken mandate or a missing credential means declined, never approved.',
  ],
  [
    'Is it certified or audited?',
    <>
      Not yet. Flow-E is early (version 0.1), has not had an external security review and is not a
      compliance product. The{' '}
      <Link href="/docs#security-model" className="text-accent underline">
        security model
      </Link>
      , including its known limits, is public.
    </>,
  ],
  [
    'Who runs Flow-E?',
    'An independent founder, for now without a company behind it. That is why it starts with pilots: a few teams, one agent each, set up together. The code is open source under the MIT licence, so you can read exactly what it does.',
  ],
  [
    'What does a pilot look like?',
    'One agent and one budget. We write the mandate with you, connect your agent, and go through the decisions and the value report together.',
  ],
];

function notice(value: string | string[] | undefined): PilotNotice {
  return value === 'sent' || value === 'error' || value === 'limited' ? value : null;
}

const section = 'mx-auto max-w-6xl px-4 sm:px-6';
const h2 = 'font-serif text-4xl leading-[1.05] tracking-[-0.02em] sm:text-5xl';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const pilot = notice((await searchParams).pilot);
  return (
    <>
      <SiteHeader />
      <main>
        {/* Hero: words only */}
        <section
          className={`${section} flex min-h-[calc(100svh-4rem)] flex-col justify-between pb-10 pt-[12vh] sm:pb-14`}
        >
          <h1 className="font-serif text-[clamp(2.3rem,8.2vw,7.4rem)] font-medium leading-[0.95] tracking-[-0.035em] text-ink">
            <span className={css.line}>
              <span>Spending rules for</span>
            </span>{' '}
            <span className={`${css.line} sm:text-right`}>
              <span>AI agents that buy.</span>
            </span>
          </h1>
          <div
            className={`${css.after} mt-16 flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between`}
          >
            <p className="max-w-[46ch] text-lg leading-snug text-ink sm:text-[1.375rem]">
              Give each agent a budget, approved suppliers and a person who signs off. Flow-E checks
              every purchase before it happens, keeps a signed record, and never touches the money.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="#pilot" className={`${css.press} h-12 px-6 text-base`}>
                Request a pilot
              </ButtonLink>
              <ButtonLink
                href="/sandbox"
                variant="secondary"
                className={`${css.press} h-12 px-6 text-base`}
              >
                Try the sandbox
              </ButtonLink>
            </div>
          </div>
        </section>

        {/* The problem */}
        <section className="bg-sunken">
          <div className={`${section} py-24 sm:py-32`}>
            <h2 className="sr-only">Why companies hold back</h2>
            <p
              className={`${css.reveal} max-w-[62ch] font-serif text-[clamp(1.5rem,2.4vw,2.25rem)] leading-[1.2] tracking-[-0.01em] text-ink`}
            >
              AI agents can already compare offers and fill a basket. What keeps most companies from
              letting them order is simple: nobody can say in advance how much, from whom and who
              signs off, or show afterwards what happened.
            </p>
            <div className="mt-16 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
              {PROBLEMS.map(([lead, rest]) => (
                <p key={lead} className={`${css.reveal} text-base text-ink-2`}>
                  <strong className="font-semibold text-ink">{lead}</strong> {rest}
                </p>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className={`${section} py-24 sm:py-36`} aria-labelledby="how">
          <h2 id="how" className={h2}>
            How it works
          </h2>
          <ol className="mt-14 space-y-20 sm:space-y-24">
            <Step
              lead="First, give each agent a mandate."
              text="Budgets, a per-payment limit, approved suppliers, categories, countries, usual prices, and the amount above which a person decides. Each agent gets its own signed identity that names who is responsible for it."
            >
              <MandateFragment />
            </Step>
            <Step
              lead="Then the agent asks before it buys."
              text="Every request runs through sixteen rules in a fixed order. The answer comes back at once: approved, declined, or waiting for a person."
            >
              <RequestFragment />
            </Step>
            <Step
              lead="A person decides what needs a person."
              text="The approver sees everything needed to decide on one card, on a phone or a laptop. Freeze one agent, or stop all of them with the kill switch."
            >
              <ApprovalFragment />
            </Step>
            <Step
              lead="The order goes out as it always has."
              text="Your team or your systems order through the supplier account, invoice or purchase order you already use. Every decision is signed and chained into a ledger, with a receipt anyone can check."
            >
              <ReceiptFragment />
            </Step>
          </ol>
        </section>

        {/* Worked example: the live part */}
        <section className="bg-surface" aria-labelledby="example">
          <div className={`${section} py-24 sm:py-32`}>
            <div className="grid gap-6 lg:grid-cols-[1fr_1fr] lg:items-end">
              <h2 id="example" className={h2}>
                One lab, one week of orders
              </h2>
              <p className="max-w-[54ch] text-ink-2">
                The agent <span className="font-medium text-ink">lab-procurement</span> may spend
                CHF 20,000 a day, at most CHF 8,000 at once, from two approved suppliers. Above CHF
                5,000, or 20% over the usual price, a person decides. Pick a request to see what
                Flow-E did with it.
              </p>
            </div>
            <div className="mt-12">
              <WorkedExample />
            </div>
            <p className="mt-10 text-sm text-ink-3">
              From the sandbox’s demo story. The lab, suppliers and prices are fictional.{' '}
              <Link href="/sandbox" className="text-accent underline">
                Run it yourself
              </Link>
              .
            </p>
          </div>
        </section>

        {/* Capabilities as bands */}
        <section aria-labelledby="capabilities">
          <h2 id="capabilities" className="sr-only">
            What you get
          </h2>
          {CAPABILITIES.map(([lead, text, tone]) => (
            <div key={lead} className={tone}>
              <div
                className={`${section} grid gap-3 py-12 sm:py-16 lg:grid-cols-[1.25fr_0.75fr] lg:items-center lg:gap-12`}
              >
                <p
                  className={`${css.reveal} font-serif text-[clamp(1.6rem,3.3vw,3rem)] leading-[1.08] tracking-[-0.02em] text-ink`}
                >
                  {lead}
                </p>
                <p className={`${css.reveal} max-w-[52ch] text-base text-ink-2`}>{text}</p>
              </div>
            </div>
          ))}
        </section>

        {/* How the money moves */}
        <section className={`${section} py-24 sm:py-36`} aria-labelledby="money">
          <div className="grid gap-6 lg:grid-cols-2 lg:items-end">
            <h2 id="money" className={h2}>
              How the money moves
            </h2>
            <p className="max-w-[54ch] text-ink-2">
              It does not move through Flow-E. Flow-E only says whether a purchase is allowed. No
              new card, no new payment provider, nothing to connect to your bank.
            </p>
          </div>
          <div className="mt-14 grid gap-10 sm:grid-cols-2 sm:gap-6">
            <div className={`${css.reveal} rounded-xl bg-accent p-6 text-accent-ink sm:p-8`}>
              <p className="font-serif text-[clamp(3.5rem,11vw,9rem)] leading-[0.9] tracking-[-0.04em]">
                Decides.
              </p>
              <p className="mt-6 max-w-[40ch] text-base">
                <strong className="font-semibold">Flow-E</strong> checks the request against the
                mandate, asks a person when needed and signs the decision.
              </p>
            </div>
            <div className={`${css.reveal} rounded-xl bg-sunken p-6 text-ink sm:p-8`}>
              <p className="font-serif text-[clamp(3.5rem,11vw,9rem)] leading-[0.9] tracking-[-0.04em]">
                Pays.
              </p>
              <p className="mt-6 max-w-[40ch] text-base">
                <strong className="font-semibold">Your company</strong> orders as it does today:
                through the supplier account, against an invoice or with a purchase order. Accounts
                payable stays where it is.
              </p>
            </div>
          </div>
          <ol className="mt-14 grid gap-6 text-base sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ['The agent finds the offer', 'and asks Flow-E before ordering.'],
                ['Flow-E answers', 'approved, declined or waiting for a person.'],
                ['On a yes, the order goes out', 'through your usual supplier channel.'],
                ['The supplier invoices you', 'as always. The receipt proves who allowed it.'],
              ] as const
            ).map(([lead, rest]) => (
              <li key={lead} className={`${css.reveal} border-l-2 border-accent pl-4`}>
                <span className="font-semibold text-ink">{lead}</span>{' '}
                <span className="text-ink-2">{rest}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Trust and security: inverted field */}
        <section className="bg-ink text-paper" aria-labelledby="trust">
          <div className={`${section} grid gap-14 py-24 sm:py-32 lg:grid-cols-[0.9fr_1.1fr]`}>
            <div>
              <h2 id="trust" className={h2}>
                Proof, and an off switch
              </h2>
              <p className="mt-6 max-w-[48ch] text-lg opacity-85">
                Trust is the product, so Flow-E is built to be checked rather than believed.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/verify"
                  className={`${css.press} inline-flex h-11 items-center rounded-lg bg-paper px-5 text-sm font-medium text-ink hover:opacity-90`}
                >
                  Check a receipt
                </Link>
                <Link
                  href="/docs#security-model"
                  className="inline-flex h-11 items-center rounded-lg px-2 text-sm font-medium underline opacity-85 hover:opacity-100"
                >
                  Read the security model
                </Link>
              </div>
            </div>
            <dl className="grid gap-x-10 gap-y-9 sm:grid-cols-2">
              {(
                [
                  [
                    'It never moves money.',
                    'Flow-E holds no funds and no card numbers. The worst a fault can do is say no.',
                  ],
                  [
                    'Every decision is signed.',
                    'Each one lands in an append-only ledger where every entry is chained to the one before. Changing any entry breaks the chain.',
                  ],
                  [
                    'Anyone can verify a receipt.',
                    'A supplier or an auditor pastes it at /verify, with no account. It also checks offline with the public key alone.',
                  ],
                  [
                    'People stay in charge.',
                    'No agent tool can approve, change a rule or unfreeze itself. Only people can, and each action is a signed entry naming who acted.',
                  ],
                  [
                    'One switch stops everything.',
                    'Freeze one agent, or decline every request from every agent at once. It applies to the very next request.',
                  ],
                  [
                    'It fails closed.',
                    'An engine error, a broken mandate or a missing credential means declined.',
                  ],
                ] as const
              ).map(([lead, text]) => (
                <div key={lead} className={css.reveal}>
                  <dt className="text-lg font-semibold">{lead}</dt>
                  <dd className="mt-1.5 text-base opacity-85">{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* The rules */}
        <section className={`${section} py-24 sm:py-36`} aria-labelledby="rules">
          <div className="grid gap-6 lg:grid-cols-2 lg:items-end">
            <h2 id="rules" className={h2}>
              Sixteen rules, always in this order
            </h2>
            <p className="max-w-[54ch] text-ink-2">
              The first decline stops the check. A person is asked only once every hard rule has
              passed. Each decision comes with a trace naming every rule and the numbers it used.{' '}
              <Link href="/docs#how-a-payment-request-is-decided" className="text-accent underline">
                How each rule works
              </Link>
            </p>
          </div>
          <div className="mt-12 overflow-hidden rounded-xl">
            <table className="w-full border-collapse text-left text-base">
              <caption className="sr-only">
                The sixteen rules in the order Flow-E checks them, and what happens if one fails
              </caption>
              <thead className="bg-sunken text-sm text-ink-2">
                <tr>
                  <th scope="col" className="w-12 py-3 pl-4 font-medium sm:pl-6">
                    <span className="sr-only">Order</span>
                  </th>
                  <th scope="col" className="py-3 pr-4 font-medium">
                    Rule
                  </th>
                  <th scope="col" className="py-3 pr-4 text-right font-medium sm:pr-6">
                    If it fails
                  </th>
                </tr>
              </thead>
              <tbody>
                {RULES.map(([name, detail, outcome], i) => (
                  <tr key={name} className={i % 2 === 1 ? 'bg-surface' : ''}>
                    <td className="tabular py-3.5 pl-4 align-top text-ink-3 sm:pl-6">{i + 1}</td>
                    <td className="py-3.5 pr-4 align-top">
                      <span className="font-medium text-ink">{name}</span>
                      <span className="block text-sm text-ink-2">{detail}</span>
                    </td>
                    <td className="py-3.5 pr-4 text-right align-top sm:pr-6">
                      <Pill
                        tone={
                          outcome === 'declined'
                            ? 'declined'
                            : outcome === 'review'
                              ? 'review'
                              : 'accent'
                        }
                      >
                        {outcome === 'note'
                          ? 'cancellable'
                          : outcome === 'review'
                            ? 'a person decides'
                            : 'declined'}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* FAQ */}
        <section className="bg-sunken" aria-labelledby="faq">
          <div className={`${section} grid gap-12 py-24 sm:py-32 lg:grid-cols-[1fr_2fr]`}>
            <h2 id="faq" className={`${h2} lg:sticky lg:top-8 lg:self-start`}>
              Questions people ask
            </h2>
            <div>
              {FAQ.map(([q, a], i) => (
                <details
                  key={q}
                  open={i === 0}
                  className="group -mx-4 rounded-xl px-4 py-1 open:bg-surface sm:-mx-6 sm:px-6"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-lg text-ink sm:text-xl [&::-webkit-details-marker]:hidden">
                    {q}
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      className="shrink-0 text-ink-2 transition-transform duration-200 group-open:rotate-180"
                    >
                      <path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" />
                    </svg>
                  </summary>
                  <p className="max-w-[60ch] pb-5 text-base text-ink-2">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Pilot request */}
        <section
          id="pilot"
          className="scroll-mt-4 bg-accent text-accent-ink"
          aria-labelledby="pilot-h"
        >
          <div className={`${section} grid gap-12 py-24 sm:py-32 lg:grid-cols-[0.8fr_1.2fr]`}>
            <div>
              <h2 id="pilot-h" className={h2}>
                Request a pilot
              </h2>
              <p className="mt-6 max-w-[42ch] text-lg">
                Start with one agent and one budget. Tell us what your agents should buy, and you
                will hear back by email.
              </p>
              <ol className="mt-10 space-y-4 text-base">
                <li>
                  <span className="font-semibold">A reply from the founder,</span> usually with a
                  few questions about your suppliers and who approves today.
                </li>
                <li>
                  <span className="font-semibold">A short call</span> to write the first mandate
                  together.
                </li>
                <li>
                  <span className="font-semibold">One agent connected,</span> with a person
                  approving what needs approval.
                </li>
              </ol>
            </div>
            <PilotForm notice={pilot} />
          </div>
        </section>

        {/* For developers */}
        <section className={`${section} py-20 sm:py-24`} aria-labelledby="dev">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div>
              <h2 id="dev" className="font-serif text-3xl tracking-[-0.015em] sm:text-4xl">
                For developers
              </h2>
              <p className="mt-4 max-w-[48ch] text-ink-2">
                Flow-E is an open-source MCP server (MIT). Agents connect to the remote endpoint
                with their own key and call <code className="text-ink">check_mandate</code> and{' '}
                <code className="text-ink">request_payment</code>. The engine also runs on your own
                machine.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <ButtonLink href="/docs" variant="secondary" className={css.press}>
                  Read the docs
                </ButtonLink>
                <a
                  href={GITHUB_URL}
                  className="inline-flex h-10 items-center rounded-lg px-2 text-sm font-medium text-ink-2 underline hover:text-ink"
                >
                  Source on GitHub
                </a>
              </div>
            </div>
            <pre className="overflow-x-auto rounded-xl bg-sunken p-5 font-mono text-[0.8125rem] leading-relaxed text-ink">
              <code>{`# Connect Claude Code to Flow-E with an agent's key
claude mcp add --transport http flow-e https://<site>/api/mcp \\
  --header "Authorization: Bearer flowe_ak_…"`}</code>
            </pre>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function Step({ lead, text, children }: { lead: string; text: string; children: React.ReactNode }) {
  return (
    <li className="grid gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
      <div className={css.reveal}>
        <h3 className="font-serif text-2xl leading-tight tracking-[-0.01em] text-ink sm:text-3xl">
          {lead}
        </h3>
        <p className="mt-3 max-w-[48ch] text-base text-ink-2">{text}</p>
      </div>
      <div className={`${css.reveal} min-w-0`}>{children}</div>
    </li>
  );
}

/* Interface fragments: the product's own UI, drawn in HTML with fictional sandbox data. */

const ui = 'rounded-xl border border-rule bg-surface text-sm text-ink shadow-none';

function MandateFragment() {
  const rows: [string, string][] = [
    ['Daily budget', 'CHF 20,000.00'],
    ['Per payment', 'up to CHF 8,000.00'],
    ['A person decides', 'above CHF 5,000.00'],
    ['Suppliers', 'Example Reagents AG, Example Labware AG'],
    ['Categories', 'Chemicals; lab and medical equipment'],
    ['Usual prices', '15 items, 20% above goes to a person'],
  ];
  return (
    <figure data-ui className={ui}>
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <p className="font-semibold">lab-procurement</p>
          <p className="truncate text-ink-3">Responsible: Dr. A. Muster, Head of Lab</p>
        </div>
        <Pill tone="approved">active</Pill>
      </div>
      <dl className="divide-y divide-rule border-t border-rule">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-3 px-5 py-2.5">
            <dt className="text-ink-2">{k}</dt>
            <dd className="tabular min-w-0">{v}</dd>
          </div>
        ))}
      </dl>
      <figcaption className="border-t border-rule px-5 py-2.5 text-ink-3">
        Sandbox mandate. Fictional.
      </figcaption>
    </figure>
  );
}

function RequestFragment() {
  const trace: [string, string][] = [
    ['Supplier', 'Example Labware AG is on the approved list.'],
    ['Per-payment limit', 'CHF 6,500.00 is within CHF 8,000.00.'],
    ['Daily budget', 'Fits today’s remaining CHF 18,800.00.'],
    ['Fair price', '5% above the usual CHF 6,200.00.'],
  ];
  return (
    <figure data-ui className={ui}>
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <p className="text-ink-3">lab-procurement asks to pay</p>
          <p className="tabular text-xl font-semibold">CHF 6,500.00</p>
          <p className="truncate text-ink-2">Example Labware AG · Benchtop centrifuge</p>
        </div>
        <Pill tone="review">a person decides</Pill>
      </div>
      <ol className="divide-y divide-rule border-t border-rule">
        {trace.map(([rule, detail]) => (
          <li key={rule} className="flex gap-3 px-5 py-2.5">
            <span aria-label="passed" className="mt-1.5 size-2 shrink-0 rounded-full bg-approve" />
            <span className="min-w-0">
              <span className="font-medium">{rule}</span>{' '}
              <span className="text-ink-2">{detail}</span>
            </span>
          </li>
        ))}
        <li className="flex gap-3 bg-review-soft px-5 py-2.5">
          <span
            aria-label="needs a person"
            className="mt-1.5 size-2 shrink-0 rounded-full bg-review"
          />
          <span className="min-w-0">
            <span className="font-medium">Approval threshold</span>{' '}
            <span className="text-ink-2">Above CHF 5,000.00: a person must approve.</span>
          </span>
        </li>
      </ol>
      <figcaption className="border-t border-rule px-5 py-2.5 text-ink-3">
        Part of the rule trace. Fictional.
      </figcaption>
    </figure>
  );
}

function ApprovalFragment() {
  return (
    <figure data-ui className={`${ui} mx-auto max-w-sm overflow-hidden lg:mx-0`}>
      <div className="px-5 pb-4 pt-5">
        <p className="text-ink-3">Approval needed · Example Labs AG</p>
        <p className="tabular mt-1 text-2xl font-semibold">CHF 6,500.00</p>
        <p className="text-ink-2">to Example Labware AG, for a benchtop centrifuge</p>
      </div>
      <dl className="space-y-3 bg-sunken px-5 py-4">
        <div>
          <dt className="font-medium">Why it needs you</dt>
          <dd className="text-ink-2">Above the CHF 5,000.00 approval threshold.</dd>
        </div>
        <div>
          <dt className="font-medium">Budget today</dt>
          <dd className="text-ink-2">
            CHF 1,200.00 used; with this one CHF 7,700.00 of CHF 20,000.00.
          </dd>
          <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted-soft">
            <span className="bg-approve" style={{ width: '6%' }} />
            <span className="bg-review" style={{ width: '32.5%' }} />
          </div>
        </div>
        <div>
          <dt className="font-medium">Usual price</dt>
          <dd className="text-ink-2">CHF 6,200.00, so 5% above.</dd>
        </div>
        <div>
          <dt className="font-medium">Supplier</dt>
          <dd className="text-ink-2">Approved; first payment from this agent.</dd>
        </div>
      </dl>
      <div className="grid grid-cols-2 gap-2 px-5 py-4">
        <span className="inline-flex h-10 items-center justify-center rounded-lg bg-accent font-medium text-accent-ink">
          Approve
        </span>
        <span className="inline-flex h-10 items-center justify-center rounded-lg border border-rule-strong font-medium">
          Decline…
        </span>
      </div>
      <figcaption className="px-5 pb-4 text-ink-3">Fictional example.</figcaption>
    </figure>
  );
}

function ReceiptFragment() {
  return (
    <figure data-ui className={`${ui} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-4">
        <div>
          <p className="font-semibold">Receipt rcpt_1f90c2…e5c6fa</p>
          <p className="text-ink-3">Signed by Example Labs AG’s issuer key · ledger entry #3</p>
        </div>
        <Pill tone="approved">signature valid</Pill>
      </div>
      <pre className="overflow-x-auto border-t border-rule bg-sunken px-5 py-4 font-mono text-[0.8125rem] leading-relaxed text-ink-2">
        {`{
  "format": "flow-e-receipt/v1",
  "entry": {
    "seq": 3,
    "type": "payment.decision",
    "agent_id": "lab-procurement",
    "prev_hash": "6fbd1c0e…c41a07",
    "hash": "8c08deba…b0b76b"
  },
  "signature": "Ed25519 · base64url"
}`}
      </pre>
      <figcaption className="border-t border-rule px-5 py-2.5 text-ink-3">
        Shortened example. Anyone can check a real one at{' '}
        <Link href="/verify" className="text-accent underline">
          /verify
        </Link>
        .
      </figcaption>
    </figure>
  );
}
