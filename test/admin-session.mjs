// Shared admin credentials for the test suite: the /admin tree is password
// protected in production, so tests must present a valid session.
import { createHash } from "node:crypto";

export const ADMIN_PASSWORD = "test-admin-password";
export const ADMIN_ENV = { ADMIN_PASSWORD };
export const ADMIN_COOKIE =
  "sp_admin=" + createHash("sha256").update("sp-vpn-admin-v1:" + ADMIN_PASSWORD).digest("hex");
export const withAdmin = (headers = {}) => ({ ...headers, cookie: ADMIN_COOKIE });
