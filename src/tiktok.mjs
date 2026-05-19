import { chromium } from "playwright-core";
import * as log from "./log.mjs";

const TIKTOK_HOST = "tiktok.com";

async function findTikTokPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      if (page.url().includes(TIKTOK_HOST)) return page;
    }
  }
  return null;
}

async function withBrowser(port, fn) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return await fn(browser);
  } catch (err) {
    log.error("CDP operation failed", err);
    return { error: err.message };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

export async function play(port) {
  return withBrowser(port, async (browser) => {
    const page = await findTikTokPage(browser);
    if (!page) return { tabMissing: true };
    await page.evaluate(() => {
      const videos = document.querySelectorAll("video");
      if (videos.length === 0) return;
      const active = Array.from(videos).find(v => v.currentTime > 0) || videos[0];
      const p = active.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    });
    return { ok: true };
  });
}

export async function pause(port) {
  return withBrowser(port, async (browser) => {
    const page = await findTikTokPage(browser);
    if (!page) return { tabMissing: true };
    await page.evaluate(() => {
      document.querySelectorAll("video").forEach(v => v.pause());
    });
    return { ok: true };
  });
}
