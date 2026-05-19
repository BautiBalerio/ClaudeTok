import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LOG_PATH = path.join(tmpdir(), "claude-tiktok-hook.log");
const DEBUG = process.env.CLAUDE_TIKTOK_DEBUG === "1";

function write(level, msg) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${level} ${msg}\n`);
  } catch {}
}

export function error(msg, err) {
  const detail = err ? `: ${err.stack || err.message || String(err)}` : "";
  write("ERROR", `${msg}${detail}`);
}

export function debug(msg) {
  if (DEBUG) write("DEBUG", msg);
}

export const LOG_FILE = LOG_PATH;
