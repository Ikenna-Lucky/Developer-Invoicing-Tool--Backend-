import { expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer";
import { createInvoicePdfRenderer, PdfTimeoutError } from "../src/lib/pdf";
import { invoicePdfInput } from "./fixtures/pdf";

if (!process.env.PUPPETEER_EXECUTABLE_PATH)
  throw new Error(
    "Set PUPPETEER_EXECUTABLE_PATH to run real Chromium PDF tests",
  );

// Real browser security checks allow for a cold shared CI runner. The short
// deadline test below exercises timeout enforcement separately.
function browserRenderer(launch: typeof puppeteer.launch) {
  const render = createInvoicePdfRenderer({
    timeoutMs: 45_000,
    launch: (options) =>
      launch({ ...options, timeout: 30_000, protocolTimeout: 30_000 }),
  });
  return async (input: ReturnType<typeof invoicePdfInput>) => {
    try {
      return await render(input);
    } catch (error) {
      if (error instanceof PdfTimeoutError)
        console.error(
          JSON.stringify({
            event: "pdf.test_timeout",
            stage: error.stage,
            elapsedMs: error.elapsedMs,
          }),
        );
      throw error;
    }
  };
}

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
  const pdf = await browserRenderer(launch)(input);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.length).toBeGreaterThan(1000);
  expect(pdf.length).toBeLessThanOrEqual(5 * 1024 * 1024);
}, 60_000);

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
    await browserRenderer(launch)(input);
    expect(attempted).toContain("document");
    expect(attempted).toContain("stylesheet");
    expect(attempted).toContain("image");
    expect(hits).toBe(0);
  } finally {
    server.stop(true);
  }
}, 60_000);

test("busy renders fail promptly and completed requests leave no reusable browser", async () => {
  const browsers: Browser[] = [];
  const launch: typeof puppeteer.launch = async (options) => {
    const browser = await puppeteer.launch(options);
    browsers.push(browser);
    return browser;
  };
  const render = browserRenderer(launch);
  const first = render(invoicePdfInput());
  await expect(render(invoicePdfInput())).rejects.toThrow("busy");
  await first;
  expect(browsers[0].connected).toBe(false);
  await render(invoicePdfInput());
  expect(browsers).toHaveLength(2);
  expect(browsers[1].connected).toBe(false);
}, 110_000);

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
    await expect(browserRenderer(launch)(invoicePdfInput())).rejects.toThrow(
      oversized === "height" ? "too tall" : "5 MiB",
    );
    expect(printed).toBe(oversized !== "height");
    expect(browser?.connected).toBe(false);
  }
}, 110_000);

test("a stalled render is terminated at its deadline and capacity recovers", async () => {
  let browser: Browser | undefined;
  let stall = true;
  let reachedPrint = false;
  const prepared = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    timeout: 30_000,
    protocolTimeout: 30_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const launch: typeof puppeteer.launch = async (options) => {
    browser = stall ? prepared : await puppeteer.launch(options);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      if (stall)
        page.pdf = async () => {
          reachedPrint = true;
          await page.evaluate(() => new Promise(() => {}));
          return Buffer.alloc(0);
        };
      return page;
    };
    return browser;
  };
  const render = createInvoicePdfRenderer({ launch, timeoutMs: 4000 });
  try {
    await expect(render(invoicePdfInput())).rejects.toMatchObject({
      status: 504,
      stage: "print",
    });
    expect(reachedPrint).toBe(true);
    for (let attempt = 0; attempt < 50 && browser?.connected; attempt++)
      await Bun.sleep(20);
    expect(browser?.connected).toBe(false);
    await Bun.sleep(100);
    stall = false;
    expect((await render(invoicePdfInput())).subarray(0, 5).toString()).toBe(
      "%PDF-",
    );
  } finally {
    await prepared.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}, 60_000);

test("PDF shutdown lets an accepted print finish and refuses further renders", async () => {
  let browser!: Browser;
  let entered!: () => void, release!: () => void;
  const printing = new Promise<void>((done) => {
    entered = done;
  });
  const released = new Promise<void>((done) => {
    release = done;
  });
  const launch: typeof puppeteer.launch = async (options) => {
    expect(options?.handleSIGTERM).toBe(false);
    browser = await puppeteer.launch(options);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      const pdf = page.pdf.bind(page);
      page.pdf = async (options) => {
        entered();
        await released;
        return pdf(options);
      };
      return page;
    };
    return browser;
  };
  const render = createInvoicePdfRenderer({ launch, timeoutMs: 45_000 });
  const pending = render(invoicePdfInput());
  try {
    await Promise.race([printing, pending]);
    const stopping = render.shutdown();
    await expect(render(invoicePdfInput())).rejects.toThrow("shutting down");
    expect(browser.connected).toBe(true);
    release();
    expect((await pending).subarray(0, 5).toString()).toBe("%PDF-");
    await stopping;
    expect(browser.connected).toBe(false);
  } finally {
    release();
    await pending.catch(() => {});
    await render.shutdown(true);
  }
}, 60_000);

test("forced PDF shutdown terminates a browser stuck during printing", async () => {
  let browser!: Browser, entered!: () => void;
  const printing = new Promise<void>((done) => {
    entered = done;
  });
  const launch: typeof puppeteer.launch = async (options) => {
    browser = await puppeteer.launch(options);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      page.pdf = async () => {
        entered();
        await page.evaluate(() => new Promise(() => {}));
        return Buffer.alloc(0);
      };
      return page;
    };
    return browser;
  };
  const render = createInvoicePdfRenderer({ launch, timeoutMs: 45_000 });
  const pending = render(invoicePdfInput());
  const finished = pending.then(
    () => false,
    () => true,
  );
  try {
    await Promise.race([printing, pending]);
    await render.shutdown(true);
    expect(await finished).toBe(true);
    expect(browser.connected).toBe(false);
    await expect(render(invoicePdfInput())).rejects.toThrow("shutting down");
  } finally {
    await render.shutdown(true);
    await finished;
  }
}, 60_000);
