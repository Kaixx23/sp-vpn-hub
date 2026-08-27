import { createServer } from "node:http";
const enc = encodeURIComponent;
const day = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const node = (uuid, host, name) =>
  `vless://${uuid}@${host}:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Xy3k9qP2mZ8sL4vN7cQ1wE6rT5yU0iO9pA3sD2fG8hI%3D&sid=6a1b&type=tcp&flow=xtls-rprx-vision#` + enc(name);
const panel = (up, down, tot, exp) => [
  `STATUS=↑:${up}GB,↓:${down}GB,TOT:${tot}GB Expires:${exp}`,
  node("11111111-1111-4111-8111-111111111111", "hk1.spnode.example", "香港•移联01"),
  node("22222222-2222-4222-8222-222222222222", "hk2.spnode.example", "香港•移动01"),
  node("33333333-3333-4333-8333-333333333333", "sg1.spnode.example", "新加坡•电信01"),
  node("44444444-4444-4444-8444-444444444444", "jp1.spnode.example", "日本•移联01"),
].join("\n");
const P = {
  ali:   panel(12.4, 41.2, 200, day(52)),
  bao:   panel(88.1, 96.3, 200, day(5)),
  chen:  panel(3.2, 196.1, 200, day(-4)),
  devi:  panel(24.8, 30.1, 100, day(21)),
  emil:  panel(1.1, 4.4, 200, day(140)),
};
createServer((q, r) => {
  const w = new URL(q.url, "http://x").searchParams.get("who");
  r.setHeader("Content-Type", "text/plain");
  r.end(P[w] || "not found");
}).listen(9911, "0.0.0.0", () => console.log("demo supplier :9911"));
