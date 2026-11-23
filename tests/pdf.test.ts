import { expect, test } from "bun:test";
import type puppeteer from "puppeteer";
import { TimeoutError } from "puppeteer";
import {
  buildInvoicePdfHtml,
  createInvoicePdfRenderer,
  PdfTimeoutError,
} from "../src/lib/pdf";
import { safePdfLogo } from "../src/lib/pdf-logo";
import { invoicePdfInput, pngLogo } from "./fixtures/pdf";

test("PDF HTML uses saved identity including nulls instead of changed profile details", () => {
  const input = invoicePdfInput();
  input.invoice.identitySnapshot = {
    source: "issued",
    capturedAt: "2026-11-21T00:00:00Z",
    sender: {
      fullName: "Original Owner",
      businessName: null,
      email: "original@example.test",
      address: null,
      phone: null,
      logoUrl: null,
    },
    client: {
      name: "Original Client",
      companyName: null,
      email: "original-client@example.test",
      address: null,
      phone: null,
    },
  };
  const html = buildInvoicePdfHtml(input);
  expect(html).toContain("Original Owner");
  expect(html).toContain("Original Client");
  expect(html).not.toContain("Test Studio");
  expect(html).not.toContain("Client Ltd");
  expect(html).not.toContain(pngLogo);
  expect(input.sender.businessName).toBe("Test Studio");
});

test("invoice text is escaped in every PDF field", () => {
  const input = invoicePdfInput();
  const attack =
    '<script>alert(1)</script><iframe src="http://127.0.0.1/private"></iframe>';
  input.sender.fullName = attack;
  input.sender.businessName = attack;
  input.sender.address = attack;
  input.sender.phone = attack;
  input.sender.email = attack;
  input.invoice.client.name = attack;
  input.invoice.client.companyName = attack;
  input.invoice.client.address = attack;
  input.invoice.client.phone = attack;
  input.invoice.client.email = attack;
  input.invoice.invoiceNumber = attack;
  input.invoice.notes = attack;
  input.invoice.items[0].description = attack;
  input.invoice.stripePaymentLink = attack;
  const html = buildInvoicePdfHtml(input);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<iframe");
  expect(html.match(/&lt;script&gt;/g)?.length).toBeGreaterThanOrEqual(14);
  expect(html).toContain("default-src 'none'");
});

test("logos never accept external, local, SVG, mismatched, malformed, or oversized sources", () => {
  expect(safePdfLogo(pngLogo)).toBe(pngLogo);
  for (const logo of [
    "https://example.com/logo.png",
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:text/html;base64,PGh0bWw+",
    pngLogo.replace("png", "jpeg"),
    pngLogo + '" onerror="alert(1)',
    "data:image/png;base64," + "A".repeat(800000),
  ])
    expect(safePdfLogo(logo)).toBeNull();
  const large = Buffer.from(pngLogo.split(",")[1], "base64");
  large.writeUInt32BE(999999, 16);
  expect(
    safePdfLogo(`data:image/png;base64,${large.toString("base64")}`),
  ).toBeNull();
  const animated = Buffer.concat([
    large.subarray(0, 33),
    Buffer.from([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]),
    large.subarray(33),
  ]);
  animated.writeUInt32BE(1, 16);
  expect(
    safePdfLogo(`data:image/png;base64,${animated.toString("base64")}`),
  ).toBeNull();
  const html = buildInvoicePdfHtml({
    ...invoicePdfInput(),
    sender: {
      ...invoicePdfInput().sender,
      logoUrl: "https://example.com/logo.png",
    },
  });
  expect(html).not.toContain("<img");
  expect(html).toContain("logo-fallback");
});

test("PDF input limits reject excessive rows and text before launching Chromium", async () => {
  let launches = 0;
  const render = createInvoicePdfRenderer({
    launch: (async () => {
      launches++;
      throw Error("Should not launch");
    }) as typeof puppeteer.launch,
  });
  const input = invoicePdfInput();
  input.invoice.items = Array.from(
    { length: 101 },
    () => input.invoice.items[0],
  );
  await expect(render(input)).rejects.toThrow("exceeds PDF limits");
  input.invoice.items = [];
  input.invoice.notes = "a".repeat(100001);
  await expect(render(input)).rejects.toThrow("exceeds PDF limits");
  expect(launches).toBe(0);
});

test("a timed-out launch retains capacity until its late browser has been terminated", async () => {
  let resolve!: (browser: unknown) => void;
  let closed = 0,
    killed = 0;
  const launch = (() =>
    new Promise<unknown>((value) => {
      resolve = value;
    })) as typeof puppeteer.launch;
  const render = createInvoicePdfRenderer({ launch, timeoutMs: 20 });
  await expect(render(invoicePdfInput())).rejects.toThrow("timed out");
  await expect(render(invoicePdfInput())).rejects.toThrow("busy");
  resolve({
    close: async () => {
      closed++;
    },
    process: () => ({
      exitCode: null,
      kill: () => {
        killed++;
      },
    }),
  });
  await Bun.sleep(10);
  expect(closed).toBe(1);
  expect(killed).toBe(1);
});

test("launch failures release the renderer without automatic retry", async () => {
  let launches = 0;
  const render = createInvoicePdfRenderer({
    launch: (async () => {
      launches++;
      throw Error("launch failed");
    }) as typeof puppeteer.launch,
  });
  await expect(render(invoicePdfInput())).rejects.toThrow("launch failed");
  await expect(render(invoicePdfInput())).rejects.toThrow("launch failed");
  expect(launches).toBe(2);
});

test("PDF timeouts identify the failed stage without exposing browser diagnostics", async () => {
  for (const stage of ["launch", "new_page"] as const) {
    let closed = false;
    const launch: typeof puppeteer.launch = async (options) => {
      expect(options?.timeout).toBe(10_000);
      expect(options?.protocolTimeout).toBe(10_000);
      if (stage === "launch")
        throw new TimeoutError("private browser diagnostics");
      return {
        newPage: async () => {
          throw new TimeoutError("private browser diagnostics");
        },
        close: async () => {
          closed = true;
        },
        process: () => null,
      } as unknown as Awaited<ReturnType<typeof puppeteer.launch>>;
    };
    const render = createInvoicePdfRenderer({ launch });
    let failure: unknown;
    try {
      await render(invoicePdfInput());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PdfTimeoutError);
    expect((failure as PdfTimeoutError).stage).toBe(stage);
    expect((failure as PdfTimeoutError).status).toBe(504);
    expect((failure as PdfTimeoutError).elapsedMs).toBeGreaterThanOrEqual(0);
    expect((failure as Error).message).not.toContain("private");
    expect(closed).toBe(stage === "new_page");
  }
});

test("PDF shutdown rejects new work and waits for a late launch to close", async () => {
  let resolve!: (browser: unknown) => void;
  let killed = 0,
    closed = 0;
  const launch = (() =>
    new Promise<unknown>((done) => {
      resolve = done;
    })) as typeof puppeteer.launch;
  const render = createInvoicePdfRenderer({ launch, timeoutMs: 20 });
  await expect(render(invoicePdfInput())).rejects.toThrow("timed out");
  let stopped = false;
  const stopping = render.shutdown().then(() => {
    stopped = true;
  });
  await expect(render(invoicePdfInput())).rejects.toThrow("shutting down");
  expect(stopped).toBe(false);
  resolve({
    close: async () => {
      closed++;
    },
    process: () => ({
      exitCode: null,
      kill: () => {
        killed++;
      },
    }),
  });
  await stopping;
  expect(closed).toBe(1);
  expect(killed).toBe(1);
});
