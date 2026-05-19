import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const STATE_PATH = path.join(tmpdir(), "claude-tiktok-state.json");

export function read() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    try { unlinkSync(STATE_PATH); } catch {}
    return null;
  }
}

export function write(state) {
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

export function update(patch) {
  const current = read() ?? {};
  write({ ...current, ...patch, lastEventAt: new Date().toISOString() });
}

export function clear() {
  try { unlinkSync(STATE_PATH); } catch {}
}

export const STATE_FILE = STATE_PATH;
