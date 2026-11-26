// 네이버 순위체커 서버: http://localhost:4417
// 이 PC가 서버 역할을 하고, 웹공유_실행.bat 으로 외부 링크(Cloudflare 무료 터널)를 붙이면
// 다른 PC·폰에서도 링크 + 비밀번호로 접속해 조회하고, 결과를 엑셀로 받을 수 있다.
// 한 번 실행하면 업체의 [플레이스 → 통검노출 → 통검클립] 키워드를 차례로 확인하고, 결과는 이 PC의 결과 폴더에도 CSV로 남는다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const checkers = require('./checkers.cjs');

// 서버(호스팅) 모드: PORT 환경변수가 있으면 모든 주소(0.0.0.0)에서 받고, 자료는 DATA_DIR 에 둔다.
const SERVER_MODE = !!process.env.PORT;
const PORT = +process.env.PORT || 4417;
const HOST = SERVER_MODE ? '0.0.0.0' : '127.0.0.1';
const DATA = process.env.DATA_DIR || __dirname;
const ROOT = __dirname;
const RESULT_DIR = path.join(DATA, '결과');
const SETTINGS = path.join(DATA, '설정.json');
const HISTORY = path.join(RESULT_DIR, '순위기록.json');
fs.mkdirSync(RESULT_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  vendors: [
    { name: '하얀미소치과의원', ids: '하얀미소, whitesmile001, 13248170',
      place: '청주치과\n금천동치과\n청주임플란트\n청주치아교정\n청주스케일링',
      search: '청주치과\n금천동치과\n청주임플란트\n청주치아교정\n청주스케일링',
      clip: '청주치과\n금천동치과\n청주임플란트\n청주치아교정\n청주스케일링\n충치치료\n치아미백' },
  ],
  delaySec: 3, clipDelaySec: 1,
};
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8');
function loadSettings() {
  const s = readJson(SETTINGS, null) || JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  // 예전 형식(keywords 하나)이면 세 칸에 똑같이 넣는다.
  for (const v of s.vendors || []) if (v.keywords && !v.place && !v.search && !v.clip) { v.place = v.search = v.clip = v.keywords; delete v.keywords; }
  return s;
}
if (!fs.existsSync(SETTINGS)) writeJson(SETTINGS, DEFAULT_SETTINGS);

/* ---- 접속(세션)별 작업 / 실시간 전송 ----
   링크로 여러 사람이 접속해도 각자 자기 검사만 보이게 세션별로 나눈다.
   네이버 조회는 한 번에 하나씩만 돌도록 줄 세운다(동시에 몰리면 보안 확인이 잦아짐). */
