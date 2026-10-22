import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink, Logo, buttonClass } from '@/components/ui';
import { loginUrl } from '@/lib/next-path';
import { ROLE_LABEL, ROLE_SUMMARY } from '@/server/permissions';
import { getOrgStore } from '@/server/runtime';
import { getSession } from '@/server/session';
import { acceptInvitationAction } from '../../app/actions';
import { signOut } from '../../login/actions';
import { ConfirmForm } from '../../app/client';

export const metadata: Metadata = { title: 'Invitation', robots: { index: false } };

/** Opening the link only shows the invitation; accepting is a separate POST while signed in. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await (await getOrgStore()).invitationPreview(token);
  const session = await getSession();
  const here = `/invite/${token}`;

  let body: React.ReactNode;
  if (!invitation) {
    body = <p className="text-ink-2">This invitation link is not valid. Ask for a new one.</p>;
  } else if (invitation.status !== 'pending') {
    body = (
      <p className="text-ink-2">
        This invitation was {invitation.status}. Ask an owner of {invitation.orgName} for a new one.
      </p>
    );
  } else {
    const intro = (
      <>
        <h1 className="mt-8 font-serif text-3xl tracking-[-0.015em]">Join {invitation.orgName}</h1>
        <p className="mt-2 text-ink-2">
          As <span className="font-medium text-ink">{ROLE_LABEL[invitation.role]}</span>:{' '}
          {ROLE_SUMMARY[invitation.role]}
        </p>
      </>
    );
    if (!session) {
      body = (
        <>
          {intro}
          <p className="mt-4 text-sm text-ink-2">
            Sign in as <span className="font-medium text-ink">{invitation.email}</span> to accept.
          </p>
          <ButtonLink href={loginUrl(here)} className="mt-4">
            Sign in to accept
          </ButtonLink>
        </>
      );
    } else if (session.email.toLowerCase() !== invitation.email) {
      body = (
        <>
          {intro}
          <p
            role="alert"
            className="mt-4 rounded-lg bg-decline-soft px-4 py-3 text-sm text-decline"
          >
            This invitation is for {invitation.email}, but you are signed in as {session.email}.
            Sign out, then open the link again and sign in with the invited address.
          </p>
          <form action={signOut} className="mt-4">
            <button type="submit" className={buttonClass('secondary')}>
              Sign out
            </button>
          </form>
        </>
      );
    } else {
      body = (
        <>
          {intro}
          <div className="mt-6">
            <ConfirmForm action={acceptInvitationAction} token={token} verb="accept" />
          </div>
        </>
      );
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-md">
        <Link href="/" aria-label="Flow-E home" className="rounded-md">
          <Logo />
        </Link>
        <div className="mt-2">{body}</div>
      </div>
    </main>
  );
}
