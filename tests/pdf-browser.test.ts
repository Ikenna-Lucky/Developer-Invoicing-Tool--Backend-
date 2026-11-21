import { expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer";
import { createInvoicePdfRenderer } from "../src/lib/pdf";
import { invoicePdfInput } from "./fixtures/pdf";

if (!process.env.PUPPETEER_EXECUTABLE_PATH)
  throw new Error(
    "Set PUPPETEER_EXECUTABLE_PATH to run real Chromium PDF tests",
  );

test("real Chromium prints invoice text literally and decodes an approved logo", async () => {
  const input = invoicePdfInput();
  input.invoice.notes =
    '<script>window.injectionRan=true</script><iframe src="http://127.0.0.1/private"></iframe>';
  input.invoice.items[0].description = '<img src=x onerror="alert(1)">';
  const launch: typeof puppeteer.launch = async (options) => {
    const browser = await puppeteer.launch(options);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      const pdf = page.pdf.bind(page);
      page.pdf = async (options) => {
        expect(page.isJavaScriptEnabled()).toBe(false);
        expect(
          await page.$$eval(
            "script,iframe,object,embed",
            (nodes) => nodes.length,
          ),
        ).toBe(0);
        expect(
          await page.$eval(".notes-text", (node) => node.textContent),
        ).toBe(input.invoice.notes!);
        expect(
          await page.$eval(
            ".logo-img",
            (node) => (node as HTMLImageElement).naturalWidth,
          ),
        ).toBe(1);
        if (process.env.PDF_TEST_SCREENSHOT)
          await page.screenshot({
            path: process.env.PDF_TEST_SCREENSHOT,
            fullPage: true,
          });
        return pdf(options);
      };
      return page;
    };
    return browser;
  };
  const pdf = await createInvoicePdfRenderer({ launch })(input);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.length).toBeGreaterThan(1000);
  expect(pdf.length).toBeLessThanOrEqual(5 * 1024 * 1024);
}, 30_000);

test("request interception blocks document, stylesheet, and image fetches even without CSP", async () => {
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hits++;
      return new Response("private");
    },
  });
  const attempted: string[] = [];
  const launch: typeof puppeteer.launch = async (options) => {
    const browser = await puppeteer.launch(options);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      await page.setBypassCSP(true);
      page.on("request", (request) => {
        if (request.url().startsWith(server.url.origin))
          attempted.push(request.resourceType());
      });
      const setContent = page.setContent.bind(page);
      page.setContent = (html, options) =>
        setContent(
          html.replace(
            "</body>",
            `<iframe src="${server.url}private"></iframe><link rel="stylesheet" href="${server.url}style"><img src="${server.url}image"></body>`,
          ),
          options,
        );
      return page;
    };
    return browser;
  };
  try {
    const input = invoicePdfInput();
    input.sender.logoUrl = `${server.url}logo`;
    await createInvoicePdfRenderer({ launch })(input);
    expect(attempted).toContain("document");
    expect(attempted).toContain("stylesheet");
    expect(attempted).toContain("image");
    expect(hits).toBe(0);
  } finally {
    server.stop(true);
  }
}, 30_000);

test("busy renders fail promptly and completed requests leave no reusable browser", async () => {
  const browsers: Browser[] = [];
  const launch: typeof puppeteer.launch = async (options) => {
    const browser = await puppeteer.launch(options);
    browsers.push(browser);
    return browser;
  };
  const render = createInvoicePdfRenderer({ launch });
  const first = render(invoicePdfInput());
  await expect(render(invoicePdfInput())).rejects.toThrow("busy");
  await first;
  expect(browsers[0].connected).toBe(false);
  await render(invoicePdfInput());
  expect(browsers).toHaveLength(2);
  expect(browsers[1].connected).toBe(false);
}, 45_000);

test("render height and output byte limits stop printing and clean up Chromium", async () => {
  for (const oversized of ["height", "bytes"]) {
    let browser: Browser | undefined;
    let printed = false;
    const launch: typeof puppeteer.launch = async (options) => {
      browser = await puppeteer.launch(options);
      const newPage = browser.newPage.bind(browser);
      browser.newPage = async () => {
        const page = await newPage();
        if (oversized === "height")
          page.evaluate = (async () => 20001) as typeof page.evaluate;
        page.pdf = async () => {
          printed = true;
          return Buffer.alloc(5 * 1024 * 1024 + 1);
        };
        return page;
      };
      return browser;
    };
    await expect(
      createInvoicePdfRenderer({ launch })(invoicePdfInput()),
    ).rejects.toThrow(oversized === "height" ? "too tall" : "5 MiB");
    expect(printed).toBe(oversized !== "height");
    expect(browser?.connected).toBe(false);
  }
}, 45_000);

test("a stalled render is terminated at its deadline and capacity recovers", async () => {
  let browser: Browser | undefined;
  let stall = true;
  const launch: typeof puppeteer.launch = async (options) => {
    browser = await puppeteer.launch({ ...options, timeout: 10000 });
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      if (stall)
        page.pdf = async () => {
          await page.evaluate(() => new Promise(() => {}));
          return Buffer.alloc(0);
        };
      return page;
    };
    return browser;
  };
  const render = createInvoicePdfRenderer({ launch, timeoutMs: 4000 });
  await expect(render(invoicePdfInput())).rejects.toThrow("timed out");
  for (let attempt = 0; attempt < 50 && browser?.connected; attempt++)
    await Bun.sleep(20);
  expect(browser?.connected).toBe(false);
  await Bun.sleep(100);
  stall = false;
  expect((await render(invoicePdfInput())).subarray(0, 5).toString()).toBe(
    "%PDF-",
  );
}, 20_000);
