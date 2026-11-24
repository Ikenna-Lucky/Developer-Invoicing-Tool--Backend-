import { escapeEmailHtml } from "./email";

export function buildAccountEmail({
  fullName,
  url,
  purpose,
}: {
  fullName: string;
  url: string;
  purpose: "verification" | "password_reset";
}) {
  const verification = purpose === "verification";
  const title = verification ? "Verify your email" : "Reset your password";
  const description = verification
    ? "Confirm this email address to start using your Billd dashboard."
    : "We received a request to reset your Billd password.";
  const expiry = verification ? "24 hours" : "1 hour";
  const ignore = verification
    ? "If you did not create a Billd account, you can ignore this email."
    : "If you did not request this, you can ignore this email — your password will not change.";
  const link = escapeEmailHtml(url);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin:0; padding:0; background:#0a0f1e; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .wrapper { max-width:520px; margin:0 auto; padding:40px 16px; }
    .card { background:#0f172a; border:1px solid #1e293b; border-radius:16px; overflow:hidden; }
    .section { padding:32px; }
    @media only screen and (max-width:480px) {
      .wrapper { padding:24px 12px; }
      .section { padding:24px 20px; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div style="text-align:center;margin-bottom:28px;font-size:28px;font-weight:900;color:#7c3aed;">Billd</div>
    <div class="card">
      <div style="height:4px;background:linear-gradient(90deg,#2563eb,#7c3aed,#ec4899);"></div>
      <div class="section">
        <p style="font-size:22px;font-weight:700;color:#fff;margin:0 0 8px;">${title}</p>
        <p style="font-size:15px;color:#94a3b8;margin:0 0 28px;line-height:1.6;">Hi ${escapeEmailHtml(fullName)}, ${description} This link expires in <strong>${expiry}</strong>.</p>
        <div style="text-align:center;margin-bottom:28px;">
          <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:12px;">${title}</a>
        </div>
        <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0;">${ignore}</p>
        <p style="font-size:12px;color:#64748b;margin:20px 0 0;word-break:break-all;">Or copy this link: <a href="${link}" style="color:#60a5fa;">${link}</a></p>
      </div>
    </div>
    <p style="text-align:center;color:#64748b;font-size:11px;margin-top:24px;">Sent via <strong>Billd</strong> — Professional invoicing for freelancers</p>
  </div>
</body>
</html>`;
}