const sessions = new Map();   // token -> { job, clients:Set, last }
function sess(token) { let x = sessions.get(token); if (!x) { x = { job: null, clients: new Set(), last: Date.now() }; sessions.set(token, x); } x.last = Date.now(); return x; }
function sendTo(S, ev, data) { const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of S.clients) c.write(msg); }
function logTo(S, text) { const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${text}`; if (S.job) S.job.log.push(line); sendTo(S, 'log', line); console.log(line); }
let queue = Promise.resolve(); let waiting = 0;

const KIND_NAME = { place: '플레이스', search: '통검노출', clip: '통검클립' };
const KINDS = ['place', 'search', 'clip'];
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
const today = () => new Date().toLocaleDateString('sv-SE');
const safe = s => String(s).replace(/[\\/:*?"<>|]/g, '').trim() || '업체';

function prevRank(kind, vendor, keyword) {
  const h = readJson(HISTORY, {});
  const arr = (h[`${kind}|${vendor}|${keyword}`] || []).filter(x => x.date !== today());
  return arr.length ? arr[arr.length - 1] : null;
}
function saveRank(kind, vendor, keyword, rank, label) {
  const h = readJson(HISTORY, {});
  const key = `${kind}|${vendor}|${keyword}`;
  const arr = (h[key] || []).filter(x => x.date !== today());
  arr.push({ date: today(), rank, label });
  h[key] = arr.slice(-60);
  writeJson(HISTORY, h);
}

// 결과 객체 → 표 한 줄
function toRow(kind, keyword, r) {
  const base = { kind, keyword, status: r.status, url: r.url, note: r.note || '' };
  if (kind === 'place') {
    const f = (r.found || [])[0];
    const out = r.basis === '통검 플레이스' ? '5페이지 밖' : `${r.limit || 30}위 밖`;
    return { ...base, rank: r.rank, label: r.rank ? `${r.rank}위` : (r.status === '순위밖' ? out : '-'),
      detail: f ? (f.visitorReviews ? `${f.name} · 방문자리뷰 ${f.visitorReviews} · 블로그리뷰 ${f.blogReviews}` : f.name) : '',
      extra: [r.basis ? '기준: ' + r.basis : '', r.ad || ''].filter(Boolean).join(' · '), link: f ? f.link : '', top: r.top || [] };
  }
  if (kind === 'clip') {
    // 대량 확인용: 통검에 클립 영역이 있는지만 본다. 내 클립 포함 여부는 참고로만.
    return { ...base, rank: r.exists ? 1 : null, label: r.exists ? '있음' : (r.status === '클립 없음' ? '없음' : '-'),
      detail: r.exists && r.mine ? '내 클립 포함' : '', extra: '', link: '' };
  }
  const found = r.found || [];
  const main = found[0];
  const own = found.filter(x => x.by === '자사 채널');
  return { ...base, rank: main ? main.rank : null, label: r.best || (r.status === '미노출' ? '미노출' : '-'),
    detail: main ? `[${main.type}] ${main.title}` : '',
    extra: found.length ? `목록 노출 ${found.length}건 (자사 ${own.length} / 외부 ${found.length - own.length}) · 목록 ${r.listTotal}개 중` : (r.listTotal ? `목록 ${r.listTotal}개 확인` : ''),
    link: main ? main.link : '', found };
}

function csvCell(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function writeCsv(dir, kind, rows) {
  const file = path.join(dir, `${KIND_NAME[kind]}.csv`);
  const now = new Date().toLocaleString('ko-KR', { hour12: false });
  const lines = [];
  if (kind === 'clip') {
    lines.push(['확인일시', '키워드', '통검 클립', '이전', '변동', '내 클립 포함', '검색주소', '비고'].join(','));
    for (const r of rows) lines.push([now, r.keyword, r.label, r.prev || '', r.change || '', /내 클립/.test(r.detail) ? 'O' : '', r.url, r.note].map(csvCell).join(','));
  } else {
    lines.push(['확인일시', '키워드', '결과', '순위', '이전순위', '변동', '내용', '부가정보', '링크', '검색주소', '비고'].join(','));
    for (const r of rows) lines.push([now, r.keyword, r.status, r.label, r.prev || '', r.change || '', r.detail, r.extra, r.link, r.url, r.note].map(csvCell).join(','));
  }
  if (kind === 'search') {
    lines.push('', ['키워드', '목록순위', '구분', '자사/외부', '제목', '출처', '링크'].join(','));
    for (const r of rows) for (const f of r.found || []) lines.push([r.keyword, f.rank, f.type, f.by, f.title, f.source, f.link].map(csvCell).join(','));
  }
  fs.writeFileSync(file, '﻿' + lines.join('\r\n'), 'utf8');
  return file;
}

async function checkOne(kind, kw, targets, common) {
  try {
    if (kind === 'place') return await checkers.checkPlace(kw, targets, common);
    if (kind === 'search') return await checkers.checkSearch(kw, targets, common);
    return await checkers.checkClipFast(kw, targets, common);
  } catch (e) { return { status: '확인필요', note: '오류: ' + e.message }; }
}

async function runAll(S, vendor, ids, lists, opt) {
  const send = (e, d) => sendTo(S, e, d); const log = t => logTo(S, t);
  const targets = ids.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const plan = KINDS.map(k => ({ kind: k, keywords: lists[k] || [] })).filter(p => p.keywords.length);
  const total = plan.reduce((a, p) => a + p.keywords.length, 0);
  const job = S.job;
  Object.assign(job, { vendor, running: true, total, done: 0, plan: plan.map(p => ({ kind: p.kind, n: p.keywords.length })) });
  send('start', { vendor, total, plan: job.plan });
  log(`전체 검사 시작 · ${vendor} · ` + plan.map(p => `${KIND_NAME[p.kind]} ${p.keywords.length}개`).join(', ') + ` · 식별어: ${targets.join(', ')}`);
  const dir = path.join(RESULT_DIR, `${safe(vendor)}_${stamp()}`);
  // 원격 접속자는 보안 확인 창을 볼 수 없으므로 창 띄우기는 끄고 '확인필요'로 넘긴다.
  const common = { ...opt, interactive: false, onLog: log, shouldStop: () => job.stop };
  const files = [];
  for (const p of plan) {
    if (job.stop) break;
    job.current = p.kind;
    log(`── ${KIND_NAME[p.kind]} 확인 (${p.keywords.length}개)`);
    send('section', { kind: p.kind });
    const delay = Math.max(p.kind === 'clip' ? 0.5 : 1, p.kind === 'clip' ? (opt.clipDelaySec ?? 1) : (opt.delaySec ?? 3)) * 1000;
    for (let i = 0; i < p.keywords.length; i++) {
      if (job.stop) { log('중지됨. 여기까지 저장합니다.'); break; }
      const kw = p.keywords[i];
      job.curKeyword = kw;
      send('progress', { kind: p.kind, keyword: kw, done: job.done, total });
      const row = toRow(p.kind, kw, await checkOne(p.kind, kw, targets, common));
      const prev = prevRank(p.kind, vendor, kw);
      if (prev) {
        row.prev = prev.label + ` (${prev.date.slice(5)})`;
        if (p.kind === 'clip') row.change = prev.rank && !row.rank && row.status !== '확인필요' ? '이탈' : (!prev.rank && row.rank ? '신규' : '-');
        else if (prev.rank && row.rank) row.change = prev.rank === row.rank ? '-' : (prev.rank > row.rank ? `▲${prev.rank - row.rank}` : `▼${row.rank - prev.rank}`);
        else if (!prev.rank && row.rank) row.change = '신규';
        else if (prev.rank && !row.rank && row.status !== '확인필요') row.change = '이탈';
      }
      if (row.status !== '확인필요') saveRank(p.kind, vendor, kw, row.rank, row.label);
      job.rows[p.kind].push(row); job.done++;
      send('row', row);
      if (p.kind !== 'clip') log(`${KIND_NAME[p.kind]} · ${kw}: ${row.label}${row.change && row.change !== '-' ? ' ' + row.change : ''}`);
      if (i < p.keywords.length - 1 && !job.stop) await new Promise(res => setTimeout(res, delay + Math.random() * (delay / 3)));
    }
    if (p.kind === 'clip') { const rs = job.rows.clip; log(`통검클립: 있음 ${rs.filter(r => r.label === '있음').length} / 없음 ${rs.filter(r => r.label === '없음').length} / 확인필요 ${rs.filter(r => r.status === '확인필요').length}`); }
    await checkers.closeBrowser();
    if (job.rows[p.kind].length) { fs.mkdirSync(dir, { recursive: true }); files.push(writeCsv(dir, p.kind, job.rows[p.kind])); }
  }
  if (files.length) console.log('저장 폴더: ' + dir);
  job.running = false;
  send('done', { count: job.done });
}

/* ---- 비밀번호 ---- */
// 설정.json 의 webPassword. 없으면 6자리 숫자를 새로 만들어 저장한다.
function webPassword() {
  if (process.env.WEB_PASSWORD) return String(process.env.WEB_PASSWORD);
  const st = loadSettings();
  if (!st.webPassword) { st.webPassword = String(crypto.randomInt(100000, 1000000)); writeJson(SETTINGS, st); }
  return String(st.webPassword);
}
const tokens = new Set();
const fails = new Map(); // ip -> { n, until }
const ipOf = req => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
const cookieToken = req => ((req.headers.cookie || '').match(/(?:^|;\s*)nrc=([a-f0-9]{32})/) || [])[1];

/* ---- 엑셀 ---- */
async function buildXlsx(job) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const now = new Date().toLocaleString('ko-KR', { hour12: false });
  const sheet = (name, head, data, widths) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(head).font = { bold: true };
    data.forEach(r => ws.addRow(r));
    ws.columns.forEach((c, k) => { c.width = widths[k] || 14; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const R = job.rows;
  if (R.place.length) sheet('플레이스', ['확인일시', '키워드', '결과', '순위', '이전', '변동', '내용', '부가정보', '비고', '검색주소'],
    R.place.map(r => [now, r.keyword, r.status, r.label, r.prev || '', r.change || '', r.detail, r.extra, r.note, r.url]), [20, 16, 9, 12, 16, 8, 40, 30, 50, 40]);
  if (R.search.length) {
    sheet('통검노출', ['확인일시', '키워드', '결과', '목록순위', '이전', '변동', '대표 글', '부가정보', '링크', '검색주소'],
      R.search.map(r => [now, r.keyword, r.status, r.label, r.prev || '', r.change || '', r.detail, r.extra, r.link, r.url]), [20, 16, 9, 20, 16, 8, 50, 36, 40, 40]);
    sheet('통검노출_상세', ['키워드', '목록순위', '구분', '자사/외부', '제목', '출처', '링크'],
      R.search.flatMap(r => (r.found || []).map(f => [r.keyword, f.rank, f.type, f.by, f.title, f.source, f.link])), [16, 9, 10, 12, 50, 20, 50]);
  }
  if (R.clip.length) sheet('통검클립', ['확인일시', '키워드', '통검 클립', '이전', '변동', '내 클립 포함', '비고', '검색주소'],
    R.clip.map(r => [now, r.keyword, r.label, r.prev || '', r.change || '', /내 클립/.test(r.detail) ? 'O' : '', r.status === '확인필요' ? r.note : '', r.url]), [20, 18, 10, 16, 8, 12, 30, 40]);
  return wb.xlsx.writeBuffer();
}

/* ---- HTTP ---- */
function body(req) { return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }
const splitKw = t => [...new Set(String(t || '').split(/\r?\n|\t/).map(s => s.trim()).filter(Boolean))];
const MAX_KEYWORDS = 500;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const json = (v, code = 200, h = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...h }); res.end(JSON.stringify(v)); };
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
  }
  if (u.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/api/login' && req.method === 'POST') {
    const ip = ipOf(req); const f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return json({ error: '비밀번호를 여러 번 틀려 10분간 잠겼습니다.' }, 429);
    const b = await body(req);
    if (String(b.password || '').trim() !== webPassword()) {
      f.n++; if (f.n >= 8) { f.until = Date.now() + 600000; f.n = 0; } fails.set(ip, f);
      return json({ error: '비밀번호가 맞지 않습니다.' }, 401);
    }
    fails.delete(ip);
    const t = crypto.randomBytes(16).toString('hex'); tokens.add(t);
    return json({ ok: true }, 200, { 'set-cookie': `nrc=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
  }
  const token = cookieToken(req);
  if (!token || !tokens.has(token)) return json({ error: 'login' }, 401);
  const S = sess(token);
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': ok\n\n');
    S.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { S.clients.delete(res); clearInterval(ping); });
    if (S.job) res.write(`event: state\ndata: ${JSON.stringify(S.job)}\n\n`);
    return;
  }
  // 무료 링크(터널) 구간에서는 실시간 전송(SSE)이 막혀서, 화면이 이 주소를 주기적으로 물어온다.
  if (u.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(S.job || null));
  }
  if (u.pathname === '/api/settings' && req.method === 'GET') { const st = loadSettings(); delete st.webPassword; return json(st); }
  if (u.pathname === '/api/settings' && req.method === 'POST') { const b = await body(req); b.webPassword = webPassword(); writeJson(SETTINGS, b); return json({ ok: true }); }
  if (u.pathname === '/api/run' && req.method === 'POST') {
    if (S.job && S.job.running) return json({ error: '이미 검사 중입니다.' }, 409);
    const b = await body(req);
    const lists = { place: splitKw(b.place), search: splitKw(b.search), clip: splitKw(b.clip) };
    const n = lists.place.length + lists.search.length + lists.clip.length;
    if (!n) return json({ error: '키워드를 한 칸 이상 입력해 주세요.' }, 400);
    if (n > MAX_KEYWORDS) return json({ error: `한 번에 ${MAX_KEYWORDS}개까지 넣을 수 있습니다(지금 ${n}개).` }, 400);
    if ((lists.place.length || lists.search.length) && !String(b.ids || '').trim()) return json({ error: '플레이스·통검노출은 업체 식별어가 필요합니다.' }, 400);
    const mine = S.job = { vendor: b.vendor || '업체', running: true, stop: false, rows: { place: [], search: [], clip: [] }, log: [], total: n, done: 0 };
    if (waiting) { sendTo(S, 'start', { vendor: mine.vendor, total: n }); logTo(S, `다른 사람 검사가 끝나면 시작합니다(앞에 ${waiting}건).`); }
    waiting++;
    queue = queue.then(() => { waiting--; return mine.stop ? null : runAll(S, mine.vendor, b.ids || '', lists, b.opt || {}); })
      .catch(e => { logTo(S, '오류: ' + e.message); })
      .finally(() => { if (mine.running) { mine.running = false; sendTo(S, 'done', { count: mine.done }); } });
    return json({ ok: true });
  }
  if (u.pathname === '/api/stop' && req.method === 'POST') { if (S.job) S.job.stop = true; return json({ ok: true }); }
  if (u.pathname === '/api/export') {
    if (!S.job || !S.job.done) return json({ error: '받을 결과가 없습니다.' }, 404);
    const buf = await buildXlsx(S.job);
    const name = encodeURIComponent(`네이버순위_${safe(S.job.vendor)}_${stamp()}.xlsx`);
    res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename*=UTF-8''${name}` });
    return res.end(Buffer.from(buf));
  }
  res.writeHead(404); res.end('not found');
});
setInterval(() => { for (const [t, x] of sessions) if (Date.now() - x.last > 6 * 3600e3 && !(x.job && x.job.running)) sessions.delete(t); }, 3600e3);

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log('이미 실행 중입니다. 브라우저에서 엽니다.'); if (process.platform === 'win32') exec(`start "" http://localhost:${PORT}`); setTimeout(() => process.exit(0), 500); }
  else throw e;
});
server.listen(PORT, HOST, () => {
  console.log(`네이버 순위체커 실행 중: http://localhost:${PORT}  (이 창을 닫으면 종료됩니다)`);
  if (process.env.WEB_PASSWORD) console.log('접속 비밀번호: 환경변수 WEB_PASSWORD 사용');
  else console.log(`접속 비밀번호: ${webPassword()}  (설정.json 의 webPassword 에서 바꿀 수 있음)`);
  if (!SERVER_MODE && process.platform === 'win32' && !process.argv.includes('--no-open')) exec(`start "" http://localhost:${PORT}`);
});
