#!/usr/bin/env node
// ============================================================================
// verify-live — is the deployed site running the profile this repo builds?
//
// Why: on 2026-11-10 customers on Clash Meta / Clash Verge reported the
// converted link timing out while the raw supplier link worked. The repo was
// correct — `npm test` passed — but the *deployed* build predated the fix, so
// it was still handing out CN-only DNS resolvers and GeoIP rules. A liveness
// probe says "up". Only the served profile says "wrong".
//
// So this checks the profile, using the repo's own definition of correct
// (checkProfile, imported from the worker under test) against whatever the live
// host actually returns. One source of truth, nothing to keep in sync.
//
//   node bin/verify-live.mjs https://sp-vpn.netlify.app --token=<48-hex>
//   node bin/verify-live.mjs http://localhost:8787 --token=<t>
//   npm run verify -- --host=https://… --token=…
//
// Exit 0 = the live build is safe to hand out. Exit 1 = deploy, or the
// regression is real. Prints the offending lines either way.
// ============================================================================
import { checkProfile } from "../sp-vpn-worker.js";

const argv = process.argv.slice(2);
const flag = (name, dflt = "") => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const base = (argv.find((a) => /^https?:\/\//.test(a)) || flag("host")).replace(/\/+$/, "");
const token = flag("token");
const brand = flag("brand", "SP VPN");
const TIMEOUT = Number(flag("timeout", 25000));

if (!base) {
  console.error("usage: node bin/verify-live.mjs <base-url> [--token=<link-token>] [--brand='SP VPN']");
  console.error("       token is optional — without it only /healthz is checked, which is enough");
  console.error("       to tell whether the deployed build has the Clash profile fix.");
  process.exit(2);
}

const CLASH_UA = "clash-verge/v1.7.7";
const results = [];
const record = (name, ok, detail = "") => { results.push({ name, ok, detail }); return ok; };

const get = async (path, headers = {}) => {
  const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(TIMEOUT), redirect: "manual" });
  return { res, text: await res.text() };
};

