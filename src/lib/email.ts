import { Resend } from "resend";

// singleton client

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

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  /** Override the From address. Defaults to EMAIL_FROM env var. */
  from?: string;
}

/**
 * Send a transactional email via Resend (HTTPS — works on Render free tier).
 * Returns true on success, false on failure (non-fatal — caller decides).
 */
export async function sendMail(opts: SendMailOptions): Promise<boolean> {
  // EMAIL_FROM holds the Gmail address used for SMTP / forgot-password, which
  // Resend's domain check would reject, so we skip it here and fall back to
  // Resend's sandbox sender until a custom domain is verified, e.g.
  // "Billd <invoices@yourdomain.com>"
  const from = opts.from ?? "Billd <onboarding@resend.dev>";

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
