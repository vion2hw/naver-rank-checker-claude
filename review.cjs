// 원고 검수기: 의료·돌봄 광고 위험 표현, 업체별 금지어, 키워드 사용, 문장 반복, 자사 블로그 기존 글과의 유사도를 점검한다.
// 규칙: 일반적으로 알려진 의료광고 금지 유형 + 공통 원고 기준. 업체별 금지어는 사이트의 업체 설정(검수 금지어)에서 넣는다.
// 법률 검토를 대신하지 않는다. 문맥에 따라 괜찮을 수 있는 것은 '주의'·'확인'으로 표시해 사람이 판단하게 한다.
const MO_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

// 업체 이름 → 업종 묶음(의료·돌봄·일반)
function vendorKind(name) {
  const n = String(name || '');
  if (/치과|의원|병원|한의원|피부과|성형|클리닉/.test(n)) return { kind: 'medical' };
  if (/요양|주간보호|실버|돌봄/.test(n)) return { kind: 'care' };
  return { kind: 'general' };
}

// [수준, 이름, 정규식, 고칠 방향, 적용 업종(없으면 전체)]
// 위험: 빼야 할 가능성이 큼 / 주의: 문맥 따라 다듬기 / 확인: 사실 근거 확인 필요
const RULES = [
  ['위험', '"잘하는 곳" 표현', /잘\s*하는\s*(곳|치과|병원|데)|잘하는곳/g, '진료 과정·확인할 점 중심으로 바꾸기', ['medical', 'care']],
  ['위험', '효과·결과 보장', /(효과|결과)\s*(를|가)?\s*(보장|확실)|100\s*%|백\s*퍼센트|완벽(하게|한|히)?|확실(하게|히)\s*(좋아|개선|해결)/g, '결과는 개인차가 있음을 밝히고 보장 표현 빼기', ['medical', 'care']],
  ['위험', '무통·통증 없음 단정', /무통|통증\s*(이|은)?\s*(전혀\s*)?없(는|이|어요|습니다|다)|안\s*아픈|아프지\s*않(은|아요|습니다)/g, '"통증을 줄이기 위해 ~을 확인합니다"처럼 단정하지 않기', ['medical']],
  ['위험', '안전성 단정', /부작용\s*(이|은)?\s*(전혀\s*)?없|100\s*%\s*안전|완전히\s*안전|절대\s*안전/g, '부작용·개인차 가능성을 인정하는 표현으로', ['medical', 'care']],
  ['위험', '성공 보장', /성공률|실패\s*(가|는)?\s*없|반드시\s*성공/g, '성공률·실패 없음 같은 수치·단정 빼기', ['medical']],
  ['위험', '완치·회복 단정', /완치|영구(적)?(으로|인)?|평생\s*(사용|유지|걱정)|치매\s*예방|기능\s*회복(을|이)?\s*(보장|시켜|됩니다)/g, '완치·영구·예방 단정 대신 관리·도움 표현으로', ['medical', 'care']],
  ['위험', '최상급·비교 우위', /최고(의)?|최상(의)?|최초|유일(한)?|독보적|넘버\s*원|no\.?\s*1|1\s*위|가장\s*(잘|좋|뛰어|많)|(다른|타)\s*(치과|병원|곳)\s*(보다|과\s*달리)/gi, '근거 없는 비교·최상급 빼기', ['medical', 'care']],
  ['위험', '할인·이벤트·무료', /할인|이벤트|무료|공짜|특가|파격|최저가|저렴한\s*가격|가격\s*인하/g, '요청 없는 할인·이벤트·혜택은 쓰지 않기(의료는 특히 주의)', null],
  ['위험', '치료 전후 비교', /전\s*후\s*(사진|비교)|비포\s*애프터|before\s*&?\s*after/gi, '전후 비교는 의료광고 금지 유형. 빼기', ['medical']],
  ['위험', '상위노출·매출 보장', /상위\s*노출\s*(보장|확실)|매출\s*(상승|증가)\s*(보장|확실)|무조건\s*(노출|매출)/g, '특정 결과·상위노출 보장 표현 빼기', null],
  ['위험', '불안 자극', /방치하면\s*(큰일|위험)|(지금|당장)\s*안\s*하면|늦으면\s*(큰일|후회)/g, '과도한 불안 자극 지양', ['medical', 'care']],
  ['주의', '"검증된" 근거 확인', /검증(된|받은)/g, '근거가 없으면 빼기', ['medical', 'care']],
  ['주의', '"반드시" 단정', /반드시|무조건|꼭\s*해야/g, '권유·확인 표현으로 부드럽게', ['medical', 'care']],
  ['주의', '치료 경험담·후기', /(치료|시술|수술|환자(분)?)\s*후기|후기\s*(를|로)\s*(보|알)|만족도\s*\d/g, '의료 치료경험담은 광고 금지 유형. 실제 제공 후기 근거 안에서만', ['medical']],
  ['주의', '전문병원·전문 표기', /전문\s*병원|전문\s*치과|전문\s*클리닉/g, '공식 지정이 아니면 "전문병원" 표기 금지. 사실 확인', ['medical']],
  ['확인', '의료진·장비·건수 정보', /전문의|박사|원장\s*\S+\s*(졸업|수료)|\d+\s*(건|케이스|명)\s*(이상)?\s*(시술|치료|수술|진행)|장비\s*\S*\s*(모델|도입)/g, '실명·학력·전문의·시술 건수·장비 모델은 자료 확인 없이 쓰지 않기', ['medical']],
  ['확인', '가격·금액', /\d[\d,]*\s*(만\s*)?원|\d+\s*만원/g, '정확한 가격은 최신 근거 없이 쓰지 않기. "진단·범위에 따라 달라짐" 설명', ['medical', 'care']],
  ['확인', '진료 요일·시간', /(월|화|수|목|금|토|일)(요일)?\s*(오전|오후)?\s*\d{1,2}\s*(시|:\d{2})|야간\s*진료\s*\d|\d{1,2}\s*시\s*(까지|부터)/g, '요일·시간은 확인된 자료로만', ['medical', 'care']],
];

