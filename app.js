/* ============================================================
 * 심사 웹앱 — 본체 (다중 프로젝트 지원)
 *
 *  (기본)                          로그인: 프로젝트 → 심사위원 → 전화 뒤4자리
 *  ?p=<프로젝트>&j=<token>         심사위원 심사표
 *  ?p=<프로젝트>&j=<token>&sign=1  모바일 서명 페이지 (QR로 접속)
 *  ?admin=<토큰>[&p=<프로젝트>]    관리자: 프로젝트 전반 관리 / 팀 명단 / 취합
 * ============================================================ */
'use strict';

const $app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const IS_REAL = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
const sb = IS_REAL ? supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY) : null;

let PROJ = null;   // 현재 프로젝트 id
let SET = null;    // 현재 프로젝트 설정

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function toast(msg, ms = 2200) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const appUrl = q => location.origin + location.pathname + q;
const judgeUrl = (pid, tok, extra) =>
  appUrl('?p=' + encodeURIComponent(pid) + '&j=' + encodeURIComponent(tok) + (extra || ''));
const randToken = () => 'j-' + Math.random().toString(36).slice(2, 8);
const randPid = () => 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/* ─────────────────────── 관리자 인증 ─────────────────────── */

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const ADMIN_AUTH_KEY = 'judgeapp:adminAuth';
function isAdminAuthed() {
  try { return localStorage.getItem(ADMIN_AUTH_KEY) === CONFIG.ADMIN_PW_HASH; }
  catch (e) { return false; }
}
function adminLogout() {
  try { localStorage.removeItem(ADMIN_AUTH_KEY); } catch (e) {}
  location.href = appUrl('');
}

/* ─────────────────────── 저장소 (Supabase / 로컬 체험) ─────────────────────── */

const LS = 'judgeapp2:';
const lsGet = (k, d) => {
  const raw = localStorage.getItem(LS + k);
  return raw ? JSON.parse(raw) : d;
};
const lsSet = (k, v) => localStorage.setItem(LS + k, JSON.stringify(v));

const localStore = {
  async getProjects() {
    const ids = lsGet('index', []);
    return ids.map(id => {
      const d = lsGet('proj:' + id, null);
      return d ? { id, data: d } : null;
    }).filter(Boolean);
  },
  async getProject(id) { return lsGet('proj:' + id, null); },
  async saveProject(id, data) {
    lsSet('proj:' + id, data);
    const ids = lsGet('index', []);
    if (!ids.includes(id)) { ids.push(id); lsSet('index', ids); }
  },
  async deleteProject(id) {
    lsSet('index', lsGet('index', []).filter(x => x !== id));
    Object.keys(localStorage)
      .filter(k => k.startsWith(LS) && k.includes(id))
      .forEach(k => localStorage.removeItem(k));
  },
  async getTeams(pid) { return lsGet(pid + ':teams', []); },
  async saveTeams(pid, rows) { lsSet(pid + ':teams', rows); },
  async getScores(pid, judgeId) { return lsGet(pid + ':scores:' + judgeId, {}); },
  async saveScore(pid, judgeId, teamNo, vals, comment) {
    const all = lsGet(pid + ':scores:' + judgeId, {});
    all[teamNo] = { vals, comment, u: new Date().toISOString() };
    lsSet(pid + ':scores:' + judgeId, all);
  },
  async getAllScores(pid, judgeIds) {
    const out = {};
    for (const id of judgeIds) out[id] = lsGet(pid + ':scores:' + id, {});
    return out;
  },
  async getSignatureMeta(pid, judgeId) { return lsGet(pid + ':sigmeta:' + judgeId, null); },
  async getSignature(pid, judgeId) {
    const m = lsGet(pid + ':sigmeta:' + judgeId, null);
    return m ? m.png : null;
  },
  async saveSignature(pid, judgeId, png) {
    lsSet(pid + ':sigmeta:' + judgeId, { png, at: new Date().toISOString() });
  },
  async deleteSignature(pid, judgeId) { localStorage.removeItem(LS + pid + ':sigmeta:' + judgeId); },
};

const supaStore = {
  async getProjects() {
    const { data, error } = await sb.from('projects').select('id, data').order('id');
    if (error) throw error;
    return data || [];
  },
  async getProject(id) {
    const { data, error } = await sb.from('projects').select('data').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  },
  async saveProject(id, d) {
    const { error } = await sb.from('projects').upsert({ id, data: d });
    if (error) throw error;
  },
  async deleteProject(id) {
    for (const t of ['signatures', 'scores', 'teams']) {
      await sb.from(t).delete().eq('project_id', id);
    }
    const { error } = await sb.from('projects').delete().eq('id', id);
    if (error) throw error;
  },
  async getTeams(pid) {
    const { data, error } = await sb.from('teams').select('*').eq('project_id', pid).order('no');
    if (error) throw error;
    return data || [];
  },
  async saveTeams(pid, rows) {
    const { error } = await sb.from('teams').upsert(rows.map(r => ({ ...r, project_id: pid })));
    if (error) throw error;
  },
  async getScores(pid, judgeId) {
    const { data, error } = await sb.from('scores').select('*')
      .eq('project_id', pid).eq('judge_id', judgeId);
    if (error) throw error;
    const out = {};
    (data || []).forEach(r => { out[r.team_no] = { vals: r.vals || [], comment: r.comment || '', u: r.updated_at }; });
    return out;
  },
  async saveScore(pid, judgeId, teamNo, vals, comment) {
    const { error } = await sb.from('scores').upsert({
      project_id: pid, judge_id: judgeId, team_no: teamNo,
      vals, comment, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  },
  async getAllScores(pid) {
    const { data, error } = await sb.from('scores').select('*').eq('project_id', pid);
    if (error) throw error;
    const out = {};
    (data || []).forEach(r => {
      (out[r.judge_id] = out[r.judge_id] || {})[r.team_no] = { vals: r.vals || [], comment: r.comment || '', u: r.updated_at };
    });
    return out;
  },
  async getSignatureMeta(pid, judgeId) {
    const { data, error } = await sb.from('signatures').select('png, signed_at')
      .eq('project_id', pid).eq('judge_id', judgeId).maybeSingle();
    if (error) throw error;
    return data ? { png: data.png, at: data.signed_at } : null;
  },
  async getSignature(pid, judgeId) {
    const m = await this.getSignatureMeta(pid, judgeId);
    return m ? m.png : null;
  },
  async deleteSignature(pid, judgeId) {
    const { error } = await sb.from('signatures').delete()
      .eq('project_id', pid).eq('judge_id', judgeId);
    if (error) throw error;
  },
  async saveSignature(pid, judgeId, png) {
    const { error } = await sb.from('signatures').upsert({
      project_id: pid, judge_id: judgeId, png,
      signed_at: new Date().toISOString(), ua: navigator.userAgent,
    });
    if (error) throw error;
  },
};

const store = IS_REAL ? supaStore : localStore;

/* ─────────────────────── 프로젝트 로드 ─────────────────────── */

async function ensureAnyProject() {
  let list = await store.getProjects();
  if (!list.length) {
    const id = randPid();
    await store.saveProject(id, JSON.parse(JSON.stringify(CONFIG.DEFAULTS)));
    list = await store.getProjects();
  }
  return list;
}

async function loadProject(pid) {
  const data = await store.getProject(pid);
  if (!data) return false;
  PROJ = pid;
  SET = data;
  return true;
}

function totalMax() { return SET.criteria.reduce((a, c) => a + Number(c.max || 0), 0); }
function judgeByToken(tok) { return SET.judges.find(j => j.token === tok) || null; }
/* 이름이 입력된 심사위원만 (설정 화면의 빈 행 제외) */
function namedJudges() { return SET.judges.filter(j => j.name); }

async function teamsFilled() {
  const rows = await store.getTeams(PROJ);
  const map = {};
  rows.forEach(r => { map[r.no] = r; });
  const out = [];
  for (let n = 1; n <= SET.teamCount; n++) {
    out.push({ no: n, unit: (map[n] && map[n].unit) || '', name: (map[n] && map[n].name) || '' });
  }
  return out;
}

/* ─────────────────────── 공용: 엑셀식 키보드 이동 ───────────────────────
 * data-r, data-c 지정된 요소들 사이를 ↑↓←→/Enter로 이동.
 * ←→는 커서가 끝(또는 전체선택)일 때만 셀 이동. textarea는 Enter=아래, Shift+Enter=줄바꿈.
 */
function bindGridNav(container) {
  container.addEventListener('keydown', e => {
    const el = e.target;
    if (!el.dataset || el.dataset.r === undefined) return;
    const r = +el.dataset.r, c = +el.dataset.c;
    const isTa = el.tagName === 'TEXTAREA';
    const go = (nr, nc) => {
      const nxt = container.querySelector('[data-r="' + nr + '"][data-c="' + nc + '"]');
      if (nxt) {
        e.preventDefault();
        nxt.focus();
        if (nxt.select) nxt.select();
      }
    };
    const key = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' }[e.key] || e.key;
    if (key === 'Enter') {
      if (isTa && e.shiftKey) return;
      go(r + 1, c);
      return;
    }
    if (isTa) return;
    const len = el.value.length;
    const allSel = el.selectionStart === 0 && el.selectionEnd === len && len > 0;
    if (key === 'ArrowDown') go(r + 1, c);
    else if (key === 'ArrowUp') go(r - 1, c);
    else if (key === 'ArrowLeft' && (allSel || (el.selectionStart === 0 && el.selectionEnd === 0))) go(r, c - 1);
    else if (key === 'ArrowRight' && (allSel || el.selectionStart === len)) go(r, c + 1);
  });
  container.addEventListener('focusin', e => {
    if (e.target.select && e.target.tagName === 'INPUT') e.target.select();
  });
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

/* ─────────────────────── 서명 캔버스 (공용) ─────────────────────── */

function createSignPad(mount) {
  mount.innerHTML =
    '<div class="pad-wrap"><canvas></canvas><div class="pad-base"></div>' +
    '<div class="pad-hint">여기에 서명하세요</div></div>';
  const canvas = mount.querySelector('canvas');
  const hint = mount.querySelector('.pad-hint');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let drawing = false, last = null, hasDrawn = false;

  const cssW = mount.clientWidth || 320;
  const cssH = 200;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = cssH + 'px';
  ctx.scale(dpr, dpr);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111827'; ctx.lineWidth = 2.6;

  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = true; last = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y);
    ctx.lineTo(last.x + 0.1, last.y + 0.1); ctx.stroke();
    if (!hasDrawn) { hasDrawn = true; hint.style.display = 'none'; mount.dispatchEvent(new Event('drawn')); }
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
    ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
    ctx.stroke(); last = p;
  });
  const end = () => { drawing = false; ctx.beginPath(); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    hasDrawn: () => hasDrawn,
    clear() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      hasDrawn = false; hint.style.display = 'flex';
    },
    trimmedPng() {   // 그린 부분만 잘라낸 투명 배경 PNG
      const w = canvas.width, h = canvas.height;
      const data = ctx.getImageData(0, 0, w, h).data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 10) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) return null;
      const pad = Math.round(10 * dpr);
      minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
      maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
      const out = document.createElement('canvas');
      out.width = maxX - minX + 1; out.height = maxY - minY + 1;
      out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    },
  };
}

