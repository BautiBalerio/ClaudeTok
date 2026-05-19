#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import * as state from "./state.mjs";
import * as browser from "./browser.mjs";
import * as tiktok from "./tiktok.mjs";
import * as log from "./log.mjs";

const TIKTOK_URL = "https://www.tiktok.com/foryou";

async function ensureSession() {
  let s = state.read();

  if (s && s.cdpPort) {
    if (browser.isAlive(s.chromePid)) return { session: s, cold: false };
    if (await browser.reuseIfActive(s.userDataDir)) {
      log.debug("PID dead but DevToolsActivePort live; treating as warm");
      return { session: s, cold: false };
    }
  }

  const chromePath = browser.detectChrome();
  if (!chromePath) {
    log.error("Chrome no encontrado en paths estandar. Hook abortado.");
    return null;
  }

  const launched = await browser.launch(chromePath, TIKTOK_URL);
  s = {
    sessionId: randomBytes(4).toString("hex"),
    chromePid: launched.pid,
    cdpPort: launched.port,
    userDataDir: launched.userDataDir,
    playState: "playing",
    tabClosed: false,
    createdAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
  };
  state.write(s);
  return { session: s, cold: true };
}

async function cmdPlay() {
  const r = await ensureSession();
  if (!r) return;
  const { session: s, cold } = r;

  if (s.tabClosed) {
    log.debug("user closed tab earlier; not reopening");
    return;
  }

  if (cold) {
    log.debug("cold start; autoplay-policy will handle initial playback");
    return;
  }

  const result = await tiktok.play(s.cdpPort);
  if (result?.tabMissing) {
    state.update({ tabClosed: true });
    return;
  }
  state.update({ playState: "playing" });
}

async function cmdPause() {
  const s = state.read();
  if (!s) {
    log.debug("no state; nothing to pause");
    return;
  }
  if (s.playState === "paused") {
    log.debug("already paused; idempotent no-op");
    return;
  }
  if (!browser.isAlive(s.chromePid) && !(await browser.reuseIfActive(s.userDataDir))) {
    log.debug("chrome dead; clearing state");
    state.clear();
    return;
  }
  const result = await tiktok.pause(s.cdpPort);
  if (result?.tabMissing) {
    state.update({ tabClosed: true });
    return;
  }
  state.update({ playState: "paused" });
}

async function cmdCleanup() {
  log.debug("cleanup: clearing state (Chrome remains running)");
  state.clear();
}

async function cmdStatus() {
  const s = state.read();
  console.log(JSON.stringify({ state: s, logFile: log.LOG_FILE, stateFile: state.STATE_FILE }, null, 2));
}

const cmd = process.argv[2];
try {
  switch (cmd) {
    case "play":    await cmdPlay(); break;
    case "pause":   await cmdPause(); break;
    case "cleanup": await cmdCleanup(); break;
    case "status":  await cmdStatus(); break;
    default:
      console.error(`Unknown command: ${cmd}. Use play|pause|cleanup|status.`);
      process.exit(1);
  }
} catch (err) {
  log.error(`cli ${cmd} failed`, err);
  process.exit(0);
}
