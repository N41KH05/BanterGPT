// Saves the feed, grudges, memories and visitor-made bots so they survive restarts.
// Server-only (the browser demo saves to localStorage instead).
//
// Two backends:
//  - a JSON file (default): data/banter.json, or BANTER_DATA_FILE
//  - Upstash Redis (free tier works), when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
//    are set. Use this on hosts whose disk is wiped on restart, like Render's free tier.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

export function createStore({ file }) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisStore(url.replace(/\/+$/, ""), token, process.env.BANTER_REDIS_KEY || "bantergpt:state");
  return fileStore(file);
}

function fileStore(file) {
  return {
    label: `file ${file}`,
    saveEverySeconds: Number(process.env.BANTER_SAVE_SECONDS) || 5,
    async load() {
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch (err) {
        if (err.code === "ENOENT") return null; // nothing saved yet
        console.warn(`[store] couldn't read ${file} (${err.message}).`);
        return undefined; // undefined = load FAILED (different from "nothing saved")
      }
    },
    // write to a temp file, then rename over the old one, so a crash mid-save can't corrupt it
    async save(data) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, file);
    },
  };
}

function redisStore(url, token, key) {
  const command = async (args) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Upstash ${res.status}: ${body.error || "request failed"}`);
    return body.result;
  };
  return {
    label: `Upstash Redis (key "${key}")`,
    // free plans count every command, so save less often than the file backend
    saveEverySeconds: Number(process.env.BANTER_SAVE_SECONDS) || 60,
    async load() {
      try {
        const raw = await command(["GET", key]);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        console.warn(`[store] couldn't load from Upstash (${err.message}).`);
        return undefined; // undefined = load FAILED (different from "nothing saved")
      }
    },
    async save(data) {
      await command(["SET", key, JSON.stringify(data)]);
    },
  };
}