/* ─────────────────────── 심사위원 화면 ─────────────────────── */

async function renderJudge(judge) {
  const teams = await teamsFilled();
  const scores = await store.getScores(PROJ, judge.id);
  const sig = await store.getSignature(PROJ, judge.id);
  const nC = SET.criteria.length;

  const headCols = SET.criteria.map(c =>
    '<th style="width:64px">' + esc(c.name) + '<br><small>(' + c.max + ')</small></th>').join('');

  const rowsHtml = teams.map((t, i) => {
    const sc = scores[t.no] || { vals: [], comment: '' };
    const cells = SET.criteria.map((c, ci) => {
      const v = sc.vals[ci] == null ? '' : sc.vals[ci];
      return '<td class="cell"><input class="score" inputmode="numeric" data-r="' + i +
        '" data-c="' + ci + '" data-no="' + t.no + '" data-max="' + c.max + '" value="' + esc(v) + '"></td>';
    }).join('');
    return '<tr>' +
      '<td class="ro" style="width:34px">' + t.no + '</td>' +
      '<td class="ro" style="width:76px">' + esc(t.unit) + '</td>' +
      '<td class="ro" style="width:76px">' + esc(t.name) + '</td>' +
      cells +
      '<td class="total" style="width:52px" id="tot-' + t.no + '"></td>' +
      '<td class="cell"><textarea rows="1" data-r="' + i + '" data-c="' + nC +
        '" data-no="' + t.no + '">' + esc(sc.comment) + '</textarea></td>' +
      '</tr>';
  }).join('');

  const critRows = SET.criteria.map(c =>
    '<tr><td class="cname">' + esc(c.name) + '</td>' +
    '<td class="cdesc">' + (c.desc || []).map(esc).join('<br>') + '</td>' +
    '<td class="cmax">' + c.max + '</td></tr>').join('');

  $app.innerHTML =
    (IS_REAL ? '' : '<div class="demo-banner">🧪 체험 모드 — 이 컴퓨터에만 저장됩니다. config.js에 Supabase 키를 넣으면 실전 모드가 됩니다.</div>') +
    '<div class="topbar no-print">' +
      '<span class="brand">✍️ 심사표<small>' + esc(judge.name) + ' ' + esc(judge.role) + '</small></span>' +
      '<span class="savestat" id="savestat">자동 저장</span>' +
      '<button class="btn" id="btnCrit">평가기준</button>' +
      '<button class="btn" id="btnPrint" title="인쇄 대화상자에서 \'PDF로 저장\'을 선택하면 PDF로 저장됩니다">🖨 인쇄 · PDF</button>' +
      '<button class="btn primary" id="btnDone">' + (sig ? '서명 완료 · 다시 서명' : '심사완료 · 서명') + '</button>' +
    '</div>' +
    '<div id="lockBanner" class="no-print" style="display:none;align-items:center;gap:12px;justify-content:center;' +
      'background:#eef4ff;border-bottom:1px solid #d6e2f7;color:#1e40af;padding:9px 16px;font-size:13px">' +
      '🔒 서명이 완료되어 편집이 잠겨 있습니다.' +
      '<button class="btn" id="btnUnlock" style="font-size:12px;padding:5px 12px">수정하기</button></div>' +
    '<div class="criteria-panel no-print" id="critPanel" style="display:none">' +
      '<h3>평가기준</h3><table><thead><tr><th style="width:90px">평가항목</th><th>평가기준</th>' +
      '<th style="width:60px">배점</th></tr></thead><tbody>' + critRows +
      '<tr><td class="cname">총점</td><td></td><td class="cmax"><b>' + totalMax() + '점</b></td></tr>' +
      '</tbody></table></div>' +
    '<div class="paper">' +
      '<div class="p-title">' + esc(SET.eventTitle) + '</div>' +
      '<div class="p-info"><table>' +
        '<tr><th>심사위원</th><td>' + esc(judge.name) + (judge.role === '심사위원장' ? ' (위원장)' : '') + '</td></tr>' +
        '<tr><th>부문</th><td>' + esc(SET.category) + '</td></tr>' +
        '<tr><th>심사일</th><td>' + esc(SET.dateText) + '</td></tr>' +
      '</table></div>' +
      '<table class="score" id="scoreTable"><thead><tr>' +
        '<th style="width:34px">연번</th><th style="width:76px">단위<br><small>(개인/단체)</small></th>' +
        '<th style="width:76px">성명</th>' + headCols +
        '<th style="width:52px">총점</th><th>심사의견</th>' +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      '<div class="p-bottom">' +
        '<div class="p-confirm">위 평가 결과는 본인이 직접 심사한 내용임을 확인합니다.</div>' +
        '<div class="p-date">' + esc(SET.dateLine) + '</div>' +
        '<div class="p-sign"><table><tr>' +
          '<th>심사위원</th><td class="name">' + esc(judge.name) + '</td>' +
          '<td class="sigbox" id="sigbox"></td><td class="siglabel">(서명)</td>' +
        '</tr></table></div>' +
      '</div>' +
    '</div>';

  const table = document.getElementById('scoreTable');
  bindGridNav(table);
  table.querySelectorAll('textarea').forEach(autoGrow);

  const showSig = png => {
    document.getElementById('sigbox').innerHTML = png
      ? '<img src="' + png + '" alt="서명">'
      : '<span class="placeholder">서명 전</span>';
  };
  showSig(sig);

  /* 서명 완료 시 편집 잠금 (수정하려면 경고를 거쳐 잠금 해제) */
  const setLock = on => {
    table.querySelectorAll('input, textarea').forEach(i => { i.disabled = on; });
    document.getElementById('lockBanner').style.display = on ? 'flex' : 'none';
  };
  setLock(!!sig);
  document.getElementById('btnUnlock').addEventListener('click', () => {
    if (!confirm('⚠️ 이미 서명이 완료된 심사표입니다.\n\n서명 후 내용을 수정하면 심사 결과의 신뢰성에 문제가 될 수 있으며,\n관리자 화면에 "서명 후 수정됨"으로 표시됩니다.\n\n정말 수정하시겠습니까?')) return;
    if (!confirm('정말입니까? 수정 후에는 다시 서명해 주세요.')) return;
    setLock(false);
    toast('편집이 잠금 해제되었습니다. 수정 후 [심사완료 · 서명]으로 다시 서명해주세요.', 4000);
  });

  /* 상태 + 실시간 자동 저장 (입력 0.6초 후 / 셀을 떠날 때 즉시) */
  const savestat = document.getElementById('savestat');
  const timers = {};
  const dirty = {};
  const rowState = {};
  teams.forEach(t => {
    const sc = scores[t.no] || { vals: [], comment: '' };
    rowState[t.no] = {
      vals: SET.criteria.map((c, i) => sc.vals[i] == null ? null : sc.vals[i]),
      comment: sc.comment || '',
    };
    updateTotal(t.no);
  });

  function updateTotal(no) {
    const vals = rowState[no].vals;
    const filled = vals.filter(v => v !== null && v !== '');
    document.getElementById('tot-' + no).textContent =
      filled.length ? filled.reduce((a, v) => a + Number(v), 0) : '';
  }

  async function saveRow(no) {
    dirty[no] = false;
    clearTimeout(timers[no]);
    try {
      const st = rowState[no];
      await store.saveScore(PROJ, judge.id, no, st.vals, st.comment);
      if (!Object.values(dirty).some(Boolean)) {
        savestat.textContent = '저장됨 ✓';
        savestat.className = 'savestat saved';
      }
    } catch (e) {
      console.error(e);
      dirty[no] = true;
      savestat.textContent = '저장 실패!';
      savestat.className = 'savestat';
      toast('저장에 실패했습니다. 네트워크를 확인해주세요.');
    }
  }
  function queueSave(no) {
    dirty[no] = true;
    savestat.textContent = '입력 중…';
    savestat.className = 'savestat saving';
    clearTimeout(timers[no]);
    timers[no] = setTimeout(() => saveRow(no), 600);
  }
  const flushAll = () => {
    Object.keys(dirty).forEach(no => { if (dirty[no]) saveRow(no); });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });

  table.addEventListener('input', e => {
    const el = e.target;
    const no = +el.dataset.no;
    if (!no) return;
    if (el.classList.contains('score')) {
      el.value = el.value.replace(/[^\d]/g, '');
      const max = +el.dataset.max;
      let v = el.value === '' ? null : Number(el.value);
      if (v !== null && v > max) {           // 배점 초과 → 즉시 상한으로 보정
        v = max;
        el.value = String(max);
        el.classList.add('invalid');
        setTimeout(() => el.classList.remove('invalid'), 700);
      }
      rowState[no].vals[+el.dataset.c] = v;
      updateTotal(no);
    } else {
      autoGrow(el);
      rowState[no].comment = el.value;
    }
    queueSave(no);
  });
  table.addEventListener('focusout', e => {
    const el = e.target;
    const no = +((el.dataset || {}).no || 0);
    if (!no) return;
    if (el.classList.contains('score') && el.value !== '') {
      const max = +el.dataset.max;
      if (Number(el.value) > max) {
        el.value = max;
        el.classList.remove('invalid');
        rowState[no].vals[+el.dataset.c] = max;
        updateTotal(no);
      }
    }
    if (dirty[no]) saveRow(no);   // 셀을 떠나는 순간 즉시 저장
  });

  document.getElementById('btnCrit').addEventListener('click', () => {
    const p = document.getElementById('critPanel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btnPrint').addEventListener('click', () => window.print());
  document.getElementById('btnDone').addEventListener('click', () =>
    openSignModal(judge, rowState, teams, showSig, setLock));
}

/* 심사완료 → QR/서명 모달 */
function openSignModal(judge, rowState, teams, showSig, setLock) {
  const missing = teams.filter(t =>
    rowState[t.no].vals.some(v => v === null || v === '')).map(t => t.no);

  const link = judgeUrl(PROJ, judge.token, '&sign=1');
  const back = document.createElement('div');
  back.className = 'modal-back no-print';
  back.innerHTML =
    '<div class="modal">' +
      '<h2>심사완료 — 서명</h2>' +
      (missing.length
        ? '<div class="sub" style="color:#b45309">⚠️ 아직 점수가 비어있는 팀: ' + missing.join(', ') + '번</div>'
        : '<div class="sub">모든 팀 점수가 입력되었습니다.</div>') +
      '<div id="modalBody">' +
        '<div class="sub">휴대폰 카메라로 QR을 스캔해 서명하거나,<br>아래 버튼으로 이 기기에서 바로 서명할 수 있습니다.</div>' +
        '<div class="qrbox"><div id="qrHere"></div></div>' +
        '<div class="linkline">' + esc(link) + '</div>' +
        '<div class="btnrow">' +
          '<button class="btn" id="mClose">닫기</button>' +
          '<button class="btn primary" id="mHere">이 기기에서 서명</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(back);

  new QRCode(document.getElementById('qrHere'), { text: link, width: 190, height: 190 });

  let pollTimer = null;
  const close = () => { clearInterval(pollTimer); back.remove(); };
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.getElementById('mClose').addEventListener('click', close);

  const onSigned = png => {
    showSig(png);
    close();
    if (setLock) setLock(true);
    toast('✅ 서명이 등록되었습니다. [🖨 인쇄 · PDF]로 출력할 수 있습니다.', 3500);
    document.getElementById('btnDone').textContent = '서명 완료 · 다시 서명';
  };

  pollTimer = setInterval(async () => {
    try {
      const png = await store.getSignature(PROJ, judge.id);
      if (png) onSigned(png);
    } catch (e) { /* 폴링 실패 무시 */ }
  }, 4000);

  document.getElementById('mHere').addEventListener('click', () => {
    const body = document.getElementById('modalBody');
    body.innerHTML =
      '<div class="sub"><b>' + esc(judge.name) + '</b> ' + esc(judge.role) + ' — 마우스/터치로 서명해주세요.</div>' +
      '<div id="padMount"></div>' +
      '<div style="font-size:11px;color:#9ca3af;text-align:left;line-height:1.5;margin-bottom:10px">' +
        '서명을 등록하면 위 평가 결과를 본인이 직접 심사·확인하였고, 이 전자서명이 자필 서명과 동일한 효력을 갖는 것에 동의한 것으로 봅니다. (전자서명법 제3조)</div>' +
      '<div class="btnrow">' +
        '<button class="btn" id="mClear">다시 쓰기</button>' +
        '<button class="btn primary" id="mSubmit" disabled>서명 등록</button>' +
      '</div><div class="err" id="mErr" style="display:none"></div>';
    const pad = createSignPad(document.getElementById('padMount'));
    document.getElementById('padMount').addEventListener('drawn', () => {
      document.getElementById('mSubmit').disabled = false;
    });
    document.getElementById('mClear').addEventListener('click', () => {
      pad.clear();
      document.getElementById('mSubmit').disabled = true;
    });
    document.getElementById('mSubmit').addEventListener('click', async function () {
      const png = pad.trimmedPng();
      if (!png) return;
      this.disabled = true; this.textContent = '등록 중…';
      try {
        await store.saveSignature(PROJ, judge.id, png);
        onSigned(png);
      } catch (e) {
        console.error(e);
        this.disabled = false; this.textContent = '서명 등록';
        const err = document.getElementById('mErr');
        err.textContent = '등록 실패: ' + (e.message || e);
        err.style.display = 'block';
      }
    });
  });
}

/* ─────────────────────── 모바일 서명 페이지 ─────────────────────── */

function renderSignPage(judge) {
  $app.innerHTML =
    '<div class="sign-page"><div class="sign-card">' +
      '<div id="signView">' +
        '<h1>✍️ 심사위원 서명</h1>' +
        '<div class="who">' + esc(SET.eventTitle) + '<br><b>' + esc(judge.name) + '</b> ' + esc(judge.role) + '님, 아래에 서명해주세요.</div>' +
        '<div id="padMount"></div>' +
        '<div style="font-size:11px;color:#9ca3af;text-align:left;line-height:1.5;margin-bottom:10px">' +
          '서명을 제출하면 심사 결과를 본인이 직접 심사·확인하였고, 이 전자서명이 자필 서명과 동일한 효력을 갖는 것에 동의한 것으로 봅니다. (전자서명법 제3조)</div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn" id="sClear" style="flex:1;padding:13px 0">다시 쓰기</button>' +
          '<button class="btn primary" id="sSubmit" style="flex:2;padding:13px 0" disabled>서명 제출</button>' +
        '</div>' +
        '<div id="sErr" style="display:none;color:#b91c1c;font-size:13px;margin-top:10px"></div>' +
      '</div>' +
      '<div class="done-view" id="doneView" style="display:none">' +
        '<div class="big">✅</div><h1>서명이 등록되었습니다</h1>' +
        '<div class="who" style="margin-top:8px">심사표에 반영되었습니다.<br>이 창은 닫으셔도 됩니다.</div>' +
      '</div>' +
    '</div></div>';

  const pad = createSignPad(document.getElementById('padMount'));
  document.getElementById('padMount').addEventListener('drawn', () => {
    document.getElementById('sSubmit').disabled = false;
  });
  document.getElementById('sClear').addEventListener('click', () => {
    pad.clear();
    document.getElementById('sSubmit').disabled = true;
  });
  document.getElementById('sSubmit').addEventListener('click', async function () {
    const png = pad.trimmedPng();
    if (!png) return;
    this.disabled = true; this.textContent = '등록 중…';
    try {
      await store.saveSignature(PROJ, judge.id, png);
      document.getElementById('signView').style.display = 'none';
      document.getElementById('doneView').style.display = 'block';
    } catch (e) {
      console.error(e);
      this.disabled = false; this.textContent = '서명 제출';
      const err = document.getElementById('sErr');
      err.textContent = '등록 실패: ' + (e.message || e);
      err.style.display = 'block';
    }
  });
}

/* ─────────────────────── 관리자 화면 ─────────────────────── */

async function renderAdmin(projects) {
  const teams = await teamsFilled();

  const projOptions = projects.map(p =>
    '<option value="' + esc(p.id) + '"' + (p.id === PROJ ? ' selected' : '') + '>' +
    esc(p.data.eventTitle || '(제목 없음)') + '</option>').join('');

  $app.innerHTML =
    (IS_REAL ? '' : '<div class="demo-banner">🧪 체험 모드 — 이 컴퓨터에만 저장됩니다. config.js에 Supabase 키를 넣으면 실전 모드가 됩니다.</div>') +
    '<div class="topbar no-print">' +
      '<span class="brand">🏆 심사 관리</span>' +
      '<select id="projSel" style="padding:8px;border:1px solid #d3d9e2;border-radius:8px;max-width:280px">' +
        projOptions + '</select>' +
      '<button class="btn" id="projNew">＋ 새 프로젝트</button>' +
      '<button class="btn" id="projActive">' +
        (SET.active === false ? '⚫ 비공개 (심사위원에게 숨김)' : '🟢 공개중 (로그인 화면에 표시)') + '</button>' +
      '<button class="btn" id="projDel" style="color:#b91c1c">삭제</button>' +
      '<span style="flex:1"></span>' +
      '<button class="btn" id="btnReload">🔄 새로고침</button>' +
      '<button class="btn" id="btnXlsx">📊 엑셀 저장</button>' +
      '<button class="btn primary" id="btnPrintSum" title="인쇄 대화상자에서 \'PDF로 저장\' 선택 시 PDF로 저장됩니다">🖨 취합 인쇄 · PDF</button>' +
      '<button class="btn" id="btnLogout" title="관리자 로그아웃">로그아웃</button>' +
    '</div>' +
    '<div class="admin-wrap">' +
      '<div class="admin-section print-hide" id="secSettings"></div>' +
      '<div class="admin-section print-hide" id="secTeams"></div>' +
      '<div class="admin-section print-hide" id="secLinks"></div>' +
      '<div class="admin-section" id="secSummary"></div>' +
    '</div>';

  const goAdmin = pid => {
    location.href = appUrl('?admin=1' + (pid ? '&p=' + encodeURIComponent(pid) : ''));
  };

  document.getElementById('projSel').addEventListener('change', e => goAdmin(e.target.value));
  document.getElementById('projNew').addEventListener('click', async () => {
    const title = prompt('새 심사 프로젝트 이름(심사표 제목)을 입력하세요:');
    if (!title) return;
    const d = JSON.parse(JSON.stringify(CONFIG.DEFAULTS));
    d.eventTitle = title;
    d.judges = [];      // 새 프로젝트는 심사위원을 새로 입력
    d.active = false;   // 미리 만들어두고 당일에 공개
    const id = randPid();
    await store.saveProject(id, d);
    goAdmin(id);
  });
  document.getElementById('projActive').addEventListener('click', async () => {
    const turnOn = SET.active === false;
    if (!confirm(turnOn
      ? '이 프로젝트를 공개할까요?\n심사위원 로그인 화면에 표시되고 입장이 가능해집니다.'
      : '이 프로젝트를 비공개로 전환할까요?\n심사위원 로그인 화면에서 숨겨지고 입장이 차단됩니다.')) return;
    SET.active = turnOn;
    await store.saveProject(PROJ, SET);
    location.reload();
  });
  document.getElementById('projDel').addEventListener('click', async () => {
    if (projects.length <= 1) { toast('마지막 프로젝트는 삭제할 수 없습니다.'); return; }
    if (!confirm('현재 프로젝트("' + SET.eventTitle + '")와 모든 점수·서명을 삭제할까요?\n되돌릴 수 없습니다.')) return;
    await store.deleteProject(PROJ);
    goAdmin('');
  });
  document.getElementById('btnReload').addEventListener('click', () => location.reload());
  document.getElementById('btnPrintSum').addEventListener('click', () => window.print());
  document.getElementById('btnXlsx').addEventListener('click', exportXlsx);
  document.getElementById('btnLogout').addEventListener('click', () => {
    if (confirm('관리자에서 로그아웃할까요?')) adminLogout();
  });

  renderSettingsSection();
  renderTeamsSection(teams);
  await renderLinksSection();
  await renderSummarySection();

  clearInterval(window.__sumTimer);
  window.__sumTimer = setInterval(() => {
    if (document.getElementById('secSummary')) renderSummarySection();
    else clearInterval(window.__sumTimer);
  }, 20000);
}

/* 행사 설정 (프로젝트 전반: 제목·심사위원·평가항목) */
function renderSettingsSection() {
  const el = document.getElementById('secSettings');
  const judgeRows = SET.judges.map((j, i) =>
    '<tr>' +
      '<td><input class="jname" data-i="' + i + '" value="' + esc(j.name) + '"></td>' +
      '<td><select class="jrole" data-i="' + i + '">' +
        '<option' + (j.role === '심사위원장' ? ' selected' : '') + '>심사위원장</option>' +
        '<option' + (j.role === '심사위원' ? ' selected' : '') + '>심사위원</option>' +
      '</select></td>' +
      '<td><input class="jphone" data-i="' + i + '" inputmode="numeric" maxlength="4" placeholder="0000" value="' + esc(j.phone || '') + '"></td>' +
      '<td><button class="copybtn jdel" data-i="' + i + '">삭제</button></td>' +
    '</tr>').join('');

  const critRows = SET.criteria.map((c, i) =>
    '<tr>' +
      '<td><input class="cname-in" data-i="' + i + '" value="' + esc(c.name) + '"></td>' +
      '<td style="width:70px"><input class="cmax-in" data-i="' + i + '" inputmode="numeric" value="' + esc(c.max) + '"></td>' +
      '<td><textarea class="cdesc-in" data-i="' + i + '" rows="2" style="width:100%;border:none;background:none;font:inherit;font-size:12px;resize:vertical" placeholder="세부 기준 (줄바꿈으로 구분)">' + esc((c.desc || []).join('\n')) + '</textarea></td>' +
      '<td style="width:56px"><button class="copybtn cdel" data-i="' + i + '">삭제</button></td>' +
    '</tr>').join('');

  el.innerHTML =
    '<h2>⚙️ 프로젝트 설정 <small style="font-weight:400;color:#888">— 행사명·심사위원·평가항목을 자유롭게 구성하세요</small></h2>' +
    '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px">' +
      '<label style="font-size:12.5px">행사/심사표 제목<br><input id="setTitle" style="width:100%;padding:7px;border:1px solid #d3d9e2;border-radius:8px" value="' + esc(SET.eventTitle) + '"></label>' +
      '<label style="font-size:12.5px">부문<br><input id="setCat" style="width:100%;padding:7px;border:1px solid #d3d9e2;border-radius:8px" value="' + esc(SET.category) + '"></label>' +
      '<label style="font-size:12.5px">심사일 (표기)<br><input id="setDate" style="width:100%;padding:7px;border:1px solid #d3d9e2;border-radius:8px" value="' + esc(SET.dateText) + '"></label>' +
      '<label style="font-size:12.5px">인쇄용 날짜 문구<br><input id="setDateLine" style="width:100%;padding:7px;border:1px solid #d3d9e2;border-radius:8px" value="' + esc(SET.dateLine) + '"></label>' +
      '<label style="font-size:12.5px">심사 대상(팀) 수<br><input id="setCount" inputmode="numeric" style="width:100%;padding:7px;border:1px solid #d3d9e2;border-radius:8px" value="' + esc(SET.teamCount) + '"></label>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:330px 1fr;gap:16px;align-items:start">' +
      '<div><h2 style="font-size:13px">심사위원 <small style="font-weight:400;color:#888">(전화 뒤 4자리 = 로그인 번호)</small></h2>' +
        '<table class="grid"><thead><tr><th>이름</th><th style="width:100px">직책</th><th style="width:66px">전화 뒤4</th><th style="width:52px"></th></tr></thead>' +
        '<tbody id="judgeBody">' + judgeRows + '</tbody></table>' +
        '<button class="btn" id="jAdd" style="margin-top:8px;font-size:12px;padding:6px 12px">＋ 심사위원 추가</button></div>' +
      '<div><h2 style="font-size:13px">평가항목 <small style="font-weight:400;color:#888">(배점 합계: <b id="maxSum">' + totalMax() + '</b>점)</small></h2>' +
        '<table class="grid"><thead><tr><th style="width:110px">항목명</th><th style="width:70px">배점</th><th>세부 기준</th><th style="width:56px"></th></tr></thead>' +
        '<tbody id="critBody">' + critRows + '</tbody></table>' +
        '<button class="btn" id="cAdd" style="margin-top:8px;font-size:12px;padding:6px 12px">＋ 항목 추가</button></div>' +
    '</div>' +
    '<div style="margin-top:14px;display:flex;gap:10px;align-items:center">' +
      '<button class="btn primary" id="setSave">저장 후 새로고침</button>' +
      '<span id="setStat" style="font-size:12.5px;color:#16a34a;min-width:90px">자동 저장 켜짐</span>' +
      '<span style="font-size:12px;color:#888">⚠️ 평가항목 변경은 이미 입력된 점수 열과 어긋날 수 있으니 심사 시작 전에 확정하세요.</span>' +
    '</div>';

  /* 실시간 자동 저장 (입력 1초 후) */
  let setTimer = null;
  const setStat = (msg, ok) => {
    const s = document.getElementById('setStat');
    if (s) { s.textContent = msg; s.style.color = ok ? '#16a34a' : '#d97706'; }
  };
  const autosaveSettings = () => {
    setStat('저장 중…', false);
    clearTimeout(setTimer);
    setTimer = setTimeout(async () => {
      try {
        const s = readForm();
        const countChanged = s.teamCount !== SET.teamCount;
        await store.saveProject(PROJ, s);
        SET = s;
        setStat('자동 저장됨 ✓', true);
        if (countChanged) renderTeamsSection(await teamsFilled());
      } catch (e) {
        console.error(e);
        setStat('저장 실패!', false);
      }
    }, 1000);
  };

  const readForm = () => {
    // 이름이 비어 있는 행도 유지 (입력 중 자동 저장으로 행이 사라지지 않도록)
    const judges = [];
    el.querySelectorAll('#judgeBody tr').forEach((tr, i) => {
      const old = SET.judges[i];
      judges.push({
        id: old ? old.id : (Math.max(0, ...SET.judges.map(j => j.id), 0) + i + 1),
        name: tr.querySelector('.jname').value.trim(),
        role: tr.querySelector('.jrole').value,
        phone: tr.querySelector('.jphone').value.replace(/\D/g, '').slice(0, 4),
        token: old ? old.token : randToken(),
      });
    });
    const criteria = [];
    el.querySelectorAll('#critBody tr').forEach(tr => {
      criteria.push({
        name: tr.querySelector('.cname-in').value.trim(),
        max: Number(tr.querySelector('.cmax-in').value) || 0,
        desc: tr.querySelector('.cdesc-in').value.split('\n').map(s => s.trim()).filter(Boolean),
      });
    });
    return {
      active: SET.active,
      eventTitle: el.querySelector('#setTitle').value.trim(),
      category: el.querySelector('#setCat').value.trim(),
      dateText: el.querySelector('#setDate').value.trim(),
      dateLine: el.querySelector('#setDateLine').value.trim(),
      teamCount: Math.max(1, Number(el.querySelector('#setCount').value) || 1),
      judges, criteria,
    };
  };

  const saveNow = async () => {
    clearTimeout(setTimer);
    await store.saveProject(PROJ, SET);
  };

  el.onclick = async e => {
    if (e.target.id === 'jAdd') {
      SET = readForm();
      SET.judges.push({ id: Math.max(0, ...SET.judges.map(j => j.id), 0) + 1, name: '', role: '심사위원', phone: '', token: randToken() });
      await saveNow();
      renderSettingsSection();
    } else if (e.target.id === 'cAdd') {
      SET = readForm();
      SET.criteria.push({ name: '', max: 10, desc: [] });
      await saveNow();
      renderSettingsSection();
    } else if (e.target.classList.contains('jdel')) {
      const i = +e.target.dataset.i;
      const nm = SET.judges[i] && SET.judges[i].name;
      if (!confirm((nm ? '"' + nm + '" 위원을' : '이 행을') + ' 삭제할까요?\n해당 위원의 점수·서명 데이터 연결이 끊어집니다.')) return;
      SET = readForm();
      SET.judges.splice(i, 1);
      await saveNow();
      renderSettingsSection();
    } else if (e.target.classList.contains('cdel')) {
      SET = readForm();
      SET.criteria.splice(+e.target.dataset.i, 1);
      await saveNow();
      renderSettingsSection();
    } else if (e.target.id === 'setSave') {
      const s = readForm();
      if (!s.judges.some(j => j.name)) { toast('심사위원을 1명 이상 입력해주세요.'); return; }
      if (!s.criteria.some(c => c.name)) { toast('평가항목을 1개 이상 입력해주세요.'); return; }
      try {
        clearTimeout(setTimer);
        await store.saveProject(PROJ, s);
        SET = s;
        toast('✅ 설정이 저장되었습니다.');
        const projects = await store.getProjects();
        renderAdmin(projects);
      } catch (err) {
        console.error(err);
        toast('저장 실패: ' + (err.message || err));
      }
    }
  };
  el.oninput = e => {
    if (e.target.classList.contains('cmax-in')) {
      let sum = 0;
      el.querySelectorAll('.cmax-in').forEach(inp => { sum += Number(inp.value) || 0; });
      document.getElementById('maxSum').textContent = sum;
    }
    autosaveSettings();
  };
  el.onchange = e => {
    if (e.target.tagName === 'SELECT') autosaveSettings();
  };
}

/* 팀 명단 */
function renderTeamsSection(teams) {
  const el = document.getElementById('secTeams');
  const rows = teams.map((t, i) =>
    '<tr><td style="width:44px">' + t.no + '</td>' +
    '<td><input data-r="' + i + '" data-c="0" data-no="' + t.no + '" value="' + esc(t.unit) + '"></td>' +
    '<td><input data-r="' + i + '" data-c="1" data-no="' + t.no + '" value="' + esc(t.name) + '"></td></tr>'
  ).join('');
  el.innerHTML =
    '<h2>👥 팀 명단 <small style="font-weight:400;color:#888">— 모든 심사표에 공통 표시되며 실시간 자동 저장됩니다</small> ' +
    '<span id="teamStat" style="font-size:12px;color:#16a34a;font-weight:400"></span></h2>' +
    '<table class="grid" style="max-width:520px"><thead><tr><th style="width:44px">연번</th>' +
    '<th>단위(개인/단체)</th><th>성명(팀명)</th></tr></thead><tbody id="teamBody">' + rows + '</tbody></table>';
  bindGridNav(el.querySelector('#teamBody'));

  const collectTeams = () => {
    const out = [];
    el.querySelectorAll('#teamBody tr').forEach(tr => {
      const inputs = tr.querySelectorAll('input');
      out.push({ no: +inputs[0].dataset.no, unit: inputs[0].value.trim(), name: inputs[1].value.trim() });
    });
    return out;
  };
  const teamStat = (msg, ok) => {
    const s = document.getElementById('teamStat');
    if (s) { s.textContent = msg; s.style.color = ok ? '#16a34a' : '#d97706'; }
  };
  let teamTimer = null;
  el.oninput = () => {
    teamStat('저장 중…', false);
    clearTimeout(teamTimer);
    teamTimer = setTimeout(async () => {
      try {
        await store.saveTeams(PROJ, collectTeams());
        teamStat('자동 저장됨 ✓', true);
      } catch (e) {
        console.error(e);
        teamStat('저장 실패!', false);
      }
    }, 800);
  };
}

/* 심사위원 접속·진행·서명 관리 */
async function renderLinksSection() {
  const el = document.getElementById('secLinks');
  const judges = namedJudges();
  const all = await store.getAllScores(PROJ, judges.map(j => j.id));
  const sigs = {};
  for (const j of judges) sigs[j.id] = await store.getSignatureMeta(PROJ, j.id);

  const rows = judges.map(j => {
    const link = judgeUrl(PROJ, j.token);
    const scores = all[j.id] || {};
    let done = 0, maxU = '';
    for (let n = 1; n <= SET.teamCount; n++) {
      const sc = scores[n];
      if (sc && sc.u && sc.u > maxU) maxU = sc.u;
      if (sc && SET.criteria.every((c, i) => sc.vals[i] !== null && sc.vals[i] !== undefined && sc.vals[i] !== '')) done++;
    }
    const sig = sigs[j.id];
    const editedAfterSign = sig && maxU && sig.at && maxU > sig.at;
    let sigCell;
    if (!sig) {
      sigCell = '<span class="sigstat-no">미서명</span>';
    } else {
      sigCell = '<span class="sigstat-ok">완료</span>' +
        (editedAfterSign ? '<br><span style="color:#d97706;font-size:11px">⚠️ 서명 후 수정됨</span>' : '') +
        '<br><button class="copybtn sigview" data-id="' + j.id + '">보기</button>' +
        '<button class="copybtn sigdel" data-id="' + j.id + '" data-name="' + esc(j.name) + '" style="color:#b91c1c">삭제</button>';
    }
    return '<tr><td>' + esc(j.name) + '</td><td>' + esc(j.role) + '</td>' +
      '<td>' + (j.phone ? esc(j.phone) : '<span style="color:#b91c1c">미설정</span>') + '</td>' +
      '<td>' + done + '/' + SET.teamCount + '</td>' +
      '<td>' + sigCell + '</td>' +
      '<td><a href="' + esc(link) + '" target="_blank" style="font-size:12px">심사표 열기</a>' +
        '<button class="copybtn cpy" data-link="' + esc(link) + '">링크 복사</button></td></tr>';
  }).join('');

  el.innerHTML =
    '<h2>🔗 심사위원 현황·서명 관리 <small style="font-weight:400;color:#888">— 심사위원은 첫 화면에서 이름+전화 뒤 4자리로 입장합니다</small></h2>' +
    '<table class="grid"><thead><tr><th style="width:80px">이름</th><th style="width:90px">직책</th>' +
    '<th style="width:70px">전화 뒤4</th><th style="width:70px">입력</th><th style="width:130px">서명</th><th>바로가기</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<div style="font-size:12px;color:#888;margin-top:8px">첫 화면 주소: <b>' + esc(appUrl('')) + '</b> — 이 주소만 심사위원들에게 공유하면 됩니다. ' +
    '[심사표 열기]로 관리자가 직접 수정할 수 있으며, 서명 완료된 심사표는 경고를 거쳐야 수정됩니다.</div>';

  el.querySelectorAll('.cpy').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.link); toast('링크가 복사되었습니다.'); }
    catch (e) { prompt('복사해주세요:', b.dataset.link); }
  }));
  el.querySelectorAll('.sigview').forEach(b => b.addEventListener('click', () => {
    const sig = sigs[+b.dataset.id];
    if (!sig) return;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = '<div class="modal"><h2>서명 확인</h2>' +
      '<div class="sub">서명 일시: ' + esc(sig.at ? new Date(sig.at).toLocaleString('ko-KR') : '-') + '</div>' +
      '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:14px">' +
      '<img src="' + sig.png + '" style="max-width:100%;max-height:140px"></div>' +
      '<button class="btn" style="width:100%" id="sigClose">닫기</button></div>';
    document.body.appendChild(back);
    back.addEventListener('click', e => { if (e.target === back || e.target.id === 'sigClose') back.remove(); });
  }));
  el.querySelectorAll('.sigdel').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('⚠️ ' + b.dataset.name + ' 위원의 서명을 삭제할까요?\n\n삭제하면 해당 심사표는 "미서명" 상태가 되고,\n심사위원이 다시 서명해야 합니다.')) return;
    await store.deleteSignature(PROJ, +b.dataset.id);
    toast('서명이 삭제되었습니다. 재서명을 요청해주세요.');
    renderLinksSection();
  }));
}

