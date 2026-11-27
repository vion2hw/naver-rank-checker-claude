// 설정(업체 목록)·순위 기록 보관소.
// - 기본: 프로그램 폴더(DATA_DIR)의 설정.json / 결과\순위기록.json 파일.
// - 환경변수 GH_TOKEN + GH_REPO(예: vion2hw/naver-rank-checker-claude)가 있으면 GitHub 저장소의
//   'data' 가지(branch)에 settings.json / history.json 으로 보관한다. Render 무료 서버처럼 재시작 때
//   파일이 지워지는 곳에서도 기록이 남는다. data 가지는 자동 배포 대상(main)이 아니라서 저장해도 재배포되지 않는다.
// 읽기는 메모리에서 바로, 쓰기는 메모리에 반영한 뒤 몇 초 모아서 한 번에 저장한다.
const fs = require('fs');
const path = require('path');

const DATA = process.env.DATA_DIR || __dirname;
const LOCAL = { settings: path.join(DATA, '설정.json'), history: path.join(DATA, '결과', '순위기록.json') };
const GH = process.env.GH_TOKEN && process.env.GH_REPO ? { token: process.env.GH_TOKEN, repo: process.env.GH_REPO, branch: process.env.GH_BRANCH || 'data' } : null;

const mem = { settings: null, history: {} };
const sha = { settings: null, history: null };
const dirty = new Set();
let timer = null, flushing = Promise.resolve();

async function gh(method, url, body) {
  const r = await fetch('https://api.github.com' + url, {
    method,
    headers: { authorization: 'Bearer ' + GH.token, accept: 'application/vnd.github+json', 'user-agent': 'naver-rank-checker', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j };
}
async function ensureBranch() {
  const b = await gh('GET', `/repos/${GH.repo}/git/ref/heads/${GH.branch}`);
  if (b.status === 200) return;
  const main = await gh('GET', `/repos/${GH.repo}/git/ref/heads/main`);
  if (main.status !== 200) throw new Error('GitHub 저장소를 읽지 못했습니다(토큰 권한 확인): ' + main.status);
  const c = await gh('POST', `/repos/${GH.repo}/git/refs`, { ref: `refs/heads/${GH.branch}`, sha: main.json.object.sha });
  if (c.status !== 201) throw new Error('data 가지를 만들지 못했습니다: ' + c.status);
}
async function ghRead(name) {
  const r = await gh('GET', `/repos/${GH.repo}/contents/${name}.json?ref=${GH.branch}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`GitHub ${name} 읽기 실패: ${r.status}`);
  sha[name] = r.json.sha;
  return JSON.parse(Buffer.from(r.json.content, 'base64').toString('utf8'));
}
async function ghWrite(name, obj) {
  const content = Buffer.from(JSON.stringify(obj, null, 1), 'utf8').toString('base64');
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await gh('PUT', `/repos/${GH.repo}/contents/${name}.json`, { message: `${name} 갱신`, content, branch: GH.branch, ...(sha[name] ? { sha: sha[name] } : {}) });
    if (r.status === 200 || r.status === 201) { sha[name] = r.json.content.sha; return; }
    if (r.status === 409 || r.status === 422) { await ghRead(name); continue; } // 다른 곳에서 바뀌었으면 최신 sha 로 다시
    throw new Error(`GitHub ${name} 저장 실패: ${r.status}`);
  }
}

function readLocal(file, d) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return d; } }
function writeLocal(file, v) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 2), 'utf8'); }

async function init(defaultSettings) {
  if (GH) {
    try {
      await ensureBranch();
      mem.settings = await ghRead('settings');
      mem.history = (await ghRead('history')) || {};
      console.log(`기록 보관: GitHub ${GH.repo} (${GH.branch} 가지)`);
    } catch (e) {
      console.log('[경고] GitHub 보관소를 쓰지 못해 서버 파일에 임시 저장합니다: ' + e.message);
      GH.failed = true;
    }
  }
  if (!GH || GH.failed) {
    mem.settings = readLocal(LOCAL.settings, null);
    mem.history = readLocal(LOCAL.history, {});
  }
  if (!mem.settings) { mem.settings = JSON.parse(JSON.stringify(defaultSettings)); dirty.add('settings'); schedule(); }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(flush, 3000);
}
function flush() {
  const names = [...dirty]; dirty.clear();
  flushing = flushing.then(async () => {
    for (const n of names) {
      const obj = mem[n];
      try {
        if (GH && !GH.failed) await ghWrite(n, obj);
        else writeLocal(LOCAL[n], obj);
      } catch (e) { console.log('[저장 실패] ' + n + ': ' + e.message); try { writeLocal(LOCAL[n], obj); } catch {} }
    }
  });
  return flushing;
}

module.exports = {
  init,
  mode: () => (GH && !GH.failed ? 'github' : 'file'),
  getSettings: () => JSON.parse(JSON.stringify(mem.settings)),
  setSettings: v => { mem.settings = JSON.parse(JSON.stringify(v)); dirty.add('settings'); schedule(); },
  getHistory: () => mem.history,
  touchHistory: () => { dirty.add('history'); schedule(); },
  flush,
};
