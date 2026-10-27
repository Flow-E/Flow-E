import { extractorFromEnv } from '@/server/invoice-extract';
import { MAX_INVOICE_FILE_BYTES } from '@/server/invoices';
import { getOrgStore } from '@/server/runtime';
import { getSession } from '@/server/session';

/**
 * Upload one invoice file (PDF, PNG or JPEG, up to 4 MB) for an organisation. The file is kept;
 * when ANTHROPIC_API_KEY is set its fields are read and sent back to fill the form. Nothing is
 * recorded in the ledger here: a person confirms the fields with the invoice form. Answers JSON.
 */

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** No Origin header (old browsers) passes; a foreign or opaque origin does not. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = [
    new URL(request.url).host,
    request.headers.get('host'),
    request.headers.get('x-forwarded-host'),
  ];
  return allowed.includes(host);
}

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  // Same-origin only: the session cookie must not let another site upload in the user's name.
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return json({ error: 'Not allowed.' }, 403);
  }
  if (!sameOrigin(request)) return json({ error: 'Not allowed.' }, 403);
  const session = await getSession();
  if (!session) return json({ error: 'Sign in first.' }, 401);
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_INVOICE_FILE_BYTES + 64 * 1024) {
    return json({ error: 'The file is larger than 4 MB.' }, 413);
  }
  const { org } = await params;
  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    return json({ error: 'Upload a PDF, PNG or JPEG file.' }, 400);
  }
  if (!(file instanceof File)) return json({ error: 'Upload a PDF, PNG or JPEG file.' }, 400);
  if (file.size > MAX_INVOICE_FILE_BYTES) {
    return json({ error: 'The file is larger than 4 MB.' }, 413);
  }
  try {
    const store = await getOrgStore();
    const result = await store.uploadInvoice(
      org,
      { userId: session.userId, email: session.email },
      { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
      extractorFromEnv(),
    );
    return json(result);
  } catch (err) {
    // By name: in development the cached store can come from an older copy of the modules.
    if (err instanceof Error && err.name === 'ForbiddenError')
      return json({ error: 'Not found.' }, 404);
    if (err instanceof Error && err.name === 'ActionError') {
      return json({ error: err.message }, 400);
    }
    console.error('invoice upload failed', err instanceof Error ? err.name : 'unknown');
    return json({ error: 'The upload did not work. Please try again.' }, 500);
  }
}