/* 취합 */
async function renderSummarySection() {
  const el = document.getElementById('secSummary');
  if (!el) return;
  const teams = await teamsFilled();
  const judges = namedJudges();
  const all = await store.getAllScores(PROJ, judges.map(j => j.id));

  const totals = teams.map(t => {
    const per = judges.map(j => {
      const sc = (all[j.id] || {})[t.no];
      if (!sc) return null;
      const filled = SET.criteria.map((c, i) => sc.vals[i]).filter(v => v !== null && v !== undefined && v !== '');
      return filled.length ? filled.reduce((a, v) => a + Number(v), 0) : null;
    });
    const nums = per.filter(v => v !== null);
    return {
      no: t.no, unit: t.unit, name: t.name, per,
      sum: nums.length ? nums.reduce((a, v) => a + v, 0) : null,
      avg: nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null,
    };
  });
  const ranked = totals.filter(t => t.avg !== null).sort((a, b) => b.avg - a.avg);
  totals.forEach(t => {
    t.rank = t.avg === null ? '' : ranked.findIndex(x => x.avg === t.avg) + 1;
  });

  const rows = totals.map(t =>
    '<tr><td>' + t.no + '</td><td>' + esc(t.unit) + '</td><td>' + esc(t.name) + '</td>' +
    t.per.map(v => '<td>' + (v === null ? '' : v) + '</td>').join('') +
    '<td class="hl">' + (t.sum === null ? '' : t.sum) + '</td>' +
    '<td class="hl">' + (t.avg === null ? '' : (Math.round(t.avg * 100) / 100)) + '</td>' +
    '<td class="hl">' + t.rank + '</td></tr>').join('');

  el.innerHTML =
    '<div class="p-title" style="font-size:15px">' + esc(SET.eventTitle) + ' — 심사결과 취합(총괄)</div>' +
    '<table class="grid" style="margin-top:10px"><thead><tr>' +
    '<th style="width:38px">연번</th><th style="width:86px">단위</th><th style="width:80px">성명</th>' +
    judges.map(j => '<th>' + esc(j.name) + '</th>').join('') +
    '<th style="width:56px">합계</th><th style="width:56px">평균</th><th style="width:46px">순위</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div style="font-size:11.5px;color:#888;margin-top:8px" class="print-hide">순위는 평균 점수 기준(미입력 위원 제외)이며 20초마다 자동 갱신됩니다.</div>';
}

