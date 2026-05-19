import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import * as log from "./log.mjs";

const CHROME_PATHS = [
  process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe",
  process.env["PROGRAMFILES(X86)"] + "\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
];

export function detectChrome() {
  return CHROME_PATHS.find(p => existsSync(p)) ?? null;
}

export function userDataDir() {
  return path.join(tmpdir(), "claude-tiktok-profile");
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function probeCdp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeCdp(port)) return;
    await wait(100);
  }
  throw new Error(`CDP timeout on port ${port}`);
}

export function readActivePort(profile) {
  const file = path.join(profile, "DevToolsActivePort");
  if (!existsSync(file)) return null;
  try {
    const content = readFileSync(file, "utf8");
    const port = parseInt(content.split("\n")[0], 10);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

export async function reuseIfActive(profile) {
  const port = readActivePort(profile);
  if (port && await probeCdp(port)) {
    log.debug(`reusing active Chrome on port ${port}`);
    return { port, reused: true };
  }
  return null;
}

export async function launch(chromePath, url) {
  const profile = userDataDir();

  const reused = await reuseIfActive(profile);
  if (reused) return { pid: null, port: reused.port, userDataDir: profile, reused: true };

  const port = await pickPort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--autoplay-policy=no-user-gesture-required`,
    `--no-first-run`,
    `--no-default-browser-check`,
    `--disable-features=ChromeWhatsNewUI,Translate`,
    url,
  ];
  log.debug(`spawning chrome on port ${port}`);
  const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
  child.unref();
  await waitForCdp(port);
  return { pid: child.pid, port, userDataDir: profile, reused: false };
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
