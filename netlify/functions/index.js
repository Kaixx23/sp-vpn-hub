// SP VPN — Netlify Functions entry.
// Adapts a Netlify HTTP event to the worker's fetch(request) interface.
// All routes are rewritten to this function (see netlify.toml).
//
// IMPORTANT: Netlify Functions API v2 (the current runtime) calls a default
// export with a Web `Request` as the FIRST argument — not the legacy v1
// `event` object. The old code read `event.httpMethod` / `event.headers` /
// `event.rawPath`, which are all undefined on a Request, so every request was
// rebuilt as `GET https://localhost/` and every route (including the POST
// /rebrand and POST / converter forms) silently returned the homepage.
// This version supports BOTH signatures: v2 (Request, context) and v1
// ({httpMethod, headers, body, ...}) for older tooling such as netlify dev.
import worker from "../../sp-vpn-worker.js";

const isWebRequest = (input) =>
  typeof Request !== "undefined" && input instanceof Request;

// Normalize a Headers instance OR a plain v1 headers object into lowercase keys.
const normHeaders = (headers = {}) => {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === "function" && typeof headers.get === "function") {
    headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
};

// Build a worker-compatible Request from a legacy v1 event.
const requestFromV1Event = (event) => {
  const method = (event.httpMethod || "GET").toUpperCase();
  const headers = normHeaders(event.headers);
  let body = null;
  if (["POST", "PUT", "PATCH"].includes(method)) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "");
  }
  // event.rawUrl only exists on direct function calls; when netlify.toml
  // proxies a route to this function, rebuild the URL from the standard
  // fields (original path + querystring + Host header).
  let rawUrl = event.rawUrl;
  if (!rawUrl) {
    const proto = (headers["x-forwarded-proto"] || "https").split(",")[0];
    const host = headers["x-forwarded-host"] || headers["host"] || "localhost";
    const path = event.rawPath || event.path || "/";
    const qs = event.querystring ? "?" + event.querystring : "";
    rawUrl = `${proto}://${host}${path}${qs}`;
  }
  return new Request(rawUrl, { method, headers, body });
};

export default async (input) => {
  // API v2: input IS the incoming Web Request (original path/query preserved).
  const request = isWebRequest(input) ? input : requestFromV1Event(input);
  // Hand the runtime env to the worker so the token store can find
  // TOKEN_STORE_URL / TOKEN_STORE_AUTH_TOKEN. Guarded because `process` does
  // not exist on the Edge runtime.
  let env = {};
  try { env = (typeof process !== "undefined" && process.env) || {}; } catch (e) { env = {}; }
  const response = await worker.fetch(request, env, {});
  // The streaming v2 runtime requires a Response (or undefined). Strip a few
  // hop-by-hop headers that the platform shim adds anyway.
  const out = new Headers();
  response.headers.forEach((v, k) => {
    if (!["content-length", "transfer-encoding", "connection", "date"].includes(k)) {
      out.set(k, v);
    }
  });
  return new Response(response.body, { status: response.status, headers: out });
};