/* 엑셀(xlsx) 저장 — 취합 1시트 + 위원별 심사표 시트(서명 이미지 포함) */
async function exportXlsx() {
  toast('엑셀 파일을 만드는 중…');
  const teams = await teamsFilled();
  const judges = namedJudges();
  const all = await store.getAllScores(PROJ, judges.map(j => j.id));
  const sigs = {};
  for (const j of judges) sigs[j.id] = await store.getSignatureMeta(PROJ, j.id);

  const wb = new ExcelJS.Workbook();
  const border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
  const titleFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };

  const rowTotal = sc => {
    if (!sc) return null;
    const nums = SET.criteria.map((c, i) => sc.vals[i]).filter(v => v != null && v !== '');
    return nums.length ? nums.reduce((a, v) => a + Number(v), 0) : null;
  };

  /* ── 취합 시트 ── */
  const ws = wb.addWorksheet('취합');
  const sumCols = 3 + judges.length + 3;
  ws.mergeCells(1, 1, 1, sumCols);
  const tcell = ws.getCell(1, 1);
  tcell.value = SET.eventTitle + ' — 심사결과 취합(총괄)';
  tcell.fill = titleFill;
  tcell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 13 };
  tcell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 26;

  const sumHead = ['연번', '단위', '성명'].concat(judges.map(j => j.name)).concat(['합계', '평균', '순위']);
  ws.addRow([]);
  const hr = ws.addRow(sumHead);
  hr.eachCell(c => { c.fill = headFill; c.font = { bold: true }; c.border = border; c.alignment = { horizontal: 'center' }; });

  const totals = teams.map(t => {
    const per = judges.map(j => rowTotal((all[j.id] || {})[t.no]));
    const nums = per.filter(v => v !== null);
    return {
      t, per,
      sum: nums.length ? nums.reduce((a, v) => a + v, 0) : null,
      avg: nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null,
    };
  });
  const rankedAvgs = totals.filter(x => x.avg !== null).map(x => x.avg).sort((a, b) => b - a);
  totals.forEach(x => {
    const row = ws.addRow(
      [x.t.no, x.t.unit, x.t.name]
        .concat(x.per.map(v => v === null ? '' : v))
        .concat([
          x.sum === null ? '' : x.sum,
          x.avg === null ? '' : Math.round(x.avg * 100) / 100,
          x.avg === null ? '' : rankedAvgs.indexOf(x.avg) + 1,
        ]));
    row.eachCell({ includeEmpty: true }, (c, col) => {
      if (col <= sumCols) { c.border = border; c.alignment = { horizontal: 'center' }; }
    });
  });
  ws.getColumn(2).width = 16; ws.getColumn(3).width = 14;

  /* ── 위원별 시트 ── */
  for (const j of judges) {
    const wj = wb.addWorksheet(j.name);
    const nCols = 3 + SET.criteria.length + 2;
    wj.mergeCells(1, 1, 1, nCols);
    const c1 = wj.getCell(1, 1);
    c1.value = SET.eventTitle;
    c1.fill = titleFill;
    c1.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 13 };
    c1.alignment = { horizontal: 'center', vertical: 'middle' };
    wj.getRow(1).height = 26;

    wj.addRow([]);
    wj.addRow(['심사위원', j.name + (j.role === '심사위원장' ? ' (위원장)' : ''), '', '부문', SET.category, '', '심사일', SET.dateText]);

    wj.addRow([]);
    const jh = wj.addRow(['연번', '단위(개인/단체)', '성명']
      .concat(SET.criteria.map(c => c.name + '(' + c.max + ')'))
      .concat(['총점', '심사의견']));
    jh.eachCell(c => { c.fill = headFill; c.font = { bold: true }; c.border = border; c.alignment = { horizontal: 'center', wrapText: true }; });

    teams.forEach(t => {
      const sc = (all[j.id] || {})[t.no] || { vals: [], comment: '' };
      const tot = rowTotal(sc);
      const row = wj.addRow(
        [t.no, t.unit, t.name]
          .concat(SET.criteria.map((c, i) => sc.vals[i] == null ? '' : sc.vals[i]))
          .concat([tot === null ? '' : tot, sc.comment || '']));
      row.eachCell({ includeEmpty: true }, (c, col) => {
        if (col <= nCols) {
          c.border = border;
          c.alignment = col === nCols ? { wrapText: true, vertical: 'middle' } : { horizontal: 'center', vertical: 'middle' };
        }
      });
    });
    wj.getColumn(2).width = 16; wj.getColumn(3).width = 12;
    wj.getColumn(nCols).width = 44;

    /* 확인 문구 + 서명 이미지 */
    const base = wj.rowCount + 2;
    wj.mergeCells(base, 1, base, nCols);
    wj.getCell(base, 1).value = '위 평가 결과는 본인이 직접 심사한 내용임을 확인합니다.';
    wj.getCell(base, 1).alignment = { horizontal: 'center' };
    wj.getCell(base, 1).font = { bold: true };
    wj.getCell(base + 1, 1).value = SET.dateLine;
    wj.mergeCells(base + 1, 1, base + 1, nCols);
    wj.getCell(base + 1, 1).alignment = { horizontal: 'center' };
    wj.getCell(base + 3, 2).value = '심사위원';
    wj.getCell(base + 3, 2).font = { bold: true };
    wj.getCell(base + 3, 3).value = j.name;
    const sig = sigs[j.id];
    if (sig && sig.png) {
      const imgId = wb.addImage({ base64: sig.png, extension: 'png' });
      wj.addImage(imgId, { tl: { col: 3.2, row: base + 1.6 }, ext: { width: 150, height: 52 } });
      wj.getRow(base + 3).height = 44;
      wj.getCell(base + 3, 6).value = '(서명: ' + (sig.at ? new Date(sig.at).toLocaleString('ko-KR') : '') + ')';
      wj.getCell(base + 3, 6).font = { size: 9, color: { argb: 'FF888888' } };
    } else {
      wj.getCell(base + 3, 5).value = '(미서명)';
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (SET.eventTitle || '심사결과') + '.xlsx';
  a.click();
  toast('✅ 엑셀 파일이 저장되었습니다. (취합 + 위원별 시트, 서명 포함)');
}