// 업체별 금지어: 설정 칸에 "표현 | 고칠 방향" 한 줄씩. 표현은 글자 그대로(띄어쓰기 무시) 찾는다.
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, ch => '\\' + ch);
function customRules(banned) {
  return String(banned || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const [w, tip] = l.split('|').map(x => x.trim());
    if (!w) return null;
    const re = new RegExp(escRe(w).replace(/\s+/g, '\\s*'), 'gi');
    return ['위험', '업체 금지어: ' + w, re, tip || '업체 설정에 금지어로 등록된 표현', null];
  }).filter(Boolean);
}

function sentences(text) {
  return String(text).split(/(?<=[.!?。！？])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 1);
}
function sentenceAt(text, idx) {
  const start = Math.max(text.lastIndexOf('\n', idx), text.lastIndexOf('. ', idx), text.lastIndexOf('? ', idx), text.lastIndexOf('! ', idx));
  let end = text.length;
  for (const d of ['\n', '. ', '? ', '! ']) { const j = text.indexOf(d, idx); if (j >= 0 && j < end) end = j + 1; }
  return text.slice(start + 1, end).trim().slice(0, 160);
}

function checkRules(text, vk, banned) {
  const out = [];
  for (const [level, name, re, tip, scope] of [...RULES, ...customRules(banned)]) {
    if (Array.isArray(scope) && !scope.includes(vk.kind)) continue;
    re.lastIndex = 0; let m; const seen = new Set();
    while ((m = re.exec(text))) {
      const sent = sentenceAt(text, m.index);
      const key = name + '|' + sent;
      if (!seen.has(key)) { seen.add(key); out.push({ level, rule: name, match: m[0], sentence: sent, tip }); }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  const order = { 위험: 0, 주의: 1, 확인: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

function countKw(text, keyword) {
  const t = norm(text), k = norm(keyword); if (!k) return 0;
  let n = 0, i = 0; while ((i = t.indexOf(k, i)) >= 0) { n++; i += k.length; } return n;
}

// 같은 원고 안에서 반복된 문장(15자 이상)
function repeats(text) {
  const c = {}; for (const s of sentences(text)) { const k = norm(s); if (k.length >= 15) { c[k] = c[k] || { s, n: 0 }; c[k].n++; } }
  return Object.values(c).filter(x => x.n >= 2).map(x => ({ sentence: x.s.slice(0, 120), count: x.n }));
}

/* ---- 자사 블로그 기존 글과 유사도 ---- */
const grams = (s, n = 5) => { const t = norm(s).replace(/[^\p{L}\p{N}]/gu, ''); const g = new Set(); for (let i = 0; i + n <= t.length; i++) g.add(t.slice(i, i + n)); return g; };
function stripHtml(h) { return String(h).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' '); }

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': MO_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
// 식별어 중 블로그 아이디처럼 보이는 것을 RSS로 확인해 최근 글 목록을 얻는다
async function recentPosts(ids, limit) {
  for (const id of ids.filter(x => /^[a-z0-9_-]{4,}$/i.test(x) && !/^\d+$/.test(x))) {
    try {
      const xml = await fetchText(`https://rss.blog.naver.com/${id}.xml`);
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
        title: stripHtml((m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '').trim(),
        link: ((m[1].match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1] || '').trim(),
        date: ((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim(),
      })).filter(x => x.link);
      if (items.length) return { blogId: id, items: items.slice(0, limit) };
    } catch {}
  }
  return null;
}
async function similarity(text, ids, limit = 15) {
  const rp = await recentPosts(ids, limit);
  if (!rp) return { blogId: '', checked: 0, list: [], note: '식별어에서 네이버 블로그 아이디를 찾지 못해 유사도는 건너뜀' };
  const mine = grams(text); const mySents = sentences(text).filter(s => norm(s).length >= 25);
  const list = [];
  for (const it of rp.items) {
    const m = it.link.match(/blog\.naver\.com\/([\w-]+)\/(\d+)/) || it.link.match(/blogId=([\w-]+).*?logNo=(\d+)/);
    if (!m) continue;
    let body = '';
    try {
      const h = await fetchText(`https://m.blog.naver.com/${m[1]}/${m[2]}`);
      const i = h.indexOf('se-main-container'); if (i < 0) continue;
      body = [...h.slice(i).matchAll(/<p class="se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g)].map(x => stripHtml(x[1])).join('\n');
    } catch { continue; }
    const g = grams(body); if (!g.size || !mine.size) continue;
    let hit = 0; for (const x of mine) if (g.has(x)) hit++;
    const score = Math.round(hit / mine.size * 100); // 내 원고 중 이 글과 겹치는 비율
    const nb = norm(body);
    const same = mySents.filter(s => nb.includes(norm(s))).map(s => s.slice(0, 100)).slice(0, 5);
    list.push({ title: it.title, link: it.link, date: it.date ? new Date(it.date).toISOString().slice(0, 10) : '', score, same });
  }
  list.sort((a, b) => b.score - a.score);
  return { blogId: rp.blogId, checked: list.length, list: list.slice(0, 8) };
}

async function review({ vendor = '', ids = '', banned = '', keyword = '', title = '', text = '', guide = null, skipSimilar = false }) {
  const vk = vendorKind(vendor);
  const full = (title ? title + '\n' : '') + text;
  const issues = checkRules(full, vk, banned);
  const chars = String(text).replace(/\s/g, '').length;
  const kwN = countKw(text, keyword);
  const kw = keyword ? {
    keyword, count: kwN, per1000: chars ? Math.round(kwN / chars * 1000 * 10) / 10 : 0,
    inTitle: norm(title).includes(norm(keyword)), titleFront: norm(title).startsWith(norm(keyword)), titleLen: String(title).length,
  } : null;
  const notes = [];
  if (kw) {
    if (title && !kw.inTitle) notes.push({ level: '주의', text: `제목에 "${keyword}"가 없습니다` });
    if (kw.count === 0) notes.push({ level: '주의', text: `본문에 "${keyword}"가 한 번도 없습니다` });
    if (kw.per1000 > 6) notes.push({ level: '주의', text: `키워드가 많습니다(1,000자당 ${kw.per1000}회) — 억지 반복은 피하기` });
    if (guide && guide.kwCount && kw.count > guide.kwCount.max + 3) notes.push({ level: '주의', text: `상위 글(${guide.kwCount.min}~${guide.kwCount.max}회)보다 키워드가 많습니다(${kw.count}회)` });
  }
  if (guide && guide.chars) {
    if (chars < guide.chars.min * 0.8) notes.push({ level: '확인', text: `본문이 상위 글보다 짧습니다(${chars.toLocaleString()}자, 상위 ${guide.chars.min.toLocaleString()}~${guide.chars.max.toLocaleString()}자)` });
    if (chars > guide.chars.max * 1.5) notes.push({ level: '확인', text: `본문이 상위 글보다 많이 깁니다(${chars.toLocaleString()}자)` });
  }
  repeats(full).forEach(r => notes.push({ level: '주의', text: `같은 문장이 ${r.count}번 반복: "${r.sentence}"` }));
  const idList = String(ids).split(/[,\n]/).map(x => x.trim()).filter(Boolean);
  const similar = skipSimilar ? null : await similarity(full, idList);
  if (similar) for (const s of similar.list) {
    if (s.score >= 50 || s.same.length >= 3) notes.push({ level: '위험', text: `기존 글과 많이 겹칩니다(${s.score}%, 같은 문장 ${s.same.length}개): ${s.title}` });
    else if (s.score >= 30 || s.same.length >= 1) notes.push({ level: '주의', text: `기존 글과 일부 겹칩니다(${s.score}%, 같은 문장 ${s.same.length}개): ${s.title}` });
  }
  const cnt = l => issues.filter(i => i.level === l).length + notes.filter(n => n.level === l).length;
  const verdict = cnt('위험') ? '미달' : (cnt('주의') || cnt('확인')) ? '사람 판단 필요' : '통과';
  return { vendorKind: vk.kind, chars, kw, issues, notes, similar, counts: { 위험: cnt('위험'), 주의: cnt('주의'), 확인: cnt('확인') }, verdict };
}

module.exports = { review, checkRules, vendorKind, RULES };
