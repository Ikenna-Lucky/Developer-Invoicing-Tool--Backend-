import { expect, test } from "bun:test";
import { deliverMail } from "../src/lib/email";

const message = {
  from: "Billd <onboarding@resend.dev>",
  to: "recipient@example.test",
  subject: "Test",
  html: "<p>Test</p>",
};
test("Resend requests use the configured sender, idempotency key, and a deadline", async () => {
  process.env.RESEND_API_KEY = "re_test_only";
  const result = await deliverMail(
    message,
    "job/test",
    async (url, options) => {
      expect(url).toBe("https://api.resend.com/emails");
      expect(new Headers(options.headers).get("Idempotency-Key")).toBe(
        "job/test",
      );
      expect(JSON.parse(String(options.body))).toEqual(message);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ id: "provider-id" });
    },
  );
  expect(result).toEqual({ accepted: true, id: "provider-id" });
});
test("provider errors are classified without retaining response bodies", async () => {
  process.env.RESEND_API_KEY = "re_test_only";
  for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    expect(
      await deliverMail(
        message,
        "job/test",
        async () => new Response("private provider details", { status }),
      ),
    ).toEqual({
      accepted: false,
      retryable: status === 429 || status >= 500,
      code: `provider_${status}`,
    });
  }
  expect(
    await deliverMail(message, "job/test", async () => {
      throw new Error("private token");
    }),
  ).toEqual({ accepted: false, retryable: true, code: "network_error" });
  expect(
    await deliverMail(message, "job/test", async () => Response.json({})),
  ).toEqual({ accepted: false, retryable: true, code: "invalid_response" });
  delete process.env.RESEND_API_KEY;
});

test("only concurrent idempotency conflicts are retried", async () => {
  process.env.RESEND_API_KEY = "re_test_only";
  for (const name of [
    "concurrent_idempotent_requests",
    "invalid_idempotent_request",
  ]) {
    const result = await deliverMail(message, "job/test", async () =>
      Response.json({ name }, { status: 409 }),
    );
    expect(result).toEqual({
      accepted: false,
      retryable: name === "concurrent_idempotent_requests",
      code: "provider_409",
    });
  }
  delete process.env.RESEND_API_KEY;
});
