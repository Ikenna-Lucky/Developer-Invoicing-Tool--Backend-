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
  /** Defaults to the Resend sandbox sender when omitted. */
  from?: string;
}

// Delivery failures are logged and returned as false.
export async function sendMail(opts: SendMailOptions): Promise<boolean> {
  // Use the sandbox sender unless the caller supplies a verified From address.
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