const line = (s) => console.log("  " + s);
const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", OFF = "\x1b[0m";
const mark = (ok) => (ok ? `${GREEN}✅${OFF}` : `${RED}❌${OFF}`);

console.log(`\nverifying ${base}\n${"─".repeat(64)}`);

// ---------------------------------------------------------------- 1. healthz
let health = null;
try {
  const { res, text } = await get("/healthz?full=1", { accept: "application/json" });
  try { health = JSON.parse(text); } catch (e) { health = null; }
  if (!health) {
    // Old builds answer /healthz with the literal "ok" — no profile data at all.
    record("deployment reports its profile policy", false,
      `GET /healthz returned ${res.status} ${DIM}${text.slice(0, 40).trim()}${OFF} — this build predates the profile guard, so it cannot be verified remotely. Redeploy from this repo.`);
  } else {
    record("deployment reports its profile policy", true, `${DIM}${health.profile || "(no profile field)"}${OFF}`);
    if (health.ok === false) {
      const probs = (health.problems || []).map((p) => p.code).join(", ") || "unspecified";
      record("live profile passes the guard", false, `${probs}\n${(health.problems || []).map((p) => `     ${p.msg}`).join("\n")}`);
    } else {
      record("live profile passes the guard", true);
    }
    record("no GeoIP download needed on import", !health.needsGeoipDownload,
      health.needsGeoipDownload ? `${RED}fresh installs block on a geodata fetch the client cannot make${OFF}` : "");
    record("resolvers are not China-only", !health.cnOnlyDns,
      health.cnOnlyDns ? `${RED}223.5.5.5/119.29.29.29 — every lookup times out outside China${OFF}` : "");
    record("⚡ Auto Speed is the default selection", health.autoSpeedFirst !== false);
    record("a manual pick is not remembered forever", health.storeSelectedOff !== false);
  }
} catch (e) {
  record("host reachable", false, String(e.message || e));
}

// ------------------------------------------------------------- 2. live YAML
if (token) {
  try {
    const { res, text } = await get(`/all/${encodeURIComponent(brand)}?t=${encodeURIComponent(token)}&fmt=yaml`, { "user-agent": CLASH_UA });
    if (!text.trim().startsWith("#") && !/^mixed-port/m.test(text)) {
      record("Clash UA receives a YAML profile", false, `HTTP ${res.status}, body starts: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
    } else {
      record("Clash UA receives a YAML profile", true);
      // The real check: run THIS repo's guard over the bytes that host served.
      const g = checkProfile(text, {});
      record("served profile passes this repo's guard", g.ok,
        g.ok ? "" : "\n" + g.problems.map((p) => `     ${p.code}: ${p.msg}`).join("\n"));
      const got = res.headers.get("x-spvpn-profile");
      record("served profile matches repo policy",
        got === null ? true : !String(got).startsWith("STALE"),
        got === null ? `${DIM}(no X-SPVPN-Profile header — stale build)${OFF}` : DIM + got + OFF);
      const proxies = (text.match(/^- name: /gm) || []).length;
      record("profile contains nodes", proxies > 0, `${proxies} proxy entries`);
      const leak = /api\/v1\/(client\/subscribe|chuixue)\?token=[A-Za-z0-9]/.test(text);
      record("no supplier URL in the profile", !leak, leak ? `${RED}supplier subscription URL is being echoed to clients${OFF}` : "");
    }
  } catch (e) {
    record("subscription route reachable", false, String(e.message || e));
  }

  try {
    const { text } = await get(`/all/${encodeURIComponent(brand)}?t=${encodeURIComponent(token)}`, { "user-agent": "Shadowrocket/2.2.32" });
    let decoded = "";
    try { decoded = Buffer.from(text.trim(), "base64").toString("utf8"); } catch (e) { /* not b64 */ }
    const links = decoded.split(/\r?\n/).filter((l) => /^[a-z0-9+.-]+:\/\//i.test(l));
    const realLines = text.trim().split(/\r?\n/).filter((l) => l.trim()).length;
    record("base64 share list parses", links.length > 0, `${links.length} node link(s)${realLines > links.length ? DIM + ` · ${realLines - links.length} non-node line(s), tolerated by clients` : OFF}`);
  } catch (e) {
    record("base64 route reachable", false, String(e.message || e));
  }
} else {
  console.log(`${DIM}  (pass --token=<t> to also diff the exact YAML your customers receive)${OFF}`);
}

// ------------------------------------------------------------------ verdict
console.log(`${"─".repeat(64)}`);
for (const r of results) line(`${mark(r.ok)} ${r.name}${r.detail ? "  " + r.detail : ""}`);
const failed = results.filter((r) => !r.ok);
console.log(`${"─".repeat(64)}`);
// A socket that never connected is not evidence about a deployment. Sandboxes,
// CI runners and restricted networks commonly have no outbound TLS at all, and
// this script used to answer that with "the fix is not deployed" — which sends
// someone redeploying a build that was already correct. Sort that out first.
const unreachable = failed.length && failed.every((r) =>
  /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENET|certificate|SSL|TLS|socket hang up|aborted/i.test(r.detail));
if (unreachable) {
  console.log(`${RED}could not reach ${base}${OFF} — every request failed at the network layer, so`);
  console.log("  nothing here says whether the deployment is current. Re-run from a machine with");
  console.log("  ordinary outbound HTTPS, or check by eye — both are one line each:");
  console.log(`    curl -s ${base}/healthz | head -c 160`);
  console.log(`    curl -sL "${base}/all/<brand>?t=<token>&fmt=yaml" | head -5\n`);
  console.log("  In that YAML header, a `# latency probe:` line must be present, every group with");
  console.log("  nodes must carry a `url:`, and none of them may probe the core's own default");
  console.log("  (https://www.gstatic.com/generate_204 — mihomo hides that from the app, which is");
  console.log("  how a correct-looking config ends up showing no latency numbers at all).\n");
  process.exit(1);
}
if (failed.length) {
  console.log(`${RED}${failed.length} check(s) failed${OFF} — ${base} is not serving the profile this repo builds.\n`);
  console.log("  Most likely cause: the fix is merged but not deployed. Redeploy, then re-run:");
  console.log(`    npx wrangler deploy          # Cloudflare (recommended)`);
  console.log(`    netlify deploy --prod        # if you stay on Netlify`);
  console.log(`    curl -s ${base}/healthz | head -c 120\n`);
  process.exit(1);
}
console.log(`${GREEN}all ${results.length} checks passed${OFF} — the live build matches this repo's profile policy.\n`);
