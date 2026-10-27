import Link from 'next/link';

/** Under a receipt: where anyone can check it (the public /verify page, no sign-in). */
export function ShareReceipt({ origin }: { origin: string }) {
  return (
    <p className="mt-3 text-sm text-ink-2">
      Share this receipt; anyone can check it at{' '}
      <Link href="/verify" className="break-all text-accent underline">
        {origin}/verify
      </Link>
      .
    </p>
  );
}
