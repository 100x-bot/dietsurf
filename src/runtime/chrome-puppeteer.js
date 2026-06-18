import puppeteer from "puppeteer-core";

function chromePath(config) {
  if (config.executablePath) return config.executablePath;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "";
}

export async function createPuppeteerChrome(config = {}) {
  const executablePath = chromePath(config);
  if (!executablePath) {
    throw new Error("set /etc/browser.json executablePath or CHROME_PATH");
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: config.headless ?? false,
    userDataDir: config.userDataDir || "./tmp/chrome"
  });

  async function allPages() {
    let pages = await browser.pages();
    if (pages.length === 0) pages = [await browser.newPage()];
    return pages;
  }

  async function pageByTabId(tabId) {
    const pages = await allPages();
    return pages[Math.max(0, Number(tabId || 1) - 1)] || pages[0];
  }

  return {
    tabs: {
      async query() {
        const pages = await allPages();
        return Promise.all(pages.map(async (page, index) => ({
          id: index + 1,
          active: index === pages.length - 1,
          currentWindow: true,
          url: page.url(),
          title: await page.title()
        })));
      }
    },
    scripting: {
      async executeScript(details) {
        const page = await pageByTabId(details?.target?.tabId);
        const args = details.args || [];
        const source = String(details.func);
        const result = await page.evaluate(
          async (source, args) => (0, eval)(`(${source})`)(...(args || [])),
          source,
          args
        );
        return [{ result }];
      }
    },
    close: () => browser.close()
  };
}
