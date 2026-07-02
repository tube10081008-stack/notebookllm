// src/core/parsers.js — 콘텐츠 파서 (텍스트/URL/PDF/YouTube/이미지)
// v1 parser.js 계승 + 두 가지 수정:
//   ⑨ 멀티모달(OCR)도 llm 창구(describeMedia)를 통과한다 — SDK 직접 호출 금지
//   ⑫ parseURL의 SSRF 차단 (사설망·루프백·메타데이터 IP 거부)
import { createRequire } from "module";
import dns from "dns/promises";
import net from "net";
import { YoutubeTranscript } from "youtube-transcript";
import { getLLM } from "../llm/index.js";

const require = createRequire(import.meta.url);

// ── 텍스트 ───────────────────────────────────────────
export function parseText(rawText) {
  const trimmed = (rawText || "").trim();
  const firstLine = trimmed.split("\n")[0] || "제목 없음";
  const title = firstLine.replace(/^#+\s*/, "").trim();
  return { content: trimmed, metadata: { title, date: new Date().toISOString() } };
}

// ── URL (SSRF 차단 포함) ─────────────────────────────
function isPrivateIP(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return low === "::1" || low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd") ||
           low.startsWith("::ffff:127.") || low.startsWith("::ffff:10.") || low.startsWith("::ffff:192.168.");
  }
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  return (
    a === 127 || a === 10 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||           // 링크 로컬 / 클라우드 메타데이터
    (a === 100 && b >= 64 && b <= 127)    // CGNAT
  );
}

async function assertPublicURL(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("유효하지 않은 URL입니다."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("http/https URL만 지원합니다.");
  if (net.isIP(u.hostname) && isPrivateIP(u.hostname)) throw new Error("사설망 주소는 가져올 수 없습니다.");
  try {
    const { address } = await dns.lookup(u.hostname);
    if (isPrivateIP(address)) throw new Error("사설망으로 해석되는 호스트는 가져올 수 없습니다.");
  } catch (err) {
    if (err.message.includes("사설망")) throw err;
    // DNS 실패는 fetch 단계에서 자연히 실패하므로 통과
  }
  return u;
}

export async function parseURL(url) {
  await assertPublicURL(url);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BrainStation/2.0)" },
    signal: AbortSignal.timeout(15000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`URL 가져오기 실패: ${res.status} ${res.statusText}`);

  const html = await res.text();
  return {
    content: stripHTML(html),
    metadata: { title: extractTitle(html) || url, url, date: new Date().toISOString() },
  };
}

// ── PDF (텍스트 추출 → 부족 시 LLM OCR 폴백) ──────────
export async function parsePDF(buffer, filename) {
  const pdfParse = require("pdf-parse");
  let content = "";
  let pages = 0;
  let isOcrFallback = false;

  try {
    const data = await pdfParse(buffer);
    content = (data.text || "").trim();
    pages = data.numpages || 0;
  } catch (err) {
    console.warn("⚠️ pdf-parse 실패, LLM OCR 폴백:", err.message);
  }

  if (content.length < 100) {
    try {
      content = (await getLLM().describeMedia({
        mimeType: "application/pdf",
        dataBase64: buffer.toString("base64"),
        instruction: "이 PDF 스캔본 문서의 모든 본문 텍스트를 한 글자도 생략하지 말고 정확하게 복원해서 반환해줘.",
      })).trim();
      isOcrFallback = true;
    } catch (err) {
      console.error("❌ LLM OCR 실패:", err.message);
    }
  }

  return {
    content,
    metadata: { title: filename || "PDF 문서", pages, date: new Date().toISOString(), isOcrFallback },
  };
}

// ── 이미지 ───────────────────────────────────────────
export async function parseImage(buffer, filename, mimeType) {
  const content = (await getLLM().describeMedia({
    mimeType,
    dataBase64: buffer.toString("base64"),
    instruction: "이 이미지의 모든 텍스트를 손실 없이 추출(OCR)하고, 도표·차트·그림의 의미를 종합하여 하나의 조리 있는 지식 요약글로 작성해줘.",
  })).trim();

  if (!content) throw new Error("이미지에서 내용을 추출하지 못했습니다.");
  return { content, metadata: { title: filename || "이미지 문서", date: new Date().toISOString(), mimeType } };
}

// ── YouTube ──────────────────────────────────────────
export async function parseYouTube(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) throw new Error(`유효하지 않은 YouTube URL: ${url}`);

  let title = `YouTube 영상 (${videoId})`;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (res.ok) title = (await res.json()).title || title;
  } catch { /* 제목 실패해도 계속 */ }

  let transcript = "";
  try {
    transcript = await fetchTranscript(videoId);
  } catch { /* 자막 없으면 메타데이터만 */ }

  return {
    content: transcript
      ? `# ${title}\n\n${transcript}`
      : `# ${title}\n\n[자막을 가져올 수 없습니다. 영상을 직접 확인해주세요.]`,
    metadata: {
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      date: new Date().toISOString(),
      hasTranscript: !!transcript,
    },
  };
}

async function fetchTranscript(videoId) {
  try {
    const list = await YoutubeTranscript.fetchTranscript(videoId, { lang: "ko" });
    return list.map((t) => t.text).join(" ");
  } catch {
    const list = await YoutubeTranscript.fetchTranscript(videoId);
    return list.map((t) => t.text).join(" ");
  }
}

// ── 유틸 ─────────────────────────────────────────────
function stripHTML(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50000);
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

function extractYouTubeVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}
