import puppeteer, { TimeoutError, type Browser } from "puppeteer";
import { HTTPException } from "hono/http-exception";
import { escapeEmailHtml as escapeHtml } from "./email";
import { safePdfLogo } from "./pdf-logo";
import type { Invoice, InvoiceItem, Client, User } from "../db/schema";

export type PDFInput = {
  invoice: Invoice & {
    client: Client;
    items: InvoiceItem[];
  };
  sender: User;
};

function fmtCurrency(n: number | string): string {
  return `₦${Number(n).toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-NG", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// status pill colours
const STATUS_STYLES: Record<
  string,
  { bg: string; color: string; label: string }
> = {
  draft: { bg: "#1e293b", color: "#94a3b8", label: "DRAFT" },
  sent: { bg: "rgba(37,99,235,.15)", color: "#60a5fa", label: "ISSUED" },
  paid: { bg: "rgba(22,163,74,.15)", color: "#4ade80", label: "PAID" },
  overdue: { bg: "rgba(220,38,38,.15)", color: "#f87171", label: "OVERDUE" },
};

export function buildInvoicePdfHtml(input: PDFInput): string {
  const { invoice, sender } = input;
  if (invoice.items.length > 100)
    throw new HTTPException(422, {
      message: "Invoice content exceeds PDF limits",
    });
  const text = [
    invoice.invoiceNumber,
    invoice.notes,
    invoice.client.name,
    invoice.client.companyName,
    invoice.client.address,
    invoice.client.phone,
    invoice.client.email,
    sender.fullName,
    sender.businessName,
    sender.address,
    sender.phone,
    sender.email,
    invoice.stripePaymentLink,
    ...invoice.items.map((item) => item.description),
  ];
  if (
    invoice.items.length > 100 ||
    text.reduce(
      (size, value) => size + Buffer.byteLength(value ?? "", "utf8"),
      0,
    ) > 100_000
  )
    throw new HTTPException(422, {
      message: "Invoice content exceeds PDF limits",
    });
  const logo = safePdfLogo(sender.logoUrl);
  const st = STATUS_STYLES[invoice.status] ?? STATUS_STYLES.draft;

  const isOverdue = invoice.status === "overdue";
  const isPaid = invoice.status === "paid";
  const subtotal = invoice.items.reduce((s, i) => s + Number(i.amount), 0);
  const senderName = sender.businessName ?? sender.fullName;

  const logoHtml = logo
    ? `<img src="${logo}" alt="Logo" class="logo-img" />`
    : `<div class="logo-fallback">${escapeHtml(senderName.slice(0, 2).toUpperCase())}</div>`;

  const itemRows = invoice.items
    .map(
      (item, idx) => `
    <tr class="${idx % 2 === 0 ? "row-even" : "row-odd"}">
      <td class="td-desc">${escapeHtml(item.description)}</td>
      <td class="td-num">${Number(item.quantity)}</td>
      <td class="td-num">${fmtCurrency(item.rate)}</td>
      <td class="td-amt">${fmtCurrency(item.amount)}</td>
    </tr>
  `,
    )
    .join("");

  const paymentBlock = invoice.stripePaymentLink
    ? `
    <div class="payment-box">
      <div class="payment-icon">⚡</div>
      <div class="payment-text">
        <p class="payment-title">Pay Online via Paystack</p>
        <p class="payment-url">${escapeHtml(invoice.stripePaymentLink)}</p>
      </div>
    </div>
  `
    : "";

  const watermark =
    isPaid || isOverdue
      ? `
    <div class="watermark ${invoice.status}">${st.label}</div>
  `
      : "";

  const senderDetails = [sender.address, sender.phone, sender.email]
    .filter((value): value is string => Boolean(value))
    .map(escapeHtml)
    .join("<br/>");

  const clientCompany = invoice.client.companyName
    ? `<span class="biz">${escapeHtml(invoice.client.companyName)}</span>`
    : "";

  const clientDetails = [
    invoice.client.address,
    invoice.client.phone,
    invoice.client.email,
  ]
    .filter((value): value is string => Boolean(value))
    .map(escapeHtml)
    .join("<br/>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
/* reset */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* base */
html, body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  background: #fff;
  color: #0f172a;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* left accent bar */
.accent-rail {
  position: fixed;
  left: 0; top: 0; bottom: 0;
  width: 6px;
  background: linear-gradient(180deg, #2563eb 0%, #7c3aed 50%, #ec4899 100%);
  z-index: 100;
}

.page {
  margin-left: 6px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* header */
.header {
  background: #0a0f1e;
  padding: 44px 52px 44px 46px;
  position: relative;
  overflow: hidden;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
}

/* dot-grid texture */
.header::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image:
    radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px);
  background-size: 22px 22px;
  pointer-events: none;
}

/* glow orb */
.header::after {
  content: "";
  position: absolute;
  top: -60px; right: 80px;
  width: 260px; height: 260px;
  background: radial-gradient(circle, rgba(124,58,237,0.25) 0%, transparent 70%);
  pointer-events: none;
}

.header-left {
  position: relative;
  z-index: 1;
}

.header-right {
  position: relative;
  z-index: 1;
  text-align: right;
  flex-shrink: 0;
}

/* logo */
.logo-img {
  width: 60px;
  height: 60px;
  border-radius: 14px;
  object-fit: cover;
  display: block;
  border: 2px solid rgba(255,255,255,0.12);
}

.logo-fallback {
  width: 60px;
  height: 60px;
  border-radius: 14px;
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  color: #fff;
  font-size: 20px;
  font-weight: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  letter-spacing: -0.03em;
  border: 2px solid rgba(255,255,255,0.12);
}

.sender-name {
  color: #fff;
  font-size: 18px;
  font-weight: 800;
  margin-top: 14px;
  letter-spacing: -0.02em;
}

.sender-details {
  color: rgba(255,255,255,0.38);
  font-size: 12px;
  line-height: 1.8;
  margin-top: 5px;
}

/* invoice number */
.inv-word {
  color: rgba(255,255,255,0.28);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.18em;
}

.inv-number {
  color: #fff;
  font-size: 38px;
  font-weight: 900;
  font-family: "SF Mono", "Monaco", "Inconsolata", "Fira Code", monospace;
  letter-spacing: -0.03em;
  margin-top: 4px;
  line-height: 1;
}

.status-pill {
  display: inline-block;
  padding: 5px 14px;
  border-radius: 100px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  margin-top: 12px;
  background: ${st.bg};
  color: ${st.color};
  border: 1px solid ${st.color}40;
}

/* gradient accent bar under header */
.header-rule {
  height: 3px;
  background: linear-gradient(90deg, #2563eb, #7c3aed, #ec4899);
  margin-left: 6px;
}

/* dates strip */
.dates-strip {
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  padding: 18px 52px;
  display: flex;
  gap: 52px;
}

.date-block {}
.date-lbl {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: #94a3b8;
}
.date-val {
  font-size: 14px;
  font-weight: 600;
  color: #1e293b;
  margin-top: 3px;
  font-family: "SF Mono", monospace;
}
.date-val.red { color: #dc2626; }

/* body */
.body {
  padding: 44px 52px;
  flex: 1;
}

/* billing */
.billing {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-bottom: 44px;
}

.billing-card {
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 22px 24px;
  background: #fff;
  position: relative;
  overflow: hidden;
}

.billing-card::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: linear-gradient(90deg, #2563eb, #7c3aed);
}

.billing-tag {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: #94a3b8;
  margin-bottom: 12px;
}

.billing-name {
  font-size: 16px;
  font-weight: 800;
  color: #0f172a;
  letter-spacing: -0.01em;
}

.biz {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: #64748b;
  margin-top: 3px;
}

.billing-info {
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.8;
  margin-top: 10px;
}

/* section heading */
.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 0;
}
.section-head-line {
  flex: 1;
  height: 1px;
  background: #e2e8f0;
}
.section-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: #94a3b8;
  white-space: nowrap;
}

/* items table */
.items-wrap {
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  overflow: hidden;
  margin-top: 12px;
}

table {
  width: 100%;
  border-collapse: collapse;
}

thead tr {
  background: #0f172a;
}

thead th {
  padding: 13px 18px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.13em;
  color: rgba(255,255,255,0.45);
  text-align: left;
}
thead th:not(:first-child) { text-align: right; }

.row-even { background: #fff; }
.row-odd  { background: #fafbfc; }

.td-desc {
  overflow-wrap: anywhere;
  padding: 15px 18px;
  font-size: 13.5px;
  font-weight: 500;
  color: #1e293b;
  border-bottom: 1px solid #f1f5f9;
  max-width: 340px;
}

.td-num {
  padding: 15px 18px;
  font-size: 13px;
  color: #64748b;
  text-align: right;
  font-family: "SF Mono", monospace;
  border-bottom: 1px solid #f1f5f9;
  white-space: nowrap;
}

.td-amt {
  padding: 15px 18px;
  font-size: 13px;
  font-weight: 700;
  color: #1e293b;
  text-align: right;
  font-family: "SF Mono", monospace;
  border-bottom: 1px solid #f1f5f9;
  white-space: nowrap;
}

/* totals */
.totals-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 0;
}

.totals-box {
  width: 320px;
  border: 1px solid #e2e8f0;
  border-top: none;
  border-radius: 0 0 14px 14px;
  overflow: hidden;
}

.total-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 18px;
  font-size: 13px;
  color: #64748b;
  border-bottom: 1px solid #f1f5f9;
}

.total-row:last-child { border-bottom: none; }

.total-row.grand {
  background: #0f172a;
  padding: 16px 18px;
  border-bottom: none;
}
.total-row.grand .lbl {
  font-size: 14px;
  font-weight: 700;
  color: rgba(255,255,255,0.7);
}
.total-row.grand .amt {
  font-size: 22px;
  font-weight: 900;
  color: #fff;
  font-family: "SF Mono", monospace;
  letter-spacing: -0.02em;
}

/* notes */
.notes-box {
  margin-top: 28px;
  border: 1px solid #fde68a;
  border-radius: 14px;
  padding: 20px 24px;
  background: #fffbeb;
}
.notes-lbl {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: #d97706;
  margin-bottom: 8px;
}
.notes-text {
  font-size: 13px;
  color: #78350f;
  line-height: 1.75;
}

/* payment box */
.payment-box {
  margin-top: 28px;
  background: linear-gradient(135deg, rgba(37,99,235,0.05) 0%, rgba(124,58,237,0.05) 100%);
  border: 1px solid rgba(37,99,235,0.2);
  border-radius: 14px;
  padding: 20px 24px;
  display: flex;
  align-items: center;
  gap: 16px;
}
.payment-icon {
  font-size: 28px;
  flex-shrink: 0;
}
.payment-title {
  font-size: 13px;
  font-weight: 700;
  color: #1e40af;
}
.payment-url {
  font-size: 11px;
  color: #6366f1;
  font-family: "SF Mono", monospace;
  margin-top: 4px;
  word-break: break-all;
}

/* watermark */
.watermark {
  position: fixed;
  top: 48%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-32deg);
  font-size: 130px;
  font-weight: 900;
  letter-spacing: 0.06em;
  pointer-events: none;
  white-space: nowrap;
  z-index: 0;
}
.watermark.paid    { color: rgba(22,163,74,0.055); }
.watermark.overdue { color: rgba(220,38,38,0.055); }

/* footer */
.footer {
  background: #0a0f1e;
  padding: 22px 52px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: auto;
}
.footer-left {
  color: rgba(255,255,255,0.3);
  font-size: 11.5px;
}
.footer-left strong { color: rgba(255,255,255,0.6); }
.footer-right {
  color: rgba(255,255,255,0.2);
  font-size: 11px;
  font-family: "SF Mono", monospace;
}
.sender-name, .sender-details, .inv-number, .billing-name, .biz, .billing-info, .notes-text, .payment-url { overflow-wrap: anywhere; }
</style>
</head>
<body>

${watermark}

<!-- left gradient rail -->
<div class="accent-rail"></div>

<div class="page">

  <!-- header -->
  <div class="header">
    <div class="header-left">
      ${logoHtml}
      <p class="sender-name">${escapeHtml(senderName)}</p>
      ${senderDetails ? `<p class="sender-details">${senderDetails}</p>` : ""}
    </div>
    <div class="header-right">
      <p class="inv-word">Invoice</p>
      <p class="inv-number">${escapeHtml(invoice.invoiceNumber)}</p>
      <span class="status-pill">${st.label}</span>
    </div>
  </div>

  <!-- gradient rule -->
  <div class="header-rule"></div>

  <!-- dates strip -->
  <div class="dates-strip">
    <div class="date-block">
      <p class="date-lbl">Issue Date</p>
      <p class="date-val">${fmtDate(invoice.issueDate)}</p>
    </div>
    <div class="date-block">
      <p class="date-lbl">Due Date</p>
      <p class="date-val ${isOverdue ? "red" : ""}">${fmtDate(invoice.dueDate)}</p>
    </div>
    <div class="date-block">
      <p class="date-lbl">Amount Due</p>
      <p class="date-val ${isPaid ? "" : isOverdue ? "red" : ""}">${fmtCurrency(invoice.totalAmount)}</p>
    </div>
  </div>

  <!-- body -->
  <div class="body">

    <!-- billing cards -->
    <div class="billing">
      <!-- from -->
      <div class="billing-card">
        <p class="billing-tag">From</p>
        <p class="billing-name">${escapeHtml(senderName)}</p>
        ${senderDetails ? `<p class="billing-info">${senderDetails}</p>` : ""}
      </div>
      <!-- to -->
      <div class="billing-card">
        <p class="billing-tag">Bill To</p>
        <p class="billing-name">${escapeHtml(invoice.client.name)}</p>
        ${clientCompany}
        ${clientDetails ? `<p class="billing-info">${clientDetails}</p>` : ""}
      </div>
    </div>

    <!-- items section heading -->
    <div class="section-head">
      <span class="section-label">Line Items</span>
      <div class="section-head-line"></div>
    </div>

    <!-- items table -->
    <div class="items-wrap">
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th style="text-align:right">Qty</th>
            <th style="text-align:right">Rate</th>
            <th style="text-align:right">Amount</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>
    </div>

    <!-- totals -->
    <div class="totals-wrap">
      <div class="totals-box">
        <div class="total-row">
          <span class="lbl">Subtotal</span>
          <span class="amt" style="font-family:monospace;font-size:13px;color:#1e293b">${fmtCurrency(subtotal)}</span>
        </div>
        <div class="total-row">
          <span class="lbl">Tax (0%)</span>
          <span class="amt" style="font-family:monospace;font-size:13px;color:#94a3b8">₦0.00</span>
        </div>
        <div class="total-row grand">
          <span class="lbl">Total Due</span>
          <span class="amt">${fmtCurrency(invoice.totalAmount)}</span>
        </div>
      </div>
    </div>

    ${
      invoice.notes
        ? `
    <!-- notes -->
    <div class="notes-box">
      <p class="notes-lbl">Notes</p>
      <p class="notes-text">${escapeHtml(invoice.notes)}</p>
    </div>
    `
        : ""
    }

    ${paymentBlock}

  </div><!-- /body -->

  <!-- footer -->
  <div class="footer">
    <p class="footer-left">Generated by <strong>Billd</strong> — Professional invoicing for freelancers</p>
    <p class="footer-right">${escapeHtml(invoice.invoiceNumber)} · ${new Date().toLocaleDateString("en-NG")}</p>
  </div>

</div><!-- /page -->

</body>
</html>`;
}