/* ─────────────────────── 로그인 화면 ─────────────────────── */

async function renderLogin(allProjects) {
  const projects = allProjects.filter(p => p.data.active !== false);   // 공개된 프로젝트만
  if (!projects.length) {
    $app.innerHTML = '<div class="landing"><h1>🏆 심사위원 입장</h1>' +
      '<p>현재 진행 중인 심사가 없습니다.<br>운영자의 안내를 기다려주세요.</p></div>';
    return;
  }
  const projOptions = projects.map(p =>
    '<option value="' + esc(p.id) + '">' + esc(p.data.eventTitle || '(제목 없음)') + '</option>').join('');

  let demoLinks = '';
  if (!IS_REAL) {
    demoLinks = '<div class="links"><b>🧪 체험용 바로가기</b><br>' +
      '<a href="?admin=1">관리자 화면</a></div>';
  }

  $app.innerHTML =
    '<div class="landing"><h1>🏆 심사위원 입장</h1>' +
    '<p>심사 프로젝트와 본인 이름을 선택하고<br>전화번호 뒤 4자리를 입력해주세요.</p>' +
    '<div style="margin-top:18px;display:grid;gap:10px;text-align:left">' +
      '<select id="loginProj" style="padding:12px;border:1.5px solid #d3d9e2;border-radius:10px;font-size:15px">' +
        (projects.length > 1 ? '<option value="">— 심사 프로젝트 선택 —</option>' : '') + projOptions + '</select>' +
      '<select id="loginJudge" style="padding:12px;border:1.5px solid #d3d9e2;border-radius:10px;font-size:15px">' +
        '<option value="">— 심사위원 선택 —</option></select>' +
      '<input id="loginPhone" type="password" inputmode="numeric" maxlength="4" placeholder="전화번호 뒤 4자리"' +
        ' style="padding:12px;border:1.5px solid #d3d9e2;border-radius:10px;font-size:15px;letter-spacing:4px">' +
      '<button class="btn primary" id="loginBtn" style="padding:13px 0;font-size:15px">입장하기</button>' +
      '<div id="loginErr" style="display:none;color:#b91c1c;font-size:13px;text-align:center"></div>' +
    '</div>' + demoLinks +
    '<div style="margin-top:22px"><a href="?admin=1" style="font-size:12px;color:#9ca3af">🔐 관리자 로그인</a></div>' +
    '</div>';

  const projSel = document.getElementById('loginProj');
  const judgeSel = document.getElementById('loginJudge');

  const fillJudges = async () => {
    judgeSel.innerHTML = '<option value="">— 심사위원 선택 —</option>';
    const p = projects.find(x => x.id === projSel.value);
    if (!p) return;
    (p.data.judges || []).filter(j => j.name).forEach(j => {
      const opt = document.createElement('option');
      opt.value = j.token;
      opt.textContent = j.name + ' ' + j.role;
      judgeSel.appendChild(opt);
    });
  };
  projSel.addEventListener('change', fillJudges);
  await fillJudges();

  const tryLogin = () => {
    const err = document.getElementById('loginErr');
    const show = m => { err.textContent = m; err.style.display = 'block'; };
    const p = projects.find(x => x.id === projSel.value);
    if (!p) { show('심사 프로젝트를 선택해주세요.'); return; }
    const judge = (p.data.judges || []).find(j => j.token === judgeSel.value);
    if (!judge) { show('심사위원을 선택해주세요.'); return; }
    const pin = document.getElementById('loginPhone').value.trim();
    if (!judge.phone) { show('아직 전화번호가 등록되지 않았습니다. 운영자에게 문의해주세요.'); return; }
    if (pin !== judge.phone) { show('전화번호 뒤 4자리가 일치하지 않습니다.'); return; }
    location.href = judgeUrl(p.id, judge.token);
  };
  document.getElementById('loginBtn').addEventListener('click', tryLogin);
  document.getElementById('loginPhone').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryLogin();
  });
}

