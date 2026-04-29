import { Resend } from "resend";

// ─── Client (singleton) ───────────────────────────────────────────────────────

let _resend: Resend | null = null;

function getClient(): Resend {
  if (_resend) return _resend;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY environment variable is required.");
  }

  _resend = new Resend(apiKey);
  return _resend;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  /** Override the From address. Defaults to EMAIL_FROM env var. */
  from?: string;
}

// ─── Public helper ────────────────────────────────────────────────────────────

/**
 * Send a transactional email via Resend (HTTPS — works on Render free tier).
 * Returns true on success, false on failure (non-fatal — caller decides).
 */
export async function sendMail(opts: SendMailOptions): Promise<boolean> {
  // Default sender: use EMAIL_FROM env var if set, otherwise Resend's sandbox
  // address (only delivers to your own Resend account email — good for testing).
  // Once you verify a custom domain in Resend, set EMAIL_FROM to e.g.:
  //   "Billd <invoices@yourdomain.com>"
  const from =
    opts.from ?? process.env.EMAIL_FROM ?? "Billd <onboarding@resend.dev>";

  try {
    const client = getClient();
    const { error } = await client.emails.send({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });

    if (error) {
      console.error("[email] Failed to send mail:", error);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[email] Failed to send mail:", err);
    return false;
  }
}
