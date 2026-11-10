// Copy only DNS and routing policy from this supplier's Clash-Meta profile.
// Do not pass through proxy providers, controller settings, subscription URLs,
// or arbitrary rule targets: those may expose the upstream account or break a
// branded profile. A failed/unsupported policy leaves the existing profile in
// place; it must not make a working subscription fail.
import { load, JSON_SCHEMA } from 'js-yaml';

const MAX_BYTES = 512 * 1024;
const DNS_KEYS = new Set(['enable', 'ipv6', 'default-nameserver', 'enhanced-mode',
  'fake-ip-range', 'use-hosts', 'respect-rules', 'proxy-server-nameserver',
  'nameserver', 'fallback', 'fallback-filter']);
const RULE_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'GEOIP']);

export function policyUrl(source) {
  try {
    const u = new URL(source);
    // This parameter combination was verified for this panel, not arbitrary
    // suppliers. Do not guess another supplier's format or send it new queries.
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hostname !== 'xn--9kqs1lo79d.cc' || u.pathname !== '/api/v1/chuixue') return null;
    u.searchParams.set('type', 'clash');
    u.searchParams.set('flag', 'meta');
    return u.toString();
  } catch { return null; }
}

export function extractSupplierPolicy(text, source) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) return null;
  try {
    const doc = load(text, { schema: JSON_SCHEMA });
    if (!doc || typeof doc !== 'object' || !doc.dns || typeof doc.dns !== 'object' || Array.isArray(doc.dns) ||
        !Array.isArray(doc.rules) || !doc.rules.length || doc.rules.length > 2000 || !Array.isArray(doc['proxy-groups'])) return null;
    if (Object.keys(doc.dns).some(k => !DNS_KEYS.has(k))) return null;
    const root = doc['proxy-groups'].find(g => g && g.type === 'select' && typeof g.name === 'string');
    if (!root || !root.name || root.name.includes(',')) return null;
    const u = new URL(source);
    const secrets = [u.hostname, ...Array.from(u.searchParams.values()).filter(v => v.length >= 8)];
    // DNS should consist of data, not endpoints containing credentials or
    // provider URLs. This verified supplier uses IP addresses and plain names.
    function safeDns(v, depth = 0) {
      if (depth > 8) return false;
      if (v === null || typeof v === 'boolean' || typeof v === 'number') return true;
      if (typeof v === 'string') return v.length < 256 && !/[?@#]/.test(v) && !v.includes('://') && !secrets.some(s => v.includes(s));
      if (Array.isArray(v)) return v.length < 100 && v.every(x => safeDns(x, depth + 1));
      if (typeof v === 'object') return Object.keys(v).length < 100 && Object.entries(v).every(([k, x]) => /^[a-zA-Z0-9_-]+$/.test(k) && safeDns(x, depth + 1));
      return false;
    }
    if (!safeDns(doc.dns)) return null;
    let omittedBrandRule = false;
    const rules = [];
    for (const rule of doc.rules) {
      if (typeof rule !== 'string' || rule.length > 512 || /[\r\n]/.test(rule)) return null;
      const parts = rule.split(',');
      const match = parts[0] === 'MATCH';
      if (match ? parts.length !== 2 : !RULE_TYPES.has(parts[0]) || parts.length < 3 || parts.length > 4) return null;
      const targetIndex = match ? 1 : 2;
      const target = parts[targetIndex];
      if (target !== root.name && target !== 'DIRECT' && target !== 'REJECT') return null;
      if (parts.length === 4 && parts[3] !== 'no-resolve') return null;
      // The panel emits a malformed domain containing its own brand. Publishing
      // it would reveal the supplier name; omit this one rule rather than leak it.
      if (!match && (parts[1].includes(root.name) || secrets.some(s => parts[1].includes(s)))) {
        omittedBrandRule = true;
        continue;
      }
      parts[targetIndex] = target === root.name ? null : target;
      rules.push(parts);
    }
    if (!rules.some(r => r[0] === 'MATCH' && r[1] === null)) return null;
    return { dns: doc.dns, rules, omittedBrandRule };
  } catch { return null; }
}

export async function fetchSupplierPolicy(source, fetcher = fetch) {
  const url = policyUrl(source);
  if (!url) return null;
  try {
    const res = await fetcher(url, { headers: { 'User-Agent': 'clash.meta' }, signal: AbortSignal.timeout(3500) });
    if (!res.ok || Number(res.headers.get('content-length') || 0) > MAX_BYTES || !res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let size = 0, text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); return null; }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    return extractSupplierPolicy(text, source);
  } catch { return null; }
}
