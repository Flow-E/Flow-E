import 'server-only';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * Guard against server-side request forgery for webhook addresses: Flow-E only calls public
 * https addresses. Checked twice: when an address is saved (its form), and at every delivery
 * (the resolved addresses, inside the connection's own DNS lookup, so a name that later points
 * to an internal address is refused too).
 */

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64, may reach IPv4 inside
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

/** True for any address Flow-E must not call: private, loopback, link-local, reserved. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return blocked.check(address, 'ipv4');
}

/** The address's problem in plain words, or null when it may be saved. No DNS here. */
export function webhookUrlProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return 'Enter a full address, starting with https://';
  }
  if (url.protocol !== 'https:') return 'Only https addresses are allowed.';
  if (url.username !== '' || url.password !== '') return 'Leave out a user name or password.';
  if (url.port !== '' && url.port !== '443') return 'Only the standard https port (443).';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) {
    return isBlockedAddress(host) ? 'Private or internal addresses are not allowed.' : null;
  }
  if (
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i.test(host)
  ) {
    return 'Use a public address, not an internal name.';
  }
  return url.toString().length > 500 ? 'That address is too long.' : null;
}

export class BlockedAddressError extends Error {
  override name = 'BlockedAddressError';
}

/**
 * A DNS lookup for http(s).request that refuses blocked addresses. Every address the name
 * resolves to must be public; then the connection uses the first one.
 */
export function safeLookup(
  hostname: string,
  options: { all?: boolean } | number | undefined,
  callback: (...args: unknown[]) => void,
): void {
  const all = typeof options === 'object' && options.all === true;
  lookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      callback(new BlockedAddressError('The address resolves to a private or internal network.'));
      return;
    }
    const first = addresses[0];
    if (all) callback(null, addresses);
    else callback(null, first?.address ?? '', first?.family ?? 4);
  });
}
