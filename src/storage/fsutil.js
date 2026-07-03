// src/storage/fsutil.js — 파일시스템 기본 연산 (불변식 7: 원자적 쓰기)
import { mkdir, readFile, writeFile, rename, readdir, unlink, appendFile, access } from "fs/promises";
import path from "path";
import crypto from "crypto";

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

// 원자적 쓰기: tmp에 쓰고 rename. 중단·동시 쓰기에도 파일이 반파되지 않는다.
export async function atomicWriteJSON(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, file);
}

export async function readJSON(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return fallback;
  }
}

// append-only JSONL (불변식 3: 이벤트/대화는 덧붙이기만). 배열이면 한 번에 여러 줄.
export async function appendJSONL(file, objOrArray) {
  const objs = Array.isArray(objOrArray) ? objOrArray : [objOrArray];
  await ensureDir(path.dirname(file));
  await appendFile(file, objs.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");
}

export async function readJSONL(file) {
  try {
    const raw = await readFile(file, "utf-8");
    return raw.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export async function listFiles(dir, ext = ".json") {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(ext));
  } catch {
    return [];
  }
}

export async function removeFile(file) {
  try { await unlink(file); return true; } catch { return false; }
}
