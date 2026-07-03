// src/storage/github.js — GitHub Contents API 저장 백엔드 (서버리스 영속 모드)
//
// fsutil.js와 동일한 8개 프리미티브를 GitHub private 저장소 위에 구현한다.
// 모든 지식 변경 = 커밋 하나 → 감사 로그 철학의 완성형이자 "GitHub = 온라인 메모리"의 실현.
//
// 성능 노트 (미리보기~경량 사용 전제):
// - 웜 인스턴스 내에서 path→{sha, data} 캐시로 API 호출을 절감한다.
// - 쓰기 충돌(409/422)은 sha 재조회 후 1회 재시도한다.
// - 벡터 같은 대용량 derived 아티팩트는 여기로 오면 안 된다 (workspace.js가 로컬로 분리).
import path from "path";
import { config } from "../config.js";

const { repo, token, branch, apiUrl } = config.knowledge;

// 워크스페이스 절대경로 → 저장소 상대경로
function repoPath(absPath) {
  const rel = path.relative(config.workspaceRoot, absPath).split(path.sep).join("/");
  if (rel.startsWith("..")) throw new Error(`워크스페이스 밖 경로: ${absPath}`);
  return rel;
}

// ── 웜 인스턴스 캐시 ──────────────────────────────────
const fileCache = new Map();   // repoPath → { sha, data(string) }
const listCache = new Map();   // repoPath → { ts, names }
const LIST_TTL_MS = 30_000;

async function gh(method, apiPath, body = null) {
  const res = await fetch(`${apiUrl}/repos/${repo}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "BrainStation/3.0",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) return { status: 404, json: null };
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${apiPath} ${res.status}: ${(json?.message || "").slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return { status: res.status, json };
}

async function readRaw(rp) {
  if (fileCache.has(rp)) return fileCache.get(rp).data;
  const { status, json } = await gh("GET", `/contents/${encodeURIComponent(rp).replace(/%2F/g, "/")}?ref=${branch}`);
  if (status === 404 || !json?.content) return null;
  const data = Buffer.from(json.content, "base64").toString("utf-8");
  fileCache.set(rp, { sha: json.sha, data });
  return data;
}

async function writeRaw(rp, data, message) {
  const body = {
    message,
    branch,
    content: Buffer.from(data, "utf-8").toString("base64"),
  };
  const cached = fileCache.get(rp);
  if (cached?.sha) body.sha = cached.sha;

  // sha 충돌(409/422) 재시도 루프.
  // 멀티 인스턴스(Vercel) 환경에서는 다른 인스턴스가 쓴 버전과 어긋나는 게 정상 상황이고,
  // GitHub의 GET이 방금 쓴 커밋을 아직 반영 못 했을 수도 있으므로(복제 지연)
  // 백오프를 두고 최대 3회 fresh sha로 재시도한다.
  let result = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await gh("PUT", `/contents/${encodeURIComponent(rp).replace(/%2F/g, "/")}`, body);
      break;
    } catch (err) {
      if (err.status !== 409 && err.status !== 422) throw err;
      lastErr = err;
      fileCache.delete(rp);
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      const existing = await gh("GET", `/contents/${encodeURIComponent(rp).replace(/%2F/g, "/")}?ref=${branch}`);
      if (existing.json?.sha) body.sha = existing.json.sha;
      else delete body.sha;
    }
  }
  if (!result) throw lastErr;

  fileCache.set(rp, { sha: result.json?.content?.sha, data });
  listCache.delete(path.posix.dirname(rp));
  return result;
}

// ── fsutil 호환 프리미티브 ────────────────────────────
export async function ensureDir() { /* git에는 빈 디렉토리가 없다 — no-op */ }

export async function exists(absPath) {
  return (await readRaw(repoPath(absPath))) !== null;
}

export async function readJSON(absPath, fallback = null) {
  try {
    const raw = await readRaw(repoPath(absPath));
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function atomicWriteJSON(absPath, data) {
  const rp = repoPath(absPath);
  await writeRaw(rp, JSON.stringify(data, null, 2), `apply: ${rp}`);
}

export async function appendJSONL(absPath, objOrArray) {
  const rp = repoPath(absPath);
  const objs = Array.isArray(objOrArray) ? objOrArray : [objOrArray];
  const current = (await readRaw(rp)) || "";
  const appended = current + objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
  await writeRaw(rp, appended, `append: ${rp} (+${objs.length})`);
}

export async function readJSONL(absPath) {
  const raw = await readRaw(repoPath(absPath));
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export async function listFiles(absDir, ext = ".json") {
  const rp = repoPath(absDir);
  const cached = listCache.get(rp);
  if (cached && Date.now() - cached.ts < LIST_TTL_MS) {
    return cached.names.filter((n) => n.endsWith(ext));
  }
  const { status, json } = await gh("GET", `/contents/${encodeURIComponent(rp).replace(/%2F/g, "/")}?ref=${branch}`);
  if (status === 404 || !Array.isArray(json)) return [];
  const names = json.filter((e) => e.type === "file").map((e) => e.name);
  listCache.set(rp, { ts: Date.now(), names });
  return names.filter((n) => n.endsWith(ext));
}

export async function removeFile(absPath) {
  const rp = repoPath(absPath);
  try {
    let sha = fileCache.get(rp)?.sha;
    if (!sha) {
      const { json } = await gh("GET", `/contents/${encodeURIComponent(rp).replace(/%2F/g, "/")}?ref=${branch}`);
      sha = json?.sha;
    }
    if (!sha) return false;
    await gh("DELETE", `/contents/${encodeURIComponent(rp).replace(/%2F/g, "/")}`, {
      message: `delete: ${rp}`, branch, sha,
    });
    fileCache.delete(rp);
    listCache.delete(path.posix.dirname(rp));
    return true;
  } catch {
    return false;
  }
}

export function backendInfo() {
  return { backend: "github", repo, branch };
}
