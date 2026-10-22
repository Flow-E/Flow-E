import { orgDownload } from '../download';

/** The organisation's issuer PUBLIC key (PEM), for verifying receipts offline (any member). */
export async function GET(_request: Request, { params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  return orgDownload(async (store, user) => ({
    body: await store.publicKey(org, user),
    type: 'application/x-pem-file; charset=utf-8',
    filename: 'issuer.pub',
  }));
}