/* ─────────────────────── 관리자 로그인 화면 ─────────────────────── */

function renderAdminLogin() {
  $app.innerHTML =
    '<div class="landing"><h1>🔐 관리자 로그인</h1>' +
    '<p>심사 프로젝트 관리를 위해 로그인해주세요.</p>' +
    '<div style="margin-top:18px;display:grid;gap:10px;text-align:left">' +
      '<input id="adminId" placeholder="아이디" autocomplete="username"' +
        ' style="padding:12px;border:1.5px solid #d3d9e2;border-radius:10px;font-size:15px">' +
      '<input id="adminPw" type="password" placeholder="비밀번호" autocomplete="current-password"' +
        ' style="padding:12px;border:1.5px solid #d3d9e2;border-radius:10px;font-size:15px">' +
      '<button class="btn primary" id="adminLoginBtn" style="padding:13px 0;font-size:15px">로그인</button>' +
      '<div id="adminErr" style="display:none;color:#b91c1c;font-size:13px;text-align:center"></div>' +
    '</div>' +
    '<div style="margin-top:22px"><a href="' + esc(appUrl('')) + '" style="font-size:12px;color:#9ca3af">← 심사위원 입장으로</a></div>' +
    '</div>';

  const tryLogin = async () => {
    const id = document.getElementById('adminId').value.trim();
    const pw = document.getElementById('adminPw').value;
    const err = document.getElementById('adminErr');
    const hash = await sha256Hex(pw);
    if (id !== CONFIG.ADMIN_ID || hash !== CONFIG.ADMIN_PW_HASH) {
      err.textContent = '아이디 또는 비밀번호가 일치하지 않습니다.';
      err.style.display = 'block';
      return;
    }
    try { localStorage.setItem(ADMIN_AUTH_KEY, hash); } catch (e) {}
    location.href = appUrl('?admin=1');
  };
  document.getElementById('adminLoginBtn').addEventListener('click', tryLogin);
  document.getElementById('adminPw').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryLogin();
  });
  document.getElementById('adminId').focus();
}

