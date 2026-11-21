import assert from "node:assert/strict";

const baseUrl = "http://localhost:3001";

const health = await fetch(`${baseUrl}/health`, {
  signal: AbortSignal.timeout(5_000),
});
assert.equal(health.status, 200, "Health endpoint should return 200");
assert.equal((await health.json()).status, "ok");

const clients = await fetch(`${baseUrl}/clients`, {
  signal: AbortSignal.timeout(5_000),
});
assert.equal(clients.status, 401, "Client data should require a session");

const forgedLogout = await fetch(`${baseUrl}/auth/logout`, {
  method: "POST",
  headers: { Origin: "https://untrusted.example" },
  signal: AbortSignal.timeout(5_000),
});
assert.equal(forgedLogout.status, 403, "Cross-site writes should be rejected");

const logout = await fetch(`${baseUrl}/auth/logout`, {
  method: "POST",
  headers: {
    Origin: new URL(process.env.FRONTEND_URL ?? "http://localhost:3000").origin,
  },
  signal: AbortSignal.timeout(5_000),
});
assert.equal(
  logout.status,
  200,
  "Trusted logout without a session should succeed",
);

const webhook = await fetch(`${baseUrl}/webhooks/paystack`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ event: "charge.success", data: {} }),
  signal: AbortSignal.timeout(5_000),
});
assert.equal(webhook.status, 401, "Unsigned payment events should be rejected");

console.log("API smoke checks passed");
