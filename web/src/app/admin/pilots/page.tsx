import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pill, buttonClass, type Tone } from '@/components/ui';
import { dateTime } from '@/lib/format';
import {
  PILOT_SIZES,
  isPilotAdmin,
  listPilotRequests,
  type PilotRequest,
  type PilotStatus,
} from '@/server/pilot';
import { getDb } from '@/server/runtime';
import { getSession } from '@/server/session';
import { markPilot } from './actions';

export const metadata: Metadata = { title: 'Pilot requests', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TZ = 'Europe/Zurich';
const TONE: Record<PilotStatus, Tone> = {
  new: 'accent',
  contacted: 'approved',
  declined: 'neutral',
};

/**
 * Pilot requests from the home page form, newest first. Only for signed-in people whose email
 * is in FLOWE_ADMIN_EMAILS; everyone else, signed in or not, gets the same 404.
 */
export default async function PilotsPage() {
  const session = await getSession();
  if (!isPilotAdmin(session)) notFound();
  const requests = await listPilotRequests(await getDb());
  const open = requests.filter((r) => r.status === 'new').length;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Link href="/" className="text-sm text-ink-2 hover:text-ink">
        Flow-E
      </Link>
      <h1 className="mt-2 font-serif text-3xl tracking-[-0.015em] sm:text-4xl">Pilot requests</h1>
      <p className="mt-2 text-ink-2">
        {requests.length === 0
          ? 'No requests yet.'
          : `${String(requests.length)} in total, ${String(open)} not answered yet. Newest first. Times in ${TZ}.`}
      </p>
      <ol className="mt-8 space-y-4">
        {requests.map((r) => (
          <PilotItem key={r.id} r={r} />
        ))}
      </ol>
    </main>
  );
}

function PilotItem({ r }: { r: PilotRequest }) {
  const size = PILOT_SIZES.find((s) => s.value === r.size)?.label ?? r.size;
  return (
    <li className="rounded-xl bg-surface px-4 py-4 sm:px-6 sm:py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink">
            {r.company}
            <span className="font-normal text-ink-2"> · {size}</span>
          </h2>
          <p className="text-ink-2">
            {r.name}, {r.role}
            {r.country ? ` · ${r.country}` : ''}
          </p>
          <a href={`mailto:${r.email}`} className="break-all text-accent underline">
            {r.email}
          </a>
        </div>
        <div className="text-right">
          <Pill tone={TONE[r.status]}>{r.status}</Pill>
          <p className="mt-1 text-sm text-ink-3">{dateTime(r.created_at, TZ)}</p>
        </div>
      </div>
      <dl className="mt-4 space-y-3">
        <div>
          <dt className="text-sm font-medium text-ink">Agents should buy</dt>
          <dd className="whitespace-pre-wrap break-words text-ink-2">{r.buying}</dd>
        </div>
        {r.message ? (
          <div>
            <dt className="text-sm font-medium text-ink">Message</dt>
            <dd className="whitespace-pre-wrap break-words text-ink-2">{r.message}</dd>
          </div>
        ) : null}
      </dl>
      <form action={markPilot} className="mt-4 flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={r.id} />
        {r.status !== 'contacted' ? (
          <button name="status" value="contacted" className={buttonClass('secondary', 'sm')}>
            Mark contacted
          </button>
        ) : null}
        {r.status !== 'declined' ? (
          <button name="status" value="declined" className={buttonClass('quiet', 'sm')}>
            Mark declined
          </button>
        ) : null}
        {r.status !== 'new' ? (
          <button name="status" value="new" className={buttonClass('quiet', 'sm')}>
            Back to new
          </button>
        ) : null}
        {r.status_changed_by && r.status_changed_at ? (
          <span className="text-sm text-ink-3">
            {r.status} by {r.status_changed_by}, {dateTime(r.status_changed_at, TZ)}
          </span>
        ) : null}
      </form>
    </li>
  );
}
