import nodemailer from "nodemailer";

// ─── Transport (singleton) ────────────────────────────────────────────────────
// Created once, reused across all requests.
// Bun keeps the module alive for the lifetime of the process, so this is fine.

let _transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (_transporter) return _transporter;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    throw new Error(
      "EMAIL_USER and EMAIL_PASS environment variables are required for sending email.",
    );
  }

  _transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
    // Without these timeouts a failed/stale SMTP connection silently hangs
    // the entire HTTP request until Render's 90-second gateway timeout kills
    // it — which makes the browser throw "Failed to fetch" instead of a
    // real error message.
    connectionTimeout: 10_000, // give up connecting after 10 s
    greetingTimeout: 10_000, // give up waiting for server EHLO after 10 s
    socketTimeout: 30_000, // max time waiting for a send ACK
  });

  return _transporter;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  /** Override the From address. Defaults to EMAIL_FROM env var → EMAIL_USER. */
  from?: string;
}

// ─── Public helper ────────────────────────────────────────────────────────────

/**
 * Send a transactional email via Gmail SMTP.
 * Returns true on success, false on failure (non-fatal — caller decides).
 */
export async function sendMail(opts: SendMailOptions): Promise<boolean> {
  const from =
    opts.from ??
    process.env.EMAIL_FROM ??
    process.env.EMAIL_USER ??
    "noreply@gmail.com";

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
    return true;
  } catch (err) {
    console.error("[email] Failed to send mail:", err);
    return false;
  }
}
