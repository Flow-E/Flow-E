import Link from 'next/link';
import {
  CircleCheck,
  CircleSlash,
  Clock,
  FileCheck2,
  Hand,
  Power,
  ShieldCheck,
  Snowflake,
} from 'lucide-react';
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
  ['Fair price', 'Optional: far above or below the item’s usual price, a human decides', 'review'],
  ['Business hours', 'Optional: outside them, a human decides', 'review'],
  ['Human-approval threshold', 'Above it, a human decides', 'review'],
  ['Cooling-off', 'A first payment to a new supplier stays cancellable for 10 minutes', 'note'],
];

const TRACE: readonly [string, 'pass' | 'review', string][] = [
  ['Know Your Agent credential', 'pass', 'Credential for lab-procurement is valid.'],
  ['Supplier', 'pass', 'Example Labware AG is on the approved list.'],
  ['Per-payment limit', 'pass', 'CHF 6,500.00 is within CHF 8,000.00.'],
  ['Daily budget', 'pass', 'Fits today’s remaining CHF 18,560.00.'],
  ['Approval threshold', 'review', 'Above CHF 5,000.00: a human must approve.'],
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl gap-12 px-4 pb-16 pt-14 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:pb-24 lg:pt-20">
          <div>
            <h1 className="font-serif text-[2.6rem] leading-[1.05] tracking-[-0.02em] text-ink sm:text-6xl">
              Give your AI agents a mandate, not a credit card.
            </h1>
            <p className="mt-6 max-w-[60ch] text-lg text-ink-2">
              Flow-E is an open-source MCP server that authorizes the payments an agent asks for.
              Each agent gets a verified identity, a budget and rules, human approval above a
              threshold, a kill switch, and a signed receipt for every decision. It never holds or
              moves money.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/sandbox">Try the sandbox</ButtonLink>
              <ButtonLink href="/docs" variant="secondary">
                Read the docs
              </ButtonLink>
            </div>
            <p className="mt-4 text-sm text-ink-3">
              The sandbox runs a fictional lab with fictional suppliers and fictional money.
            </p>
          </div>

          {/* A real decision, as the engine records it */}
          <figure className="rounded-2xl border border-rule bg-surface shadow-[0_18px_40px_-24px_rgb(27_31_36/0.35)]">
            <div className="flex items-center justify-between gap-3 border-b border-rule px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink-3">lab-procurement asks to pay</p>
                <p className="tabular font-mono text-lg text-ink">CHF 6,500.00</p>
                <p className="truncate text-sm text-ink-2">
                  Example Labware AG · Benchtop centrifuge
                </p>
              </div>
              <Pill tone="review">
                <Clock size={14} aria-hidden="true" /> review
              </Pill>
            </div>
            <ol className="divide-y divide-rule">
              {TRACE.map(([rule, outcome, detail]) => (
                <li key={rule} className="flex gap-3 px-5 py-2.5 text-sm">
                  {outcome === 'pass' ? (
                    <CircleCheck
                      size={16}
                      className="mt-0.5 shrink-0 text-approve"
                      aria-label="passed"
                    />
                  ) : (
                    <Hand
                      size={16}
                      className="mt-0.5 shrink-0 text-review"
                      aria-label="needs review"
                    />
                  )}
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{rule}</span>
                    <span className="block text-ink-2">{detail}</span>
                  </span>
                </li>
              ))}
            </ol>
            <figcaption className="border-t border-rule px-5 py-3 font-mono text-xs text-ink-3">
              receipt rcpt_1f90c2…e5c6fa · signed · entry #3
              <span className="block font-sans">Example from the sandbox. Fictional.</span>
            </figcaption>
          </figure>
        </section>

        {/* Problem and pillars */}
        <section className="border-y border-rule bg-surface">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <h2 className="font-serif text-3xl leading-tight tracking-[-0.015em] sm:text-4xl">
                Agents can shop now. Companies still won’t let them.
              </h2>
              <p className="mt-4 max-w-[52ch] text-ink-2">
                There is no trustworthy way to give an agent a budget and rules, see every decision,
                and stop it instantly. Card networks are building rails for agent payments; the
                company-side control layer is what’s missing.
              </p>
            </div>
            <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {(
                [
                  [
                    ShieldCheck,
                    'Know Your Agent',
                    'Every agent carries a signed credential that names a responsible person. It is checked on every request.',
                  ],
                  [
                    FileCheck2,
                    'A mandate per agent',
                    'Daily budget, per-payment limit, approved suppliers, categories, countries and currencies.',
                  ],
                  [
                    Hand,
                    'Humans stay in charge',
                    'An approval queue, a freeze per agent, a kill switch. No agent tool can approve or unfreeze.',
                  ],
                  [
                    CircleCheck,
                    'Proof, not promises',
                    'Every decision lands in an append-only, hash-chained ledger with a receipt anyone can verify offline.',
                  ],
                ] as const
              ).map(([Icon, title, text]) => (
                <div key={title}>
                  <dt className="flex items-center gap-2 font-semibold text-ink">
                    <Icon size={18} className="text-accent" aria-hidden="true" />
                    {title}
                  </dt>
                  <dd className="mt-2 text-ink-2">{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Rules */}
        <section className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
          <div className="lg:sticky lg:top-8 lg:self-start">
            <h2 className="font-serif text-3xl leading-tight tracking-[-0.015em] sm:text-4xl">
              Sixteen rules, always in the same order.
            </h2>
            <p className="mt-4 max-w-[52ch] text-ink-2">
              The first decline stops evaluation. A human is asked only when every hard rule has
              passed. Each decision comes with a trace naming every rule and the numbers it used,
              and any error inside the engine means declined.
            </p>
            <ButtonLink
              href="/docs#how-a-payment-request-is-decided"
              variant="secondary"
              className="mt-6"
            >
              How each rule works
            </ButtonLink>
          </div>
          <ol className="divide-y divide-rule rounded-xl border border-rule bg-surface">
            {RULES.map(([name, detail, outcome], i) => (
              <li
                key={name}
                className="grid grid-cols-[2rem_1fr_auto] items-start gap-3 px-4 py-3 sm:px-5"
              >
                <span className="tabular pt-0.5 font-mono text-sm text-ink-3">{i + 1}</span>
                <span className="min-w-0">
                  <span className="font-medium text-ink">{name}</span>
                  <span className="block text-sm text-ink-2">{detail}</span>
                </span>
                <Pill
                  tone={
                    outcome === 'declined' ? 'declined' : outcome === 'review' ? 'review' : 'accent'
                  }
                >
                  {outcome === 'note' ? 'cancellable' : outcome}
                </Pill>
              </li>
            ))}
          </ol>
        </section>

        {/* Human control */}
        <section className="border-y border-rule bg-sunken">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 className="font-serif text-3xl leading-tight tracking-[-0.015em] sm:text-4xl">
                You hold the off switch.
              </h2>
              <p className="mt-4 max-w-[52ch] text-ink-2">
                Approve or decline what waits for you, cancel a first payment within ten minutes,
                freeze one agent, or stop every agent at once. Each action is a signed ledger entry
                that records who acted and why, and it applies to the agent’s very next request.
              </p>
            </div>
            <ul className="space-y-3">
              {(
                [
                  [
                    Hand,
                    'Approve or decline',
                    'CHF 6,500.00 to Example Labware AG is waiting for you.',
                    'review',
                  ],
                  [
                    CircleSlash,
                    'Cancel during cooling-off',
                    'First payment to Example Reagents AG, cancellable until 10:43.',
                    'accent',
                  ],
                  [
                    Snowflake,
                    'Freeze one agent',
                    'office-supplies is frozen; its requests are declined.',
                    'declined',
                  ],
                  [
                    Power,
                    'Kill switch',
                    'Off. One click declines every request from every agent.',
                    'neutral',
                  ],
                ] as const
              ).map(([Icon, title, text, tone]) => (
                <li
                  key={title}
                  className="flex items-start gap-3 rounded-xl border border-rule bg-surface px-4 py-3"
                >
                  <Icon size={18} className="mt-0.5 shrink-0 text-ink-2" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-ink">{title}</span>
                    <span className="block text-sm text-ink-2">{text}</span>
                  </span>
                  <Pill tone={tone}>
                    {tone === 'accent' ? 'open' : tone === 'neutral' ? 'off' : tone}
                  </Pill>
                </li>
              ))}
              <li className="text-xs text-ink-3">Example states from the sandbox. Fictional.</li>
            </ul>
          </div>
        </section>

        {/* Proof */}
        <section className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <h2 className="font-serif text-3xl leading-tight tracking-[-0.015em] sm:text-4xl">
              Every decision leaves a receipt an auditor can check.
            </h2>
            <p className="mt-4 max-w-[52ch] text-ink-2">
              Each ledger entry hashes the one before it, so changing, removing or reordering any
              entry breaks the chain. Each hash is signed with your issuer key. Anyone holding only
              the public key can verify a receipt offline.
            </p>
          </div>
          <pre className="tabular overflow-x-auto rounded-xl border border-rule bg-surface p-5 font-mono text-[0.78rem] leading-relaxed text-ink-2">
            {`{
  "format": "flow-e-receipt/v1",
  "issuer": "flow-e-issuer:9e03f943fd0a270d",
  "entry": {
    "seq": 3,
    "type": "payment.decision",
    "agent_id": "lab-procurement",
    "data": { "decision": "review", "rule": "APPROVAL_THRESHOLD", … },
    "prev_hash": "6fbd1c0e…c41a07",
    "hash": "8c08deba…b0b76b"
  },
  "signature": "Ed25519 · base64url"
}`}
            <span className="mt-3 block font-sans text-xs text-ink-3">
              Shortened example receipt from the sandbox.
            </span>
          </pre>
        </section>

        {/* Security and roadmap */}
        <section className="border-t border-rule bg-surface">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="font-serif text-2xl tracking-[-0.015em] sm:text-3xl">
                Security, stated plainly
              </h2>
              <ul className="mt-5 space-y-3 text-ink-2">
                <li>
                  The model only sees tool results: never keys, credentials or other agents’
                  payments.
                </li>
                <li>
                  Issuer keys are Ed25519; credentials are checked against your public key on every
                  request.
                </li>
                <li>
                  The ledger is append-only and every entry is signed; an audit names the first
                  broken entry.
                </li>
                <li>
                  Fails closed: an engine error, a broken mandate or a missing credential means
                  declined.
                </li>
                <li>Known limits are documented, including what an audit alone cannot see.</li>
              </ul>
              <Link href="/docs#security-model" className="mt-5 inline-block text-accent underline">
                Read the full security model
              </Link>
            </div>
            <div>
              <h2 className="font-serif text-2xl tracking-[-0.015em] sm:text-3xl">
                Where it is going
              </h2>
              <p className="mt-5 text-ink-2">
                <span className="font-medium text-ink">Today:</span> the open-source engine,
                credentials, signed ledger, MCP server, human controls, and this sandbox.
              </p>
              <p className="mt-3 text-ink-2">
                <span className="font-medium text-ink">Next:</span> a hosted team dashboard with
                accounts, real payment rails through adapters, live exchange rates and sanctions
                screening, money as a flow with escrow, and an exchange where agents trade on
                escrow-backed demand.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink href="/sandbox">Try the sandbox</ButtonLink>
                <a
                  href={GITHUB_URL}
                  className="inline-flex h-10 items-center rounded-lg px-2 text-sm font-medium text-ink-2 hover:text-ink"
                >
                  Source on GitHub
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
