export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
}

export type MailResult =
  | { accepted: true; id: string }
  | { accepted: false; retryable: boolean; code: string };

export async function deliverMail(
  message: MailMessage,
  idempotencyKey: string,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { accepted: false, retryable: true, code: "not_configured" };
  try {
    const response = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      let concurrent = false;
      if (response.status === 409) {
        const error = (await response.json()) as { name?: unknown };
        concurrent = error.name === "concurrent_idempotent_requests";
      }
      return {
        accepted: false,
        retryable:
          concurrent || response.status === 429 || response.status >= 500,
        code: `provider_${response.status}`,
      };
    }
    const data = (await response.json()) as { id?: unknown };
    if (typeof data.id !== "string" || !data.id)
      return { accepted: false, retryable: true, code: "invalid_response" };
    return { accepted: true, id: data.id };
  } catch {
    return { accepted: false, retryable: true, code: "network_error" };
  }
}

export function escapeEmailHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
