// Side-by-side: the ORIGINAL worker (from sp-global) vs the PATCHED one,
// running the exact attack a student would run.
const enc = encodeURIComponent;
const SUP = "https://airport-panel.example.com/api/v1/client/subscribe?token=SUPER-SECRET-abc123";
const BODY = ["STATUS=↑:1.23GB,↓:45.67GB,TOT:200GB Expires:2027-01-01",
  "vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Xy3k9qP2mZ8sL4vN7cQ1wE6rT5yU0iO9pA3sD2fG8hI%3D&sid=6a1b&type=tcp&flow=xtls-rprx-vision#" + enc("香港•移联01")].join("\n");
globalThis.fetch = async () => new Response(BODY);

const b64e = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s) => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return decodeURIComponent(escape(atob(s))); };

const attack = async (label, oneLink) => {
  const t = new URL(oneLink).searchParams.get("t");
  console.log(`\n${"─".repeat(74)}\n${label}\n${"─".repeat(74)}`);
  console.log(`link the student holds :\n  ${oneLink}\n`);
  console.log("student runs atob() on the ?t= value:");
  let out;
  try {
    out = b64d(t);
    const hit = out === SUP;
    console.log(`  -> ${JSON.stringify(out.slice(0, 78))}${out.length > 78 ? "…" : ""}`);
    console.log(hit ? "  💥 YOUR SUPPLIER URL, EXACTLY — they can now buy direct and leave you out"
                    : "  ✅ meaningless bytes — nothing to reuse");
  } catch (e) {
    out = null;
    console.log(`  -> throws: ${e.message.slice(0, 60)}`);
    console.log("  ✅ not even valid base64 of anything meaningful");
  }
  return out === SUP;
};

// ORIGINAL: replicate what sp-global does (token = base64url(supplier url))
const originalLink = `https://sp.example.com/all/SP%20VPN?t=${encodeURIComponent(b64e(SUP))}`;

// PATCHED: run the real modified worker through /admin/mint
const patched = (await import("../sp-vpn-worker.js")).default;
const store = await import("../token-store.js");
store.setBackend(new store.MemoryBackend());
await store.ensureInit();
const mintRes = await patched.fetch(new Request("https://sp.example.com/admin/mint", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ link: SUP, label: "Ali — 3mo" }).toString(),
}), {}, {});
const minted = JSON.parse(await mintRes.text());
const patchedLink = `https://sp.example.com/all/SP%20VPN?t=${minted.token}`;

const leakedBefore = await attack("BEFORE — sp-global as it is today", originalLink);
const leakedAfter = await attack("AFTER — this fix", patchedLink);

// and confirm the patched link still serves the VPN correctly
const clash = await patched.fetch(new Request(patchedLink, { headers: { "User-Agent": "clash-verge/1.7.7" } }), {}, {});
const yaml = await clash.text();

console.log(`\n${"═".repeat(74)}`);
console.log(`  original leaks supplier URL : ${leakedBefore ? "YES 💥" : "no"}`);
console.log(`  patched  leaks supplier URL : ${leakedAfter ? "YES 💥" : "NO ✅"}`);
console.log(`  patched still serves VPN    : ${clash.status === 200 && yaml.includes("proxies:") ? "YES ✅ (HTTP 200, valid mihomo YAML)" : "NO ❌"}`);
console.log(`${"═".repeat(74)}\n`);
process.exit(leakedBefore && !leakedAfter && clash.status === 200 ? 0 : 1);
