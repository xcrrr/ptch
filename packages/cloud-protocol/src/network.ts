/** True for addresses that are not reachable from the public internet by themselves. */
export function isPrivateBindAddress(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  if (/^127\./.test(h)) return true;
  // Tailscale gives every device an address in 100.64.0.0/10 (carrier-grade NAT space).
  const cgnat = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (cgnat) {
    const second = Number(cgnat[1]);
    return second >= 64 && second <= 127;
  }
  // Tailscale IPv6: fd7a:115c:a1e0::/48
  return h.startsWith('fd7a:115c:a1e0:');
}

/**
 * Hosts a client may reach over plain HTTP without exposing its token: this machine, a Tailscale
 * address or MagicDNS name (traffic inside the tailnet is encrypted), or a single-label name.
 * Anything else must use HTTPS.
 */
export function isPrivateHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return isPrivateBindAddress(h) || h.endsWith('.ts.net') || (!h.includes('.') && !h.includes(':'));
}
