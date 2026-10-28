/**
 * The examples on the "Connect your systems" page (/developers). Each one is data: the page
 * renders it as curl, and test/api-examples.test.ts runs every one against a test server, so
 * the page never shows an example that does not work. `{payment_id}` is filled in by the test
 * with a real payment.
 */

export interface ApiExample {
  id: string;
  title: string;
  method: 'GET' | 'POST';
  path: string;
  /** The permission the key needs. */
  scope: 'reorder:write' | 'read';
  body?: Record<string, unknown>;
  /** What a working call answers. */
  status: number;
  /** A shortened example answer, for the page. */
  answer: string;
}

export const API_EXAMPLES: ApiExample[] = [
  {
    id: 'signal',
    title: 'Suggest a reorder',
    method: 'POST',
    path: '/api/v1/reorder-signals',
    scope: 'reorder:write',
    body: {
      item_id: 'pipette-tips-20-racks--example-labware-ag',
      quantity: 3,
      unit: 'pack',
      reason: 'stock below minimum: 2 left',
      needed_by: '2026-11-30',
      idempotency_key: 'inventory-4711',
    },
    status: 201,
    answer: `{
  "suggestion_id": "6f1c…",
  "status": "suggested",
  "item": "Pipette tips, 20 racks",
  "price_item": "pipette-tips-20-racks--example-labware-ag",
  "supplier": "Example Labware AG",
  "quantity": 3,
  "message": "Added to the reorder list as a suggestion. Nothing is bought until a run asks Flow-E for it."
}`,
  },
  {
    id: 'signal-by-name',
    title: 'Suggest a reorder by item name',
    method: 'POST',
    path: '/api/v1/reorder-signals',
    scope: 'reorder:write',
    body: {
      item: 'Nitrile gloves, 10 boxes',
      quantity: 2,
      idempotency_key: 'inventory-4712',
    },
    status: 201,
    answer: `{ "status": "suggested", "item": "Nitrile gloves, 10 boxes", … }`,
  },
  {
    id: 'orders',
    title: 'List orders, newest first',
    method: 'GET',
    path: '/api/v1/orders?limit=20',
    scope: 'read',
    status: 200,
    answer: `{
  "data": [
    {
      "payment_id": "pay_…",
      "status": "approved",
      "supplier": "Example Labware AG",
      "item": "Pipette tips, 20 racks",
      "amount": "360.00",
      "currency": "CHF",
      "ordered": { "at": "2026-10-28T09:41:00.000Z", "reference": "PO-1042" },
      "invoice": null
    }
  ],
  "next_cursor": null
}`,
  },
  {
    id: 'payment',
    title: 'One payment',
    method: 'GET',
    path: '/api/v1/payments/{payment_id}',
    scope: 'read',
    status: 200,
    answer: `{ "payment_id": "pay_…", "status": "approved", "decision": "approved", "reason": "All rules passed.", … }`,
  },
  {
    id: 'receipt',
    title: 'The signed receipt of a payment',
    method: 'GET',
    path: '/api/v1/receipts/{payment_id}',
    scope: 'read',
    status: 200,
    answer: `{ "format": "flow-e-receipt/v1", "issuer": "flow-e-issuer:…", "entry": { … }, "signature": "…" }`,
  },
];

/** The receiver's side of a webhook, in Node.js. Run by the tests exactly as shown. */
export const VERIFY_WEBHOOK_SNIPPET = `import { createHmac, timingSafeEqual } from 'node:crypto';

// secret: the signing secret shown when you added the webhook
// header: the "Flow-E-Signature" request header
// body:   the raw request body, as text, before parsing it
export function verifyFloweSignature(secret, header, body, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > 300) return false; // older than 5 minutes
  const expected = createHmac('sha256', secret).update(t + '.' + body).digest('hex');
  const given = String(parts.v1 ?? '');
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}`;

export const WEBHOOK_PAYLOAD_EXAMPLE = `POST /your/address
Content-Type: application/json
Flow-E-Event: payment.approved
Flow-E-Delivery: 2b8e…
Flow-E-Signature: t=1793180000,v1=5d41402abc4b2a76b9719d911017c592…

{
  "id": "2b8e…",
  "event": "payment.approved",
  "created_at": "2026-10-28T09:40:02.000Z",
  "issuer": "flow-e-issuer:476cc78c17d76b3f",
  "entry": {
    "seq": 812,
    "id": "pay_…",
    "type": "payment.decision",
    "agent_id": "lab-consumables",
    "created_at": "2026-10-28T09:40:00.000Z",
    "data": {
      "payment_id": "pay_…",
      "request": { "merchant": "Example Labware AG", "amount": 36000, "currency": "CHF", "item": "Pipette tips, 20 racks", "quantity": 3 },
      "decision": "approved",
      "reason": "All rules passed.",
      …
    }
  },
  "receipt": { "format": "flow-e-receipt/v1", … }
}`;