function killBrowser(browser: Browser) {
  const child = browser.process();
  if (child && child.exitCode === null) child.kill("SIGKILL");
}

async function closeBrowser(browser: Browser) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    killBrowser(browser);
  }
}

export function createInvoicePdfRenderer(
  options: {
    launch?: typeof puppeteer.launch;
    timeoutMs?: number;
  } = {},
) {
  const launch = options.launch ?? puppeteer.launch.bind(puppeteer);
  const timeoutMs = options.timeoutMs ?? 20_000;
  let active = false;
  return async (input: PDFInput): Promise<Buffer> => {
    if (active)
      throw new HTTPException(503, {
        message: "PDF renderer is busy. Please try again shortly",
      });
    const html = buildInvoicePdfHtml(input);
    if (Buffer.byteLength(html, "utf8") > 1_500_000)
      throw new HTTPException(422, {
        message: "Invoice content exceeds PDF limits",
      });
    active = true;
    let browser: Browser | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new HTTPException(504, {
      message: "PDF generation timed out. Please try again",
    });
    const work = async () => {
      try {
        browser = await launch({
          headless: true,
          executablePath:
            process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/chromium",
          timeout: Math.min(10_000, timeoutMs),
          protocolTimeout: Math.min(10_000, timeoutMs),
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-default-apps",
            "--mute-audio",
            "--no-first-run",
          ],
        });
        if (expired) throw timeout;
        const page = await browser.newPage();
        await page.setJavaScriptEnabled(false);
        await page.setCacheEnabled(false);
        await page.setBypassServiceWorker(true);
        await page.setViewport({ width: 794, height: 1123 });
        const logo = safePdfLogo(input.sender.logoUrl);
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          const allowed =
            logo !== null &&
            request.resourceType() === "image" &&
            request.url() === logo;
          void (allowed ? request.continue() : request.abort()).catch(() => {});
        });
        await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
        const bodyHeight = await page.evaluate(
          () => document.documentElement.scrollHeight,
        );
        if (
          !Number.isFinite(bodyHeight) ||
          bodyHeight <= 0 ||
          bodyHeight > 20_000
        )
          throw new HTTPException(422, {
            message: "Invoice is too tall to render as a PDF",
          });
        const result = Buffer.from(
          await page.pdf({
            width: "794px",
            height: `${bodyHeight + 2}px`,
            printBackground: true,
            margin: { top: "0", right: "0", bottom: "0", left: "0" },
            timeout: timeoutMs,
          }),
        );
        if (result.length > 5 * 1024 * 1024)
          throw new HTTPException(422, {
            message: "Generated PDF exceeds the 5 MiB download limit",
          });
        return result;
      } catch (error) {
        if (error instanceof TimeoutError) throw timeout;
        throw error;
      } finally {
        if (browser) await closeBrowser(browser);
        active = false;
      }
    };
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            if (browser) killBrowser(browser);
            reject(timeout);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export const generateInvoicePDF = createInvoicePdfRenderer();
