import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import worker from '../sp-vpn-worker.js';
import * as store from '../token-store.js';
import { extractSupplierPolicy, policyUrl, fetchSupplierPolicy } from '../supplier-policy.js';

// Synthetic fixture based on the observed structure, no real account data.
const source = 'https://xn--9kqs1lo79d.cc/api/v1/chuixue?token=FAKESECRET123';
const profile = `
mixed-port: 7890
dns:
  enable: true
  ipv6: true
  default-nameserver: [223.5.5.5, 119.29.29.29, 114.114.114.114]
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  use-hosts: true
  respect-rules: true
  proxy-server-nameserver: [223.5.5.5, 119.29.29.29, 114.114.114.114]
  nameserver: [223.5.5.5, 119.29.29.29, 114.114.114.114]
  fallback: [1.1.1.1, 8.8.8.8]
  fallback-filter: { geoip: true, geoip-code: CN, geosite: [gfw], ipcidr: [240.0.0.0/4], domain: [+.google.com, +.facebook.com, +.youtube.com] }
proxies: []
proxy-groups:
  - { name: SupplierBrand, type: select, proxies: [automatic] }
  - { name: automatic, type: url-test, proxies: [], url: 'http://www.gstatic.com/generate_204', interval: 86400 }
rules:
  - 'IP-CIDR,1.1.1.1/32,SupplierBrand,no-resolve'
  - 'DOMAIN,example.com,DIRECT'
  - 'DOMAIN-KEYWORD,ads,REJECT'
  - 'DOMAIN-SUFFIX,smartdnsSupplierBrand.com,SupplierBrand'
  - 'IP-CIDR6,2001:db8::/32,SupplierBrand,no-resolve'
  - 'GEOIP,CN,DIRECT'
  - 'MATCH,SupplierBrand'
`;
const parse = () => extractSupplierPolicy(profile, source);

test('extracts DNS and ordered routing rules, redacting provider branding', () => {
  const p = parse();
  assert.ok(p);
  assert.deepEqual(p.dns, yaml.load(profile).dns);
  assert.equal(p.omittedBrandRule, true);
  assert.deepEqual(p.rules, [
    ['IP-CIDR','1.1.1.1/32',null,'no-resolve'],
    ['DOMAIN','example.com','DIRECT'], ['DOMAIN-KEYWORD','ads','REJECT'],
    ['IP-CIDR6','2001:db8::/32',null,'no-resolve'], ['GEOIP','CN','DIRECT'], ['MATCH',null],
  ]);
  assert.ok(!JSON.stringify(p).includes('SupplierBrand'));
});

test('refuses unsafe and unsupported policies rather than publishing credentials or broken targets', async () => {
  assert.equal(policyUrl('https://example.org/sub?token=123'), null);
  assert.equal(extractSupplierPolicy(profile.replace('example.com,DIRECT', 'example.com,unknown'), source), null);
  assert.equal(extractSupplierPolicy(profile.replace('nameserver: [223.5.5.5, 119.29.29.29, 114.114.114.114]', 'nameserver: ["https://user:pass@other.test/dns?token=secret"]'), source), null);
  assert.equal(extractSupplierPolicy('garbage', source), null);
  assert.equal(await fetchSupplierPolicy(source, async () => new Response('not yaml', {status: 403})), null);
});

test('both subscription routes use the policy; share links, fallback, opt-out and revocation stay safe', async () => {
  store.setBackend(new store.MemoryBackend());
  await store.ensureInit();
  const t = await store.mint(source, 'fixture');
  const direct = 'vless://fake-id@node.example:443?security=tls#Japan';
  const originalFetch = globalThis.fetch;
  let policyFetches = 0;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.searchParams.get('type') === 'clash') { policyFetches++; return new Response(profile); }
    return new Response(direct);
  };
  try {
    const get = path => worker.fetch(new Request('https://hub.example' + path), {}, {});
    const response = await get(`/all/SP%20VPN?t=${t}&fmt=yaml`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-spvpn-dns-routing'), 'supplier');
    const text = await response.text();
    const doc = yaml.load(text);
    assert.deepEqual(doc.dns, yaml.load(profile).dns);
    assert.deepEqual(doc.rules, [
      'IP-CIDR,1.1.1.1/32,🚀 SP VPN,no-resolve', 'DOMAIN,example.com,DIRECT',
      'DOMAIN-KEYWORD,ads,REJECT', 'IP-CIDR6,2001:db8::/32,🚀 SP VPN,no-resolve',
      'GEOIP,CN,DIRECT', 'MATCH,🚀 SP VPN',
    ]);
    for (const secret of ['FAKESECRET123', 'SupplierBrand', 'xn--9kqs1lo79d.cc']) assert.ok(!text.includes(secret));
    const sub = await get(`/sub/${t}`);
    assert.equal(sub.headers.get('x-spvpn-dns-routing'), 'supplier');
    assert.deepEqual(yaml.load(await sub.text()).dns, doc.dns);
    assert.equal(policyFetches, 1, 'policy is cached');
    const diag = await get(`/diag?t=${t}&fmt=yaml`);
    const d = await diag.json();
    assert.equal(d.yaml.mode, 'supplier-dns-routing');
    assert.equal(d.yaml.guard.ok, true);
    assert.equal(d.yaml.supplierIdentifyingRuleOmitted, true);
    const global = await get(`/all/SP?t=${t}&fmt=yaml&policy=global`);
    assert.equal(global.headers.get('x-spvpn-dns-routing'), 'converter-fallback');
    assert.deepEqual(yaml.load(await global.text()).dns.nameserver, ['1.1.1.1', '8.8.8.8', '9.9.9.9']);
    const share = await get(`/all/SP?t=${t}&fmt=sr`);
    assert.ok(Buffer.from(await share.text(), 'base64').toString().includes('vless://'));
    assert.equal(policyFetches, 1);
    const badToken = await store.mint(source + '&different=1', 'failed policy');
    globalThis.fetch = async (u) => new URL(u).searchParams.has('type') ? new Response('bad', {status: 503}) : new Response(direct);
    const fallback = await get(`/all/SP?t=${badToken}&fmt=yaml`);
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get('x-spvpn-dns-routing'), 'converter-fallback');
    assert.deepEqual(yaml.load(await fallback.text()).dns.nameserver, ['1.1.1.1', '8.8.8.8', '9.9.9.9']);
    await store.updateRow(t, { revoked: true });
    assert.notEqual((await get(`/sub/${t}`)).status, 200);
  } finally { globalThis.fetch = originalFetch; }
});
