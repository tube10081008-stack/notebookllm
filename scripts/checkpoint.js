// scripts/checkpoint.js — 지식 워크스페이스 git 체크포인트
//
// "세션은 임시, 지식은 커밋으로 영속화" (claudeWIKI 운영 원칙)의 자동화.
// WORKSPACE_ROOT가 git 저장소일 때: 변경 사항을 요약해 커밋한다. push는 사용자의 결정.
// (P-Reinforce Step 8의 교훈: 커밋까지는 자동화 가치가 확실하고, push는 인증·원격 실패가 얽힌다)
import { execFileSync } from "child_process";
import path from "path";
import { config } from "../src/config.js";

const root = config.workspaceRoot;

function git(...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

function main() {
  // 가드: 워크스페이스 "자체"가 git 저장소여야 한다.
  // git은 상위 디렉토리로 저장소를 탐색하므로, 이 확인 없이는 워크스페이스가
  // 코드 저장소 안에 있을 때 코드 저장소 전체를 커밋해버린다 (조용한 덮어쓰기 — 불변식 위반).
  let toplevel = null;
  try { toplevel = git("rev-parse", "--show-toplevel"); } catch { /* git 저장소 아님 */ }

  if (!toplevel || path.resolve(toplevel) !== path.resolve(root)) {
    if (toplevel) {
      console.error(`⛔ 워크스페이스(${root})가 자체 git 저장소가 아니라`);
      console.error(`   상위 저장소(${toplevel}) 안에 있습니다. 커밋을 거부합니다.`);
    } else {
      console.error(`워크스페이스가 git 저장소가 아닙니다: ${root}`);
    }
    console.error(`10년 데이터라면 다음을 권장합니다:`);
    console.error(`  cd "${root}" && git init && git add -A && git commit -m "지식 워크스페이스 시작"`);
    console.error(`  (그리고 GitHub에 private 저장소로 push)`);
    process.exit(1);
  }

  const status = git("status", "--porcelain");
  if (!status) {
    console.log("✨ 변경 사항 없음 — 워크스페이스는 이미 체크포인트 상태입니다.");
    return;
  }

  const lines = status.split("\n");
  const added = lines.filter((l) => l.startsWith("??") || l.startsWith("A")).length;
  const modified = lines.filter((l) => l.startsWith(" M") || l.startsWith("M")).length;
  const deleted = lines.filter((l) => l.startsWith(" D") || l.startsWith("D")).length;

  git("add", "-A");
  const msg = `checkpoint: 지식 워크스페이스 (${new Date().toISOString().slice(0, 16)}) — 신규 ${added}, 수정 ${modified}, 삭제 ${deleted}`;
  git("commit", "-m", msg);
  console.log(`✅ 커밋 완료: ${msg}`);
  console.log(`➡️  원격 백업: cd "${root}" && git push`);
}

main();
