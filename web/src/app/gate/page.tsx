import type { Metadata } from 'next';
import { Logo } from '@/components/ui';
import { safeNext } from '@/server/gate';
import { GateForm } from './gate-form';

export const metadata: Metadata = { title: 'Private preview' };

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <Logo />
        <h1 className="mt-8 font-serif text-3xl tracking-[-0.015em]">Private preview</h1>
        <p className="mt-2 text-ink-2">
          Flow-E is being tested. Enter the preview password you were given.
        </p>
        <GateForm next={safeNext(next)} />
      </div>
    </main>
  );
}
