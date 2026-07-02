// app.js — BrainStation 프론트엔드 로직
const app = {
  currentView: 'hub', // hub | station | council
  currentStation: null,
  currentSection: 'ingest',
  stations: [],
  presets: [],
  chatHistory: [],

  // ── 초기화 ─────────────────────────────────────
  async init() {
    await this.loadPresets();
    await this.loadStations();
    this.showHub();
  },

  // ── API 헬퍼 ───────────────────────────────────
  async api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || '요청 실패');
    }
    return res.json();
  },

  // ── 데이터 로드 ────────────────────────────────
  async loadPresets() {
    try {
      const data = await this.api('/api/presets');
      this.presets = data.presets || [];
    } catch { this.presets = []; }
  },

  async loadStations() {
    try {
      const data = await this.api('/api/stations');
      this.stations = data.stations || [];
    } catch { this.stations = []; }
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  HUB VIEW
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  showHub() {
    this.currentView = 'hub';
    document.getElementById('hubView').style.display = '';
    document.getElementById('stationView').style.display = 'none';
    document.getElementById('councilView').style.display = 'none';
    document.getElementById('btnHub').style.display = 'none';
    document.getElementById('btnCouncil').style.display = '';
    this.renderHub();
    this.renderHeaderStats();
  },

  renderHub() {
    const grid = document.getElementById('hubGrid');
    grid.innerHTML = this.stations.map(s => {
      const gam = s.gamification || {};
      const progress = gam.level < 7 
        ? this.getLevelProgress(gam)
        : 1;
      return `
        <div class="station-card" style="--station-color:${s.color || '#7C3AED'}" onclick="app.openStation('${s.id}')">
          <div class="agent-avatar">${s.agent?.avatar || '🧠'}</div>
          <div class="station-name">${this.esc(s.name)}</div>
          <div class="agent-name">${s.agent?.avatar || ''} ${this.esc(s.agent?.name || '')} · ${gam.title || '초심자'}</div>
          <div class="station-meta">
            <span>📝 ${s.stats?.note_count || 0} 노트</span>
            <span>💬 ${s.stats?.query_count || 0} 질문</span>
            <span>🔥 ${gam.streak_days || 0}일</span>
          </div>
          <div class="level-bar">
            <div class="level-info">
              <span class="lvl">Lv.${gam.level || 1}</span>
              <span>${gam.xp || 0} XP</span>
            </div>
            <div class="bar"><div class="fill" style="width:${Math.round(progress * 100)}%"></div></div>
          </div>
        </div>`;
    }).join('') + `
      <div class="new-station-card" onclick="app.showCreateModal()">
        <div class="plus">+</div>
        <div>새 스테이션 만들기</div>
      </div>`;
  },

  getLevelProgress(gam) {
    const levels = [0, 100, 300, 600, 1000, 1500, 2500];
    const lv = (gam.level || 1) - 1;
    const cur = levels[lv] || 0;
    const next = levels[lv + 1] || levels[lv] || 100;
    return Math.min(1, ((gam.xp || 0) - cur) / (next - cur || 1));
  },

  renderHeaderStats() {
    const totalNotes = this.stations.reduce((s, st) => s + (st.stats?.note_count || 0), 0);
    const maxStreak = Math.max(0, ...this.stations.map(s => s.gamification?.streak_days || 0));
    const maxLevel = Math.max(1, ...this.stations.map(s => s.gamification?.level || 1));
    document.getElementById('headerStats').innerHTML = `
      <div class="header-stat"><div class="value">${this.stations.length}</div><div class="label">스테이션</div></div>
      <div class="header-stat"><div class="value">${totalNotes}</div><div class="label">총 노트</div></div>
      <div class="header-stat"><div class="value">🔥 ${maxStreak}</div><div class="label">Streak</div></div>
      <div class="header-stat"><div class="value">Lv.${maxLevel}</div><div class="label">최고 레벨</div></div>`;
  },

  // ── 스테이션 생성 모달 ─────────────────────────
  showCreateModal() {
    const presetsHtml = this.presets.map(p => `
      <div class="preset-card" data-key="${p.key}" onclick="app.selectPreset(this)">
        <div class="preset-avatar">${p.avatar}</div>
        <div class="preset-name">${this.esc(p.name)}</div>
        <div class="preset-expertise">${this.esc(p.expertise)}</div>
      </div>`).join('');

    document.getElementById('modalContent').innerHTML = `
      <h2>🆕 새 스테이션 만들기</h2>
      <div class="form-group">
        <label>스테이션 이름</label>
        <input id="newName" placeholder="예: AI 연구 노트">
      </div>
      <div class="form-group">
        <label>설명 (선택)</label>
        <input id="newDesc" placeholder="이 스테이션의 주제나 목적">
      </div>
      <div class="form-group">
        <label>에이전트 선택</label>
        <div class="preset-grid">${presetsHtml}</div>
        <input type="hidden" id="selectedPreset" value="researcher">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="app.closeModal()">취소</button>
        <button class="btn btn-primary" onclick="app.createStation()">🚀 생성</button>
      </div>`;
    document.getElementById('modalOverlay').style.display = 'flex';
  },

  selectPreset(el) {
    document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('selectedPreset').value = el.dataset.key;
  },

  async createStation() {
    const name = document.getElementById('newName').value.trim();
    if (!name) return this.toast('스테이션 이름을 입력하세요', 'error');
    try {
      await this.api('/api/stations', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: document.getElementById('newDesc').value.trim(),
          presetKey: document.getElementById('selectedPreset').value,
        }),
      });
      this.closeModal();
      await this.loadStations();
      this.renderHub();
      this.renderHeaderStats();
      this.toast('🎉 새 스테이션이 생성되었습니다!', 'success');
    } catch (err) { this.toast(err.message, 'error'); }
  },

  closeModal() { document.getElementById('modalOverlay').style.display = 'none'; },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  STATION VIEW
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async openStation(id) {
    await this.loadStations();
    this.currentStation = this.stations.find(s => s.id === id);
    if (!this.currentStation) return;
    this.currentView = 'station';
    this.chatHistory = [];
    document.getElementById('hubView').style.display = 'none';
    document.getElementById('stationView').style.display = '';
    document.getElementById('councilView').style.display = 'none';
    document.getElementById('btnHub').style.display = '';
    document.getElementById('btnCouncil').style.display = '';
    this.renderSidebar();
    this.switchSection('ingest');
  },

  renderSidebar() {
    const s = this.currentStation;
    const gam = s.gamification || {};
    const prog = this.getLevelProgress(gam);
    document.getElementById('sidebar').innerHTML = `
      <div class="agent-profile">
        <span class="avatar">${s.agent?.avatar || '🧠'}</span>
        <div class="name" style="color:${s.color}">${this.esc(s.agent?.name || '')}</div>
        <div class="greeting">"${this.esc(s.agent?.greeting || '')}"</div>
        <div class="level-bar" style="margin-top:12px">
          <div class="level-info">
            <span class="lvl" style="color:${s.color}">Lv.${gam.level || 1} ${gam.title || ''}</span>
            <span>${gam.xp || 0} XP</span>
          </div>
          <div class="bar"><div class="fill" style="width:${Math.round(prog*100)}%;background:${s.color}"></div></div>
        </div>
      </div>
      <div class="stats-mini">
        <div class="stat-box"><div class="val">${s.stats?.note_count || 0}</div><div class="lbl">노트</div></div>
        <div class="stat-box"><div class="val">${s.stats?.query_count || 0}</div><div class="lbl">질문</div></div>
        <div class="stat-box"><div class="val">${s.stats?.source_count || 0}</div><div class="lbl">소스</div></div>
        <div class="stat-box"><div class="val">🔥${gam.streak_days || 0}</div><div class="lbl">Streak</div></div>
      </div>
      <ul class="nav-list">
        <li class="nav-item active" data-sec="ingest" onclick="app.switchSection('ingest')">📥 소스 입력</li>
        <li class="nav-item" data-sec="chat" onclick="app.switchSection('chat')">💬 질문하기</li>
        <li class="nav-item" data-sec="graph" onclick="app.switchSection('graph')">🗺️ 지식 그래프</li>
        <li class="nav-item" data-sec="notes" onclick="app.switchSection('notes')">📋 노트 목록</li>
        <li class="nav-item" data-sec="gc" onclick="app.switchSection('gc')">🧹 정리 에이전트</li>
      </ul>
      <div class="back-btn" onclick="app.showHub()">← 허브로 돌아가기</div>`;
  },

  switchSection(sec) {
    this.currentSection = sec;
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('sec' + sec.charAt(0).toUpperCase() + sec.slice(1))?.classList.add('active');
    // 사이드바 네비 + 모바일 탭바 모두 동기화
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.sec === sec));
    document.querySelectorAll('.mobile-tab').forEach(t => t.classList.toggle('active', t.dataset.sec === sec));
    if (sec === 'notes') this.loadNotes();
    if (sec === 'graph') this.loadGraph();
    if (sec === 'chat') this.loadChats();
  },

  // ── Ingest ─────────────────────────────────────
  initIngestTabs() {
    document.querySelectorAll('.ingest-tab').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('.ingest-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.ingest-input').forEach(i => i.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('ingest' + tab.dataset.type.charAt(0).toUpperCase() + tab.dataset.type.slice(1))?.classList.add('active');
      };
    });
  },

  async ingest() {
    const sid = this.currentStation?.id;
    if (!sid) return;
    const activeTab = document.querySelector('.ingest-tab.active')?.dataset.type || 'text';
    let body, formData;

    if (activeTab === 'text') {
      const val = document.getElementById('textInput').value.trim();
      if (!val) return this.toast('텍스트를 입력하세요', 'error');
      body = JSON.stringify({ type: 'text', content: val });
    } else if (activeTab === 'url') {
      const val = document.getElementById('urlInput').value.trim();
      if (!val) return this.toast('URL을 입력하세요', 'error');
      body = JSON.stringify({ type: 'url', content: val });
    } else if (activeTab === 'youtube') {
      const val = document.getElementById('youtubeInput').value.trim();
      if (!val) return this.toast('YouTube URL을 입력하세요', 'error');
      body = JSON.stringify({ type: 'youtube', content: val });
    } else if (activeTab === 'pdf') {
      const file = document.getElementById('pdfInput').files[0];
      if (!file) return this.toast('PDF 파일을 선택하세요', 'error');
      formData = new FormData();
      formData.append('file', file);
    } else if (activeTab === 'image') {
      const file = document.getElementById('imageInput').files[0];
      if (!file) return this.toast('이미지 파일을 선택하세요', 'error');
      formData = new FormData();
      formData.append('file', file);
    }

    document.getElementById('btnIngest').disabled = true;
    document.getElementById('ingestLoading').style.display = 'flex';

    try {
      const opts = formData
        ? { method: 'POST', body: formData }
        : { method: 'POST', body, headers: { 'Content-Type': 'application/json' } };
      const data = await fetch(`/api/stations/${sid}/ingest`, opts).then(r => r.json());

      if (data.error) throw new Error(data.error);

      // 결과 표시
      document.getElementById('ingestResults').innerHTML = (data.notes || []).map(n => `
        <div class="result-card">
          <span class="note-type type-${n.type}">${n.type}</span>
          <h3 style="margin:8px 0 4px;font-size:0.95rem">${this.esc(n.title)}</h3>
          <p style="font-size:0.82rem;color:var(--text-secondary)">${this.esc(n.content?.slice(0, 200) || '')}</p>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:8px">🏷️ ${(n.topics || []).join(', ')}</div>
        </div>`).join('');

      // XP 토스트
      if (data.xp) this.toastXP(data.xp);
      if (data.achievements?.length) data.achievements.forEach(a => this.toastAchievement(a));

      // 스테이션 업데이트
      await this.loadStations();
      this.currentStation = this.stations.find(s => s.id === sid);
      this.renderSidebar();

      this.toast(`${data.message}`, 'success');
    } catch (err) {
      this.toast(err.message, 'error');
    } finally {
      document.getElementById('btnIngest').disabled = false;
      document.getElementById('ingestLoading').style.display = 'none';
    }
  },

  // ── Chat ───────────────────────────────────────
  async loadChats() {
    const sid = this.currentStation?.id;
    if (!sid) return;
    try {
      const data = await this.api(`/api/stations/${sid}/chats`);
      const msgs = document.getElementById('chatMessages');
      if (!data.chats || data.chats.length === 0) {
        msgs.innerHTML = `<div class="empty-state" id="chatEmpty"><div class="icon">💬</div><p>에이전트 ${this.currentStation.agent?.name || ''}와 첫 대화를 시작해 보세요!</p></div>`;
        return;
      }

      msgs.innerHTML = data.chats.map(chat => {
        const confClass = `confidence-${chat.confidence || 'medium'}`;
        const confLabel = { high: '높음', medium: '보통', low: '낮음' }[chat.confidence] || '보통';
        
        let crossHtml = '';
        if (chat.crossRecommendations?.length > 0) {
          crossHtml = `<div class="cross-recs"><div class="title">🔗 다른 스테이션의 관련 노트</div>${
            chat.crossRecommendations.map(r => `<div>${r.agentAvatar} ${this.esc(r.stationName)} — "${this.esc(r.title)}" (${Math.round(r.score*100)}%)</div>`).join('')
          }</div>`;
        }

        return `
          <div class="chat-msg user">
            <div class="msg-avatar">👤</div>
            <div class="msg-bubble">${this.esc(chat.question)}</div>
          </div>
          <div class="chat-msg">
            <div class="msg-avatar">${this.currentStation.agent?.avatar || '🧠'}</div>
            <div class="msg-bubble">
              <div>${this.formatAnswer(chat.answer)}</div>
              <span class="confidence-badge ${confClass}">신뢰도: ${confLabel}</span>
              ${chat.citations?.length ? `<div style="margin-top:8px;font-size:0.72rem;color:var(--text-muted)">📚 인용: ${chat.citations.map(c => this.esc(c.title)).join(' · ')}</div>` : ''}
              ${crossHtml}
            </div>
          </div>`;
      }).join('');
      msgs.scrollTop = msgs.scrollHeight;
    } catch (err) {
      this.toast(`대화 이력을 불러오지 못했습니다: ${err.message}`, 'error');
    }
  },

  async askQuestion() {
    const sid = this.currentStation?.id;
    if (!sid) return;
    const input = document.getElementById('chatInput');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';

    document.getElementById('chatEmpty')?.remove();
    const msgs = document.getElementById('chatMessages');

    // 사용자 메시지
    msgs.innerHTML += `<div class="chat-msg user"><div class="msg-avatar">👤</div><div class="msg-bubble">${this.esc(q)}</div></div>`;

    // 로딩
    const loadId = 'load_' + Date.now();
    msgs.innerHTML += `<div class="chat-msg" id="${loadId}"><div class="msg-avatar">${this.currentStation.agent?.avatar || '🧠'}</div><div class="msg-bubble"><span class="loading"><span class="spinner"></span> 생각 중...</span></div></div>`;
    msgs.scrollTop = msgs.scrollHeight;

    try {
      const data = await this.api(`/api/stations/${sid}/query`, {
        method: 'POST', body: JSON.stringify({ question: q }),
      });

      const confClass = `confidence-${data.confidence || 'medium'}`;
      const confLabel = { high: '높음', medium: '보통', low: '낮음' }[data.confidence] || '보통';

      let crossHtml = '';
      if (data.crossRecommendations?.length > 0) {
        crossHtml = `<div class="cross-recs"><div class="title">🔗 다른 스테이션의 관련 노트</div>${
          data.crossRecommendations.map(r => `<div>${r.agentAvatar} ${this.esc(r.stationName)} — "${this.esc(r.title)}" (${Math.round(r.score*100)}%)</div>`).join('')
        }</div>`;
      }

      document.getElementById(loadId).outerHTML = `
        <div class="chat-msg">
          <div class="msg-avatar">${data.agentAvatar || '🧠'}</div>
          <div class="msg-bubble">
            <div>${this.formatAnswer(data.answer)}</div>
            <span class="confidence-badge ${confClass}">신뢰도: ${confLabel}</span>
            ${data.citations?.length ? `<div style="margin-top:8px;font-size:0.72rem;color:var(--text-muted)">📚 인용: ${data.citations.map(c => this.esc(c.title)).join(' · ')}</div>` : ''}
            ${crossHtml}
          </div>
        </div>`;

      if (data.xp) this.toastXP(data.xp);
    } catch (err) {
      document.getElementById(loadId).outerHTML = `<div class="chat-msg"><div class="msg-avatar">❌</div><div class="msg-bubble">오류: ${this.esc(err.message)}</div></div>`;
    }
    msgs.scrollTop = msgs.scrollHeight;
  },

  formatAnswer(text) {
    if (!text) return '';
    let html = this.esc(text);
    // **텍스트** -> <strong>텍스트</strong> (볼드체 지원)
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--text-primary);font-weight:700">$1</strong>');
    // [1] -> 위첨자
    html = html.replace(/\[(\d+)\]/g, '<sup style="color:var(--cyan)">[$1]</sup>');
    // 줄바꿈
    html = html.replace(/\n/g, '<br>');
    return html;
  },

  // ── Notes ──────────────────────────────────────
  async loadNotes() {
    const sid = this.currentStation?.id;
    if (!sid) return;
    const search = document.getElementById('noteSearch')?.value || '';
    try {
      const data = await this.api(`/api/stations/${sid}/notes?search=${encodeURIComponent(search)}`);
      const grid = document.getElementById('notesGrid');
      if (!data.notes?.length) {
        grid.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>아직 노트가 없습니다.</p></div>';
        return;
      }
      grid.innerHTML = data.notes.map(n => `
        <div class="note-card" onclick="app.showNoteDetail('${n.id}')">
          <span class="note-type type-${n.type}">${n.type}</span>
          <div class="note-title">${this.esc(n.title)}</div>
          <div class="note-preview">${this.esc(n.contentPreview || '')}</div>
          <div class="note-footer">
            <span>🏷️ ${(n.topics || []).slice(0, 3).join(', ')}</span>
            <span>${this.formatDate(n.created_at)}</span>
          </div>
        </div>`).join('');
    } catch (err) { this.toast(err.message, 'error'); }
  },

  searchNotes: debounce(function() { app.loadNotes(); }, 300),

  async showNoteDetail(noteId) {
    const sid = this.currentStation?.id;
    try {
      const note = await this.api(`/api/stations/${sid}/notes/${noteId}`);
      document.getElementById('modalContent').innerHTML = `
        <div class="note-modal">
          <div class="note-detail-header">
            <div>
              <span class="note-type type-${note.type}">${note.type}</span>
              <div class="note-detail-title" style="margin-top:8px">${this.esc(note.title)}</div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="app.closeModal()">✕</button>
          </div>
          <div class="note-detail-content">${this.esc(note.content || '').replace(/\n/g, '<br>')}</div>
          ${note.why_saved ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:12px">💡 ${this.esc(note.why_saved)}</div>` : ''}
          <div style="font-size:0.78rem;color:var(--text-muted);display:flex;gap:16px;flex-wrap:wrap">
            <span>📊 신뢰도: ${note.confidence}</span>
            <span>⏳ ${note.half_life}</span>
            <span>🏷️ ${(note.topics || []).join(', ')}</span>
          </div>
          <div class="my-take-section">
            <label>✏️ 나의 해석 (my_take)</label>
            <textarea id="myTakeInput">${this.esc(note.my_take || '')}</textarea>
            <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="app.saveMyTake('${noteId}')">💾 저장</button>
          </div>
        </div>`;
      document.getElementById('modalOverlay').style.display = 'flex';
    } catch (err) { this.toast(err.message, 'error'); }
  },

  async saveMyTake(noteId) {
    const sid = this.currentStation?.id;
    const myTake = document.getElementById('myTakeInput').value;
    try {
      await this.api(`/api/stations/${sid}/notes/${noteId}`, {
        method: 'PUT', body: JSON.stringify({ my_take: myTake }),
      });
      this.toast('✅ 저장되었습니다!', 'success');
      this.closeModal();
    } catch (err) { this.toast(err.message, 'error'); }
  },

  // ── Graph ──────────────────────────────────────
  async loadGraph() {
    const sid = this.currentStation?.id;
    if (!sid) return;
    try {
      const data = await this.api(`/api/stations/${sid}/graph`);
      this.renderGraph(data.nodes || [], data.edges || []);
    } catch (err) { this.toast(err.message, 'error'); }
  },

  renderGraph(nodes, edges) {
    const canvas = document.getElementById('graphCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight || 500;

    if (nodes.length === 0) {
      ctx.fillStyle = '#64748B';
      ctx.font = '16px Inter';
      ctx.textAlign = 'center';
      ctx.fillText('아직 그래프 데이터가 없습니다', canvas.width / 2, canvas.height / 2);
      return;
    }

    const typeColors = { fact: '#06B6D4', concept: '#A855F7', procedure: '#10B981', opinion: '#F59E0B', temporal: '#EC4899' };
    const W = canvas.width, H = canvas.height;

    // 랜덤 초기 위치
    const pos = {};
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      const r = Math.min(W, H) * 0.3;
      pos[n.id] = { x: W/2 + Math.cos(angle) * r + (Math.random()-0.5)*60, y: H/2 + Math.sin(angle) * r + (Math.random()-0.5)*60 };
    });

    // 간단한 force 시뮬레이션 (50 iterations)
    for (let iter = 0; iter < 50; iter++) {
      // 반발력
      for (const a of nodes) {
        for (const b of nodes) {
          if (a.id === b.id) continue;
          const dx = pos[a.id].x - pos[b.id].x;
          const dy = pos[a.id].y - pos[b.id].y;
          const dist = Math.max(1, Math.sqrt(dx*dx + dy*dy));
          const force = 2000 / (dist * dist);
          pos[a.id].x += (dx / dist) * force;
          pos[a.id].y += (dy / dist) * force;
        }
      }
      // 인력 (엣지)
      for (const e of edges) {
        if (!pos[e.source] || !pos[e.target]) continue;
        const dx = pos[e.target].x - pos[e.source].x;
        const dy = pos[e.target].y - pos[e.source].y;
        const dist = Math.max(1, Math.sqrt(dx*dx + dy*dy));
        const force = dist * 0.01;
        pos[e.source].x += (dx / dist) * force;
        pos[e.source].y += (dy / dist) * force;
        pos[e.target].x -= (dx / dist) * force;
        pos[e.target].y -= (dy / dist) * force;
      }
      // 중심 중력
      for (const n of nodes) {
        pos[n.id].x += (W/2 - pos[n.id].x) * 0.01;
        pos[n.id].y += (H/2 - pos[n.id].y) * 0.01;
      }
    }

    // 그리기
    ctx.clearRect(0, 0, W, H);

    // 엣지
    for (const e of edges) {
      if (!pos[e.source] || !pos[e.target]) continue;
      ctx.beginPath();
      ctx.moveTo(pos[e.source].x, pos[e.source].y);
      ctx.lineTo(pos[e.target].x, pos[e.target].y);
      ctx.strokeStyle = e.relation === 'contradicts' ? 'rgba(239,68,68,0.3)' : 'rgba(148,163,184,0.15)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 노드
    for (const n of nodes) {
      const p = pos[n.id];
      const color = typeColors[n.type] || '#7C3AED';
      const r = 8;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
      ctx.fillStyle = color + '33';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      ctx.fillStyle = '#F1F5F9';
      ctx.font = '10px Inter';
      ctx.textAlign = 'center';
      const label = (n.title || '').slice(0, 12);
      ctx.fillText(label, p.x, p.y + r + 14);
    }
  },

  // ── GC ─────────────────────────────────────────
  async runGC() {
    this.toast('🧹 정리 실행 중...', 'success');
    // GC는 아직 스테이션별 구현 전이므로 placeholder
    document.getElementById('gcResults').innerHTML = '<div class="empty-state"><div class="icon">🧹</div><p>스테이션별 GC는 곧 지원됩니다!</p></div>';
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  COUNCIL VIEW
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  showCouncil() {
    this.currentView = 'council';
    document.getElementById('hubView').style.display = 'none';
    document.getElementById('stationView').style.display = 'none';
    document.getElementById('councilView').style.display = '';
    document.getElementById('btnHub').style.display = '';
    document.getElementById('btnCouncil').style.display = 'none';
    this.renderCouncilAgents();
  },

  renderCouncilAgents() {
    document.getElementById('councilAgents').innerHTML = this.stations.map(s => `
      <div class="council-agent-chip selected" data-sid="${s.id}" onclick="this.classList.toggle('selected')">
        ${s.agent?.avatar || '🧠'} ${this.esc(s.agent?.name || s.name)} (Lv.${s.gamification?.level || 1})
      </div>`).join('');
  },

  async askCouncil() {
    const q = document.getElementById('councilInput').value.trim();
    if (!q) return this.toast('질문을 입력하세요', 'error');

    const selectedIds = [...document.querySelectorAll('.council-agent-chip.selected')].map(c => c.dataset.sid);
    if (selectedIds.length === 0) return this.toast('참여할 에이전트를 선택하세요', 'error');

    document.getElementById('councilLoading').style.display = 'flex';
    document.getElementById('councilResponses').innerHTML = '';

    try {
      const data = await this.api('/api/council', {
        method: 'POST',
        body: JSON.stringify({ question: q, stationIds: selectedIds }),
      });

      document.getElementById('councilResponses').innerHTML = (data.responses || []).map((r, i) => `
        <div class="council-response-card" style="animation-delay:${i * 200}ms;--station-color:${this.stations.find(s=>s.id===r.stationId)?.color || '#7C3AED'}">
          <div class="resp-header">
            <span class="resp-avatar">${r.agent?.avatar || '🧠'}</span>
            <div>
              <div class="resp-name">${this.esc(r.agent?.name || '')}</div>
              <div class="resp-level">Lv.${r.level} · ${this.esc(r.stationName || '')}</div>
            </div>
          </div>
          <div class="resp-answer">${this.esc(r.answer || '').replace(/\n/g, '<br>')}</div>
          ${r.notesUsed > 0 ? `<div style="margin-top:8px;font-size:0.72rem;color:var(--text-muted)">📚 ${r.notesUsed}개 노트 참조</div>` : ''}
        </div>`).join('');
    } catch (err) {
      this.toast(err.message, 'error');
    } finally {
      document.getElementById('councilLoading').style.display = 'none';
    }
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  TOAST / XP / ACHIEVEMENTS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  },

  toastXP(xpResult) {
    if (!xpResult || !xpResult.xpGain) return;
    const el = document.createElement('div');
    el.className = 'toast toast-xp';
    el.innerHTML = `<span class="xp-value">+${xpResult.xpGain} XP</span> 🌟 총 ${xpResult.totalXP} XP`;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => el.remove(), 3000);

    if (xpResult.leveledUp) {
      setTimeout(() => {
        const lvl = document.createElement('div');
        lvl.className = 'toast toast-levelup';
        lvl.innerHTML = `🎉 <strong>레벨 업!</strong> Lv.${xpResult.level} ${xpResult.title}`;
        document.getElementById('toastContainer').appendChild(lvl);
        setTimeout(() => lvl.remove(), 5000);
      }, 500);
    }
  },

  toastAchievement(ach) {
    const el = document.createElement('div');
    el.className = 'toast toast-achievement';
    el.innerHTML = `${ach.badge} <strong>업적 달성!</strong> ${this.esc(ach.title)}`;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  },

  // ── 유틸리티 ───────────────────────────────────
  esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; },
  formatDate(d) { if (!d) return ''; try { return new Date(d).toLocaleDateString('ko-KR'); } catch { return d; } },
};

function debounce(fn, ms) { let t; return function(...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; }

// 앱 시작
document.addEventListener('DOMContentLoaded', () => {
  app.init();
  app.initIngestTabs();
});
