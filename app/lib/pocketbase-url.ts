/**
 * Browser traffic always uses the authenticated same-origin gateway. Keeping
 * NEXT_PUBLIC_POCKETBASE_URL out of this branch prevents a hosted bundle from
 * accidentally exposing a writable PocketBase origin.
 */
export const POCKETBASE_URL = (
  typeof window !== "undefined"
    ? process.env.NODE_ENV === "development"
      ? "/pb"
      : "/api/pocketbase"
    : process.env.POCKETBASE_URL ||
      process.env.NEXT_PUBLIC_POCKETBASE_URL ||
      "http://127.0.0.1:8090"
).replace(/\/$/, "");

/** Only server-side/local callers may need the workstation trust marker. */
export function pocketBaseUiHeaders(): HeadersInit {
  return POCKETBASE_URL === "/pb" || typeof window === "undefined"
    ? { "x-lumina-ui": "local" }
    : {};
}
