// Admin lock: every /admin route must require the ADMIN_PASSWORD cookie.
import w from "../sp-vpn-worker.js";
const env={ADMIN_PASSWORD:"s3cret-pass"};
const R=(p,o={})=>new Request("https://x.app"+p,o);
let f=0; const ok=(c,m)=>{console.log((c?"✅":"❌")+" "+m); if(!c)f++;};

let r=await w.fetch(R("/admin/dashboard"),env,{});
ok(r.status===401,"dashboard without cookie -> 401 ("+r.status+")");
ok((await r.text()).includes("Admin sign in"),"shows login form");

r=await w.fetch(R("/admin/dashboard.json"),env,{});
ok(r.status===401 && (await r.json()).error==="unauthorized","dashboard.json -> 401 json");

r=await w.fetch(R("/admin/login",{method:"POST",body:"password=wrong&next=/admin/dashboard"}),env,{});
ok(r.status===401,"wrong password rejected");

r=await w.fetch(R("/admin/login",{method:"POST",body:"password=s3cret-pass&next=/admin/dashboard"}),env,{});
const sc=r.headers.get("set-cookie")||"";
ok(r.status===302 && r.headers.get("location")==="/admin/dashboard","correct password -> redirect");
ok(/HttpOnly/i.test(sc)&&/Secure/i.test(sc)&&/SameSite=Lax/i.test(sc),"cookie HttpOnly+Secure+SameSite");
ok(!sc.includes("s3cret-pass"),"cookie does not contain the password");
const cookie=sc.split(";")[0];

r=await w.fetch(R("/admin/dashboard",{headers:{cookie}}),env,{});
ok(r.status===200,"dashboard with cookie -> 200 ("+r.status+")");

r=await w.fetch(R("/admin/login",{method:"POST",body:"password=s3cret-pass&next=https://evil.com"}),env,{});
ok(r.headers.get("location")==="/admin/dashboard","open-redirect blocked");

r=await w.fetch(R("/admin/logout",{headers:{cookie}}),env,{});
ok((r.headers.get("set-cookie")||"").includes("Max-Age=0"),"logout clears cookie");

r=await w.fetch(R("/admin/dashboard"),{},{});
ok(r.status===503 && (await r.text()).includes("ADMIN_PASSWORD"),"no password configured -> locked setup page");

r=await w.fetch(R("/"),env,{});
ok(r.status===200,"public homepage still open ("+r.status+")");
r=await w.fetch(R("/healthz"),env,{});
ok(r.status===200,"/healthz still open");
r=await w.fetch(R("/qr"),env,{});
ok(r.status===200,"/qr still open");
console.log(f?("\n"+f+" FAILED"):"\n🎉 all admin-lock checks passed");
process.exit(f?1:0);
