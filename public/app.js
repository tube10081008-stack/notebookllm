// BrainStation 2 — 프런트엔드
// 렌더링 원칙 (v1 문제 ⑫의 답): escape-first.
// 모든 동적 문자열은 esc()를 통과한 뒤에만 DOM에 들어간다.
// LLM 답변의 **볼드**만 이스케이프 이후에 제한적으로 복원한다 (renderRich).

const $ = (id) => document.getElementById(id);

// ── 안전 렌더링 유틸 ─────────────────────────────────
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

// 이스케이프 후 **…** → <strong>, [n] → 인용 배지만 복원. 그 외 마크업은 전부 텍스트로 남는다.
function renderRich(str) {
  return esc(str)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

// ── API (401 시 토큰 프롬프트 → localStorage) ────────
async function api(path, options = {}) {
  const token = localStorage.getItem("bs2_token");
  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(`/api${path}`, { ...options, headers });
  if (res.status === 401) {
    const t = prompt("이 서버는 인증이 필요합니다. AUTH_TOKEN을 입력하세요:");
    if (t) {
      localStorage.setItem("bs2_token", t);
      return api(path, options);
    }
    throw new Error("인증 실패");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function toast(msg, ms = 2800) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), ms);
}

// ── 앱 상태 ──────────────────────────────────────────
const App = {
  stations: [],
  presets: [],
  current: null,

  async init() {
    $("brandHome").onclick = () => this.showHome();
    $("newStationBtn").onclick = () => this.showCreateModal();
    $("councilBtn").onclick = () => this.showCouncilModal();
    $("modalClose").onclick = () => this.closeModal();
    $("modalBackdrop").onclick = (e) => { if (e.target === $("modalBackdrop")) this.closeModal(); };
    $("chatForm").onsubmit = (e) => { e.preventDefault(); this.ask(); };
    $("notesSearch").oninput = () => this.loadNotes();
    $("ingestSubmit").onclick = () => this.ingestText();
    $("ingestFileSubmit").onclick = () => this.ingestFile();
    $("gcRun").onclick = () => this.runGC();
    $("scoutRun").onclick = () => this.runScout();
    $("charterEdit").onclick = () => this.showCharterModal();

    document.querySelectorAll("#tabs .tab").forEach((btn) => {
      btn.onclick = () => this.switchTab(btn.dataset.tab);
    });
    document.querySelectorAll("#ingestTypeSeg .seg-btn").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll("#ingestTypeSeg .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      };
    });

    try {
      const [{ presets }, health] = await Promise.all([api("/presets"), api("/health")]);
      this.presets = presets;
      $("headerStats").textContent = `${health.llm.provider} · ${health.llm.textModel}`;
    } catch (err) { toast(err.message); }

    await this.showHome();
  },

  // ── 홈 ──
  async showHome() {
    $("homeView").classList.remove("hidden");
    $("stationView").classList.add("hidden");
    this.current = null;
    try {
      const { stations } = await api("/stations");
      this.stations = stations;
      this.renderStations();
    } catch (err) { toast(err.message); }
  },

  renderStations() {
    const grid = $("stationsGrid");
    grid.replaceChildren();
    if (this.stations.length === 0) {
      grid.innerHTML = `<div class="empty-state"><div class="icon">🧠</div><p>첫 스테이션을 만들어 10년 지식 자산을 시작하세요.</p></div>`;
      return;
    }
    for (const s of this.stations) {
      const card = document.createElement("div");
      card.className = "station-card";
      card.style.setProperty("--card-color", s.color || "#7C3AED");
      card.innerHTML = `
        <div class="icon">${esc(s.icon)}</div>
        <h3>${esc(s.name)}</h3>
        <div class="desc">${esc(s.description || "")}</div>
        <div class="meta">
          <span>${esc(s.agent?.avatar || "")} ${esc(s.agent?.name || "")}</span>
          <span>${esc(String(s.gamification?.badge || ""))} Lv.${Number(s.gamification?.level) || 1} · 노트 ${Number(s.stats?.note_count) || 0}</span>
        </div>`;
      card.onclick = () => this.openStation(s.id);
      grid.appendChild(card);
    }
  },

  // ── 스테이션 ──
  async openStation(id) {
    try {
      const { station } = await api(`/stations/${encodeURIComponent(id)}`);
      this.current = station;
      $("homeView").classList.add("hidden");
      $("stationView").classList.remove("hidden");

      $("stationHeader").innerHTML = `
        <span class="avatar">${esc(station.agent?.avatar || "🧠")}</span>
        <div>
          <h2>${esc(station.name)}<span class="badge">${esc(station.gamification?.badge || "")} Lv.${Number(station.gamification?.level) || 1} ${esc(station.gamification?.title || "")}</span></h2>
          <div class="sub">${esc(station.agent?.name || "")} · ${esc(station.agent?.expertise || "")} · 노트 ${Number(station.stats?.note_count) || 0} · 질문 ${Number(station.stats?.query_count) || 0}</div>
        </div>
        <div class="spacer"></div>
        <button class="btn danger" id="detachBtn">스테이션 분리</button>`;
      $("detachBtn").onclick = () => this.detachStation();

      this.switchTab("chat");
      await this.loadChats();
    } catch (err) { toast(err.message); }
  },

  async detachStation() {
    if (!confirm(`"${this.current.name}"을(를) 목록에서 분리할까요?\n(지식 데이터 디렉토리는 삭제되지 않고 보존됩니다)`)) return;
    try {
      const { message } = await api(`/stations/${encodeURIComponent(this.current.id)}`, { method: "DELETE" });
      toast(message);
      this.showHome();
    } catch (err) { toast(err.message); }
  },

  switchTab(name) {
    document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    for (const panel of ["chat", "ingest", "inbox", "notes", "timeline", "garden"]) {
      $(`panel-${panel}`).classList.toggle("hidden", panel !== name);
    }
    if (name === "notes") this.loadNotes();
    if (name === "timeline") this.loadTimeline();
    if (name === "inbox") this.loadInbox();
  },

  // ── 대화 ──
  async loadChats() {
    const box = $("chatMessages");
    box.replaceChildren();
    try {
      const { chats } = await api(`/stations/${encodeURIComponent(this.current.id)}/chats`);
      if (chats.length === 0) {
        box.innerHTML = `<div class="empty-state"><div class="icon">💬</div><p>${esc(this.current.agent?.greeting || "첫 대화를 시작해 보세요!")}</p></div>`;
        return;
      }
      for (const c of chats.slice(-30)) {
        this.appendUserMsg(c.question);
        this.appendAgentMsg(c);
      }
      box.scrollTop = box.scrollHeight;
    } catch (err) { toast(err.message); }
  },

  appendUserMsg(text) {
    const div = document.createElement("div");
    div.className = "chat-msg user";
    div.innerHTML = `<div class="msg-avatar">👤</div><div class="msg-bubble">${esc(text)}</div>`;
    $("chatMessages").appendChild(div);
  },

  appendAgentMsg(data) {
    const div = document.createElement("div");
    div.className = "chat-msg";
    const cites = (data.citations || []).map((c) =>
      `<span class="cite">[${Number(c.index) || "•"}] ${esc(c.title)} <span class="hint">(${Number(c.relevance) || 0})</span>${c.viaGraph ? ' <span class="via-graph">🔗그래프</span>' : ""}${c.weak ? ' <span class="hint">· 약한 관련</span>' : ""}</span>`
    ).join("");
    const cross = (data.crossRecommendations || []).map((r) =>
      `<span>${esc(r.agentAvatar || "")} ${esc(r.stationName)}: ${esc(r.title)}</span>`
    ).join(" · ");
    div.innerHTML = `
      <div class="msg-avatar">${esc(this.current?.agent?.avatar || "🧠")}</div>
      <div class="msg-bubble">
        ${renderRich(data.answer || "")}
        ${data.confidence ? `<span class="conf ${esc(data.confidence)}">${esc(data.confidence)}</span>` : ""}
        ${data.blended ? `<span class="conf blended">🌐 일반 지식 혼합</span>` : ""}
        ${cites ? `<div class="citations">${cites}</div>` : ""}
        ${cross ? `<div class="cross-rec">🔭 다른 스테이션: ${cross}</div>` : ""}
      </div>`;
    $("chatMessages").appendChild(div);
  },

  async ask() {
    const input = $("chatQuestion");
    const q = input.value.trim();
    if (!q || !this.current) return;
    input.value = "";
    this.appendUserMsg(q);

    const loading = document.createElement("div");
    loading.className = "chat-msg";
    loading.innerHTML = `<div class="msg-avatar">${esc(this.current.agent?.avatar || "🧠")}</div><div class="msg-bubble"><span class="loading-spinner"></span>생각 중...</div>`;
    $("chatMessages").appendChild(loading);
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;

    try {
      const data = await api(`/stations/${encodeURIComponent(this.current.id)}/query`, {
        method: "POST",
        body: { question: q },
      });
      loading.remove();
      this.appendAgentMsg(data);
      if (data.xp) toast(`+${data.xp.xpGain} XP (총 ${data.xp.totalXP})`);
    } catch (err) {
      loading.remove();
      this.appendAgentMsg({ answer: `오류: ${err.message}`, confidence: "low" });
    }
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  },

  // ── 수집 ──
  async ingestText() {
    const type = document.querySelector("#ingestTypeSeg .seg-btn.active")?.dataset.type || "text";
    const content = $("ingestContent").value.trim();
    if (!content) return toast("내용을 입력하세요.");
    await this.doIngest({ method: "POST", body: { type, content } });
  },

  async ingestFile() {
    const file = $("ingestFile").files[0];
    if (!file) return toast("파일을 선택하세요.");
    const fd = new FormData();
    fd.append("file", file);
    await this.doIngest({ method: "POST", body: fd });
  },

  async doIngest(options) {
    const btns = [$("ingestSubmit"), $("ingestFileSubmit")];
    btns.forEach((b) => (b.disabled = true));
    $("ingestResults").innerHTML = `<div class="hint"><span class="loading-spinner"></span>원문 보존 → 증류 → 임베딩 → 그래프 연결 중...</div>`;
    try {
      const data = await api(`/stations/${encodeURIComponent(this.current.id)}/ingest`, options);
      $("ingestContent").value = "";
      $("ingestFile").value = "";
      const items = (data.notes || []).map((n) => `
        <div class="note-card">
          <h4>${esc(n.title)}</h4>
          <div class="preview">${esc((n.content || "").slice(0, 160))}</div>
          <div class="tags">
            <span class="tag type">${esc(n.type)}</span>
            ${(n.topics || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
            <span class="tag">신뢰도 ${Number(n.confidence) || 0}</span>
          </div>
        </div>`).join("");
      $("ingestResults").innerHTML = `<div class="hint">✅ ${esc(data.message)}</div>${items}`;
      toast(data.message);
    } catch (err) {
      $("ingestResults").innerHTML = `<div class="hint">❌ ${esc(err.message)}</div>`;
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  },

  // ── 노트 ──
  async loadNotes() {
    if (!this.current) return;
    const q = $("notesSearch").value.trim();
    try {
      const { total, notes } = await api(`/stations/${encodeURIComponent(this.current.id)}/notes${q ? `?search=${encodeURIComponent(q)}` : ""}`);
      $("notesCount").textContent = `${total}개`;
      const grid = $("notesGrid");
      grid.replaceChildren();
      if (notes.length === 0) {
        grid.innerHTML = `<div class="empty-state"><div class="icon">📝</div><p>아직 노트가 없습니다. 수집 탭에서 시작하세요.</p></div>`;
        return;
      }
      for (const n of notes) {
        const card = document.createElement("div");
        card.className = "note-card";
        card.innerHTML = `
          <h4>${esc(n.title)}</h4>
          <div class="preview">${esc(n.contentPreview || "")}</div>
          <div class="tags">
            <span class="tag type">${esc(n.type)}</span>
            ${(n.topics || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
            ${n.my_take ? `<span class="tag">💭 내 생각</span>` : ""}
          </div>`;
        card.onclick = () => this.showNoteDetail(n.id);
        grid.appendChild(card);
      }
    } catch (err) { toast(err.message); }
  },

  async showNoteDetail(noteId) {
    try {
      const n = await api(`/stations/${encodeURIComponent(this.current.id)}/notes/${encodeURIComponent(noteId)}`);
      const links = (n.graph_links || []).map((l) => `
        <div class="link-row">${l.direction === "out" ? "→" : "←"}
          <span class="rel ${esc(l.relation)}">${esc(l.relation)}</span> ${esc(l.title)}</div>`).join("");
      this.openModal(`
        <div class="note-detail">
          <h3>${esc(n.title)}</h3>
          <div class="field">타입 ${esc(n.type)} · 신뢰도 ${Number(n.confidence) || 0} · 반감기 ${esc(n.half_life)} · ${esc((n.created_at || "").slice(0, 10))}</div>
          ${n.source?.title || n.source?.url ? `<div class="field">📎 출처: ${esc(n.source.title || "")} ${n.source.url ? `(${esc(n.source.url)})` : ""}</div>` : ""}
          ${n.source?.raw_ref ? `<div class="field">🗄 원문: ${esc(n.source.raw_ref)}</div>` : ""}
          <div class="content">${esc(n.content)}</div>
          ${n.why_saved ? `<div class="field">💡 저장 이유: ${esc(n.why_saved)}</div>` : ""}
          ${links ? `<div class="links"><strong>🔗 연결된 지식</strong>${links}</div>` : `<div class="links hint">아직 연결이 없습니다 (고아 노드).</div>`}
          <label style="margin-top:14px">💭 내 생각 (my take) — 지식을 내 것으로 만드는 한 줄</label>
          <textarea id="myTakeInput" rows="3">${esc(n.my_take || "")}</textarea>
          <div class="modal-actions">
            <button class="btn danger" id="noteDeleteBtn">삭제</button>
            <button class="btn primary" id="myTakeSave">저장</button>
          </div>
        </div>`);
      $("myTakeSave").onclick = async () => {
        try {
          const { xp } = await api(`/stations/${encodeURIComponent(this.current.id)}/notes/${encodeURIComponent(noteId)}`, {
            method: "PUT",
            body: { my_take: $("myTakeInput").value },
          });
          toast(xp ? `내 생각 저장! +${xp.xpGain} XP` : "저장되었습니다.");
          this.closeModal();
          this.loadNotes();
        } catch (err) { toast(err.message); }
      };
      $("noteDeleteBtn").onclick = async () => {
        if (!confirm("이 노트를 삭제할까요? (원문 raw는 보존됩니다)")) return;
        try {
          await api(`/stations/${encodeURIComponent(this.current.id)}/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
          toast("노트가 삭제되었습니다.");
          this.closeModal();
          this.loadNotes();
        } catch (err) { toast(err.message); }
      };
    } catch (err) { toast(err.message); }
  },

  // ── 타임라인 ──
  async loadTimeline() {
    try {
      const { events } = await api(`/stations/${encodeURIComponent(this.current.id)}/events?limit=100`);
      const list = $("timelineList");
      list.replaceChildren();
      if (events.length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="icon">🕐</div><p>아직 기록된 이벤트가 없습니다.</p></div>`;
        return;
      }
      for (const e of [...events].reverse()) {
        const { ts, type, ...rest } = e;
        const row = document.createElement("div");
        row.className = "event-row";
        row.innerHTML = `
          <span class="ts">${esc((ts || "").replace("T", " ").slice(0, 16))}</span>
          <span class="type">${esc(type)}</span>
          <span class="detail">${esc(JSON.stringify(rest))}</span>`;
        list.appendChild(row);
      }
    } catch (err) { toast(err.message); }
  },

  // ── 정원 (GC) ──
  async runGC() {
    $("gcRun").disabled = true;
    $("gcResults").innerHTML = `<div class="hint"><span class="loading-spinner"></span>정원 점검 중...</div>`;
    try {
      const r = await api(`/stations/${encodeURIComponent(this.current.id)}/gc`, { method: "POST" });
      const section = (title, items, render) => items.length
        ? `<div class="gc-section"><h4>${title} (${items.length})</h4><ul>${items.slice(0, 20).map(render).join("")}</ul></div>`
        : "";
      $("gcResults").innerHTML = `
        <div class="hint">노트 ${Number(r.totals?.notes) || 0} · 엣지 ${Number(r.totals?.edges) || 0} — 아래는 <strong>제안</strong>입니다. 시스템은 아무것도 삭제하지 않았습니다.</div>
        ${section("🔁 중복 후보", r.duplicates, (d) => `<li>"${esc(d.a.title)}" ≈ "${esc(d.b.title)}" (${Number(d.similarity)})</li>`)}
        ${section("🏝 고아 노드 (연결 없음)", r.orphans, (o) => `<li>${esc(o.title)}</li>`)}
        ${section("⏳ 반감기 만료", r.expired, (x) => `<li>${esc(x.title)} (${esc(x.half_life)})</li>`)}
        ${section("⚡ 모순 관계", r.contradictions, (c) => `<li>${esc(c.source)} ↔ ${esc(c.target)}</li>`)}
        ${!r.duplicates.length && !r.orphans.length && !r.expired.length && !r.contradictions.length
          ? `<div class="gc-section">🌿 정원이 깨끗합니다.</div>` : ""}`;
    } catch (err) {
      $("gcResults").innerHTML = `<div class="hint">❌ ${esc(err.message)}</div>`;
    } finally {
      $("gcRun").disabled = false;
    }
  },

  // ── 수집함 (Inbox) ──
  async loadInbox() {
    if (!this.current) return;
    const sid = encodeURIComponent(this.current.id);
    try {
      const [{ charter }, { pending, history }] = await Promise.all([
        api(`/stations/${sid}/charter`),
        api(`/stations/${sid}/inbox`),
      ]);
      this._charter = charter;

      $("charterCard").innerHTML = `
        <h3>📜 지식 헌장</h3>
        <div class="charter-row"><strong>목적:</strong> ${esc(charter.purpose || "(미설정 — 헌장 편집에서 방향을 정하세요)")}</div>
        <div class="charter-row"><strong>토픽:</strong> ${(charter.topics || []).map((t) => `<span class="tag type">${esc(t)}</span>`).join(" ") || "없음"}</div>
        <div class="charter-row"><strong>제외:</strong> ${(charter.exclude || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(" ") || "없음"}</div>
        <div class="charter-row"><strong>신뢰 소스:</strong> ${(charter.feeds || []).length}개 피드 · 제안 상한 ${Number(charter.max_proposals) || 8}개</div>
        <div class="charter-row"><strong>학습된 거절:</strong> ${(charter.learned || []).length}건</div>`;

      const list = $("inboxList");
      list.replaceChildren();
      if (pending.length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="icon">📡</div><p>대기 중인 제안이 없습니다. 스카우트를 실행해 보세요.</p></div>`;
      }
      for (const item of pending) {
        const el = document.createElement("div");
        el.className = "inbox-item";
        el.innerHTML = `
          <h4><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title || item.url)}</a></h4>
          <div class="summary">${esc(item.summary || "")}</div>
          <div class="item-meta">
            ${(item.matchedTopics || []).map((t) => `<span class="tag type">토픽: ${esc(t)}</span>`).join("")}
            ${(item.matchedGaps || []).map((g) => `<span class="tag gap-match">결핍: ${esc(g)}</span>`).join("")}
            <span class="tag novelty">신규성 ${Number(item.novelty) || 0}</span>
          </div>
          <div class="actions">
            <button class="btn primary" data-act="accept">✅ 승인 → 지식화</button>
            <button class="btn danger" data-act="reject">✕ 거절</button>
          </div>`;
        el.querySelector('[data-act="accept"]').onclick = () => this.resolveInbox(item.id, "accept");
        el.querySelector('[data-act="reject"]').onclick = () => this.resolveInbox(item.id, "reject");
        list.appendChild(el);
      }
      if (history.length > 0) {
        const hist = document.createElement("div");
        hist.className = "hint";
        hist.textContent = `처분 이력: 승인 ${history.filter((h) => h.status === "accepted").length} · 거절 ${history.filter((h) => h.status === "rejected").length}`;
        list.appendChild(hist);
      }
    } catch (err) { toast(err.message); }
  },

  async runScout() {
    $("scoutRun").disabled = true;
    $("inboxList").innerHTML = `<div class="hint"><span class="loading-spinner"></span>피드 수집 → 키워드·결핍 매칭 → 신규성 검사 중...</div>`;
    try {
      const r = await api(`/stations/${encodeURIComponent(this.current.id)}/scout`, { method: "POST" });
      if (r.message) toast(r.message, 4000);
      else toast(`후보 ${r.collected}건 중 ${r.proposed.length}건 제안 (이미 앎 ${r.skipped.known} · 무관 ${r.skipped.noMatch} · 제외어 ${r.skipped.excluded})`, 4500);
      if (r.feedErrors?.length) toast(`⚠️ 피드 ${r.feedErrors.length}개 실패: ${r.feedErrors[0].error}`, 4000);
      await this.loadInbox();
    } catch (err) {
      toast(err.message);
      await this.loadInbox();
    } finally {
      $("scoutRun").disabled = false;
    }
  },

  async resolveInbox(itemId, action) {
    const sid = encodeURIComponent(this.current.id);
    try {
      if (action === "accept") {
        toast("승인 → 원문 보존·증류·그래프 연결 중...", 5000);
        const r = await api(`/stations/${sid}/inbox/${encodeURIComponent(itemId)}/accept`, { method: "POST" });
        toast(r.message);
      } else {
        const reason = prompt("거절 사유 (헌장에 학습되어 미래 수집을 개선합니다):") || "";
        await api(`/stations/${sid}/inbox/${encodeURIComponent(itemId)}/reject`, { method: "POST", body: { reason } });
        toast("거절 — 사유가 헌장에 학습되었습니다.");
      }
      await this.loadInbox();
    } catch (err) { toast(err.message); }
  },

  // ── 헌장 편집 모달 ──
  showCharterModal(onSaved = null) {
    const c = this._charter || {};
    this.openModal(`
      <h2>📜 지식 헌장 — 이 스테이션의 방향</h2>
      <div class="form-row"><label>Q1. 이 스테이션은 무엇을 위해 존재하나요?</label>
        <input type="text" id="chPurpose" value="${esc(c.purpose || "")}" placeholder="예: RAG·파인튜닝 최신 기법을 실무에 적용하기 위한 연구 기지" /></div>
      <div class="form-row"><label>Q2. 핵심 토픽 (쉼표 구분)</label>
        <input type="text" id="chTopics" value="${esc((c.topics || []).join(", "))}" placeholder="예: RAG, LoRA, 파인튜닝, 임베딩" /></div>
      <div class="form-row"><label>Q3. 제외할 키워드 (쉼표 구분)</label>
        <input type="text" id="chExclude" value="${esc((c.exclude || []).join(", "))}" placeholder="예: 광고, 채용, 홍보" /></div>
      <div class="form-row"><label>Q4. 신뢰 소스 — RSS/Atom URL (한 줄에 하나)</label>
        <textarea id="chFeeds" rows="4" placeholder="https://www.youtube.com/feeds/videos.xml?channel_id=...\nhttp://export.arxiv.org/api/query?search_query=all:RAG&max_results=20">${esc((c.feeds || []).join("\n"))}</textarea></div>
      <div class="form-row"><label>Q5. 스카우트 1회 제안 상한</label>
        <input type="text" id="chMax" value="${esc(String(c.max_proposals || 8))}" /></div>
      <div class="modal-actions"><button class="btn primary" id="chSave">저장</button></div>`);

    $("chSave").onclick = async () => {
      try {
        const body = {
          purpose: $("chPurpose").value,
          topics: $("chTopics").value,
          exclude: $("chExclude").value,
          feeds: $("chFeeds").value,
          max_proposals: $("chMax").value,
        };
        const { charter } = await api(`/stations/${encodeURIComponent(this.current.id)}/charter`, { method: "PUT", body });
        this._charter = charter;
        this.closeModal();
        toast("헌장이 저장되었습니다.");
        if (onSaved) onSaved(charter); else this.loadInbox();
      } catch (err) { toast(err.message); }
    };
  },

  // ── 스테이션 생성 모달 ──
  showCreateModal() {
    let selected = this.presets[0]?.key || "researcher";
    this.openModal(`
      <h2>새 스테이션</h2>
      <div class="form-row"><label>이름</label><input type="text" id="stName" placeholder="예: AI 논문 연구소" /></div>
      <div class="form-row"><label>에이전트 선택</label><div class="preset-grid" id="presetGrid"></div></div>
      <h2 style="margin-top:20px">📜 지식 헌장 설문 <span class="hint" style="font-weight:400">(선택 — 수집·학습 방향을 정합니다)</span></h2>
      <div class="form-row"><label>Q1. 이 스테이션은 무엇을 위해 존재하나요?</label>
        <input type="text" id="stPurpose" placeholder="예: RAG·파인튜닝 최신 기법을 실무에 적용하기 위한 연구 기지" /></div>
      <div class="form-row"><label>Q2. 핵심 토픽 (쉼표 구분)</label>
        <input type="text" id="stTopics" placeholder="예: RAG, LoRA, 파인튜닝, 임베딩" /></div>
      <div class="form-row"><label>Q3. 제외할 키워드 (쉼표 구분)</label>
        <input type="text" id="stExclude" placeholder="예: 광고, 채용" /></div>
      <div class="form-row"><label>Q4. 신뢰 소스 — RSS/Atom URL (한 줄에 하나)</label>
        <textarea id="stFeeds" rows="3" placeholder="arXiv·유튜브 채널·블로그의 RSS 주소"></textarea></div>
      <div class="modal-actions"><button class="btn primary" id="stCreate">생성</button></div>`);

    const grid = $("presetGrid");
    for (const p of this.presets) {
      const card = document.createElement("div");
      card.className = `preset-card${p.key === selected ? " active" : ""}`;
      card.innerHTML = `<span class="avatar">${esc(p.avatar)}</span>${esc(p.name)}<br><span class="hint">${esc(p.expertise)}</span>`;
      card.onclick = () => {
        selected = p.key;
        grid.querySelectorAll(".preset-card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");
      };
      grid.appendChild(card);
    }

    $("stCreate").onclick = async () => {
      const name = $("stName").value.trim();
      if (!name) return toast("이름을 입력하세요.");
      try {
        const purpose = $("stPurpose").value.trim();
        const charter = {
          purpose,
          topics: $("stTopics").value,
          exclude: $("stExclude").value,
          feeds: $("stFeeds").value,
        };
        await api("/stations", {
          method: "POST",
          body: { name, description: purpose, presetKey: selected, charter },
        });
        this.closeModal();
        toast("스테이션이 생성되었습니다. 수집함 탭에서 스카우트를 실행해 보세요.");
        this.showHome();
      } catch (err) { toast(err.message); }
    };
  },

  // ── 협의회 모달 ──
  showCouncilModal() {
    this.openModal(`
      <h2>🏛️ 협의회 — 모든 에이전트에게 동시에 묻기</h2>
      <div class="form-row"><input type="text" id="councilQ" placeholder="여러 관점이 필요한 질문..." /></div>
      <div class="modal-actions"><button class="btn primary" id="councilAsk">질문</button></div>
      <div id="councilResults"></div>`);
    $("councilAsk").onclick = async () => {
      const q = $("councilQ").value.trim();
      if (!q) return;
      $("councilResults").innerHTML = `<div class="hint"><span class="loading-spinner"></span>에이전트들이 각자의 지식으로 답변 중...</div>`;
      try {
        const { responses } = await api("/council", { method: "POST", body: { question: q } });
        $("councilResults").innerHTML = responses.map((r) => `
          <div class="council-response">
            <div class="who">${esc(r.agent?.avatar || "")} <strong>${esc(r.agent?.name || "")}</strong> — ${esc(r.stationName)}
              ${r.hasContext ? `<span class="tag">노트 ${Number(r.notesUsed)}개 참조</span>` : `<span class="tag expired">자료 없음</span>`}</div>
            <div class="ans">${renderRich(r.answer || "")}</div>
          </div>`).join("");
      } catch (err) {
        $("councilResults").innerHTML = `<div class="hint">❌ ${esc(err.message)}</div>`;
      }
    };
  },

  openModal(html) {
    $("modalContent").innerHTML = html;
    $("modalBackdrop").classList.remove("hidden");
  },

  closeModal() {
    $("modalBackdrop").classList.add("hidden");
    $("modalContent").replaceChildren();
  },
};

App.init();