/* ─────────────────────── 라우팅 ─────────────────────── */

(async function main() {
  try {
    const tok = params.get('j');
    const admin = params.get('admin');
    const pid = params.get('p');

    if (tok && pid) {
      if (!(await loadProject(pid))) {
        $app.innerHTML = '<div class="landing"><h1>프로젝트를 찾을 수 없습니다</h1><p>첫 화면에서 다시 로그인해주세요.</p><p><a href="' + esc(appUrl('')) + '">로그인 화면으로</a></p></div>';
        return;
      }
      const judge = judgeByToken(tok);
      if (!judge) {
        $app.innerHTML = '<div class="landing"><h1>잘못된 접속입니다</h1><p><a href="' + esc(appUrl('')) + '">로그인 화면으로</a></p></div>';
        return;
      }
      if (SET.active === false) {
        $app.innerHTML = '<div class="landing"><h1>⏳ 아직 공개되지 않은 심사입니다</h1><p>운영자가 공개하면 입장할 수 있습니다.</p><p><a href="' + esc(appUrl('')) + '">로그인 화면으로</a></p></div>';
        return;
      }
      if (params.get('sign')) renderSignPage(judge);
      else renderJudge(judge);
      return;
    }

    if (admin !== null) {
      if (!isAdminAuthed()) {
        renderAdminLogin();
        return;
      }
      const projects = await ensureAnyProject();
      const target = (pid && projects.some(p => p.id === pid)) ? pid : projects[0].id;
      await loadProject(target);
      renderAdmin(projects);
      return;
    }

    const projects = await ensureAnyProject();
    renderLogin(projects);
  } catch (e) {
    console.error(e);
    $app.innerHTML = '<div class="loading">불러오기 실패: ' + esc(e.message || e) + '</div>';
  }
})();
