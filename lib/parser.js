// lib/parser.js — 콘텐츠 파서 (텍스트, URL, PDF, YouTube)
import { createRequire } from "module";
import { YoutubeTranscript } from "youtube-transcript";

// pdf-parse는 CJS 모듈이라 createRequire로 불러옵니다
const require = createRequire(import.meta.url);

// ── 공통 결과 형태 ───────────────────────────────────
// { content: string, metadata: { title, url?, author?, date? } }

// ── 텍스트 파싱 ──────────────────────────────────────
export function parseText(rawText) {
  const trimmed = (rawText || "").trim();

  // 첫 줄을 제목으로 사용 (마크다운 헤더 '#' 제거)
  const firstLine = trimmed.split("\n")[0] || "제목 없음";
  const title = firstLine.replace(/^#+\s*/, "").trim();

  return {
    content: trimmed,
    metadata: {
      title,
      date: new Date().toISOString(),
    },
  };
}

// ── URL 파싱 (HTML → 텍스트) ─────────────────────────
export async function parseURL(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; SecondBrain/1.0; +https://localhost)",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`URL 가져오기 실패: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();

  // HTML 태그 제거 + 텍스트 추출
  const text = stripHTML(html);
  const title = extractTitle(html) || url;

  return {
    content: text,
    metadata: {
      title,
      url,
      date: new Date().toISOString(),
    },
  };
}

// ── PDF 파싱 ─────────────────────────────────────────
export async function parsePDF(buffer, filename) {
  const pdfParse = require("pdf-parse");
  let content = "";
  let isOcrFallback = false;
  let pages = 0;

  try {
    const data = await pdfParse(buffer);
    content = (data.text || "").trim();
    pages = data.numpages || 0;
  } catch (err) {
    console.warn("⚠️ pdf-parse 실패, Gemini OCR 폴백 시도:", err.message);
  }

  // 텍스트가 너무 없으면 스캔 이미지 PDF로 판정하고 Gemini OCR 기동
  if (content.length < 100) {
    console.log(`🔍 [${filename}] 텍스트 추출 부족 (${content.length}자). Gemini OCR 작동 중...`);
    try {
      const { ai, TEXT_MODEL } = await import("./gemini.js");
      const base64Data = buffer.toString("base64");
      const response = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: base64Data,
            },
          },
          "이 PDF 스캔본 문서에 포함된 모든 이미지 및 페이지 속의 글자(OCR)를 식별하여, 단 한 글자도 생략하지 말고 모든 본문 텍스트 내용을 한글로 정확하게 복원해서 반환해줘."
        ],
      });
      
      content = (response.text || "").trim();
      isOcrFallback = true;
      console.log(`✅ Gemini OCR 완료: ${content.length}자 추출 성공.`);
    } catch (geminiErr) {
      console.error("❌ Gemini OCR 추출 실패:", geminiErr.message);
    }
  }

  return {
    content,
    metadata: {
      title: filename || "PDF 문서",
      pages,
      date: new Date().toISOString(),
      isOcrFallback,
    },
  };
}

// ── YouTube 파싱 ─────────────────────────────────────
export async function parseYouTube(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    throw new Error(`유효하지 않은 YouTube URL: ${url}`);
  }

  // oEmbed로 제목 가져오기
  let title = `YouTube 영상 (${videoId})`;
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      title = data.title || title;
    }
  } catch {
    // oEmbed 실패해도 계속 진행
  }

  // 자막(transcript) 시도 — innertube API
  let transcript = "";
  try {
    transcript = await fetchYouTubeTranscript(videoId);
  } catch {
    // 자막 없으면 메타데이터만 반환
  }

  const content = transcript
    ? `# ${title}\n\n${transcript}`
    : `# ${title}\n\n[자막을 가져올 수 없습니다. 영상을 직접 확인해주세요.]`;

  return {
    content,
    metadata: {
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      date: new Date().toISOString(),
      hasTranscript: !!transcript,
    },
  };
}

// ── 유틸리티 함수들 ──────────────────────────────────

function stripHTML(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "") // script 제거
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") // style 제거
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "") // nav 제거
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ") // 모든 태그 → 공백
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ") // 연속 공백 정리
    .trim()
    .slice(0, 50000); // 최대 50K 글자
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : null;
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

async function fetchYouTubeTranscript(videoId) {
  try {
    // 1) 한국어 자막 우선 시도
    const transcriptList = await YoutubeTranscript.fetchTranscript(videoId, { lang: "ko" });
    return transcriptList.map(t => t.text).join(" ");
  } catch (err) {
    try {
      // 2) 한국어 자막 실패 시 기본 제공되는 자막(영어/자동생성 등)으로 폴백 시도
      const transcriptList = await YoutubeTranscript.fetchTranscript(videoId);
      return transcriptList.map(t => t.text).join(" ");
    } catch (innerErr) {
      throw new Error(`유튜브 자막을 가져오지 못했습니다: ${innerErr.message}`);
    }
  }
}

// ── 이미지 파싱 (Gemini Multimodal) ───────────────────
export async function parseImage(buffer, filename, mimeType) {
  const { ai, TEXT_MODEL } = await import("./gemini.js");
  const base64Data = buffer.toString("base64");
  let content = "";

  try {
    console.log(`🔍 [${filename}] 이미지 분석 중 (${mimeType})...`);
    const response = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Data,
          },
        },
        "이 이미지에 있는 모든 텍스트를 손실 없이 추출(OCR)하고, 이미지 내의 도표, 차트, 그림 및 사물들이 무엇을 의미하고 설명하는지 종합하여 하나의 조리 있고 완벽한 지식 요약글로 작성해줘."
      ],
    });
    
    content = (response.text || "").trim();
    console.log(`✅ 이미지 분석 완료: ${content.length}자 추출 성공.`);
  } catch (err) {
    console.error("❌ 이미지 분석 실패:", err.message);
    throw new Error(`이미지 분석에 실패했습니다: ${err.message}`);
  }

  return {
    content,
    metadata: {
      title: filename || "이미지 문서",
      date: new Date().toISOString(),
      mimeType,
    },
  };
}
