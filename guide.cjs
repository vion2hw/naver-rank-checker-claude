// 작성 가이드: 키워드의 통검 상위 글(웹·블로그·카페 목록)을 읽어 구조와 수치만 뽑고, "이렇게 쓰면 된다" 기준을 만든다.
// 다른 사람 글의 본문은 저장하거나 옮기지 않는다. 제목·글자 수·사진 수·소제목 수·키워드 횟수·발행일 같은 수치만 쓴다.
const checkers = require('./checkers.cjs');

const MO_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');
const ENT = { middot: '·', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', times: '×', bull: '•', rarr: '→', larr: '←' };
const decode = s => String(s || '').replace(/&(middot|hellip|lsquo|rsquo|ldquo|rdquo|ndash|mdash|times|bull|rarr|larr);/g, (m, k) => ENT[k]).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
const strip = h => decode(String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');

// 블로그 글 주소 → 모바일 글 주소
function blogUrl(link) {
  let m = String(link).match(/blog\.naver\.com\/([\w-]+)\/(\d{6,})/);
  if (m) return { id: m[1], no: m[2], url: `https://m.blog.naver.com/${m[1]}/${m[2]}` };
  m = String(link).match(/blogId=([\w-]+).*?logNo=(\d+)/);
  if (m) return { id: m[1], no: m[2], url: `https://m.blog.naver.com/${m[1]}/${m[2]}` };
  return null;
}

function parseDate(txt, now = new Date()) {
  const t = String(txt || '').trim();
  let m = t.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  if ((m = t.match(/(\d+)\s*분\s*전/))) return new Date(now - m[1] * 60e3);
  if ((m = t.match(/(\d+)\s*시간\s*전/))) return new Date(now - m[1] * 3600e3);
  if ((m = t.match(/(\d+)\s*일\s*전/))) return new Date(now - m[1] * 86400e3);
  if (/어제/.test(t)) return new Date(now - 86400e3);
  return null;
}

// 키워드가 본문에 몇 번 나오는지(띄어쓰기 무시)
function countKw(text, keyword) {
  const t = norm(text), k = norm(keyword);
  if (!k) return 0;
  let n = 0, i = 0;
  while ((i = t.indexOf(k, i)) >= 0) { n++; i += k.length; }
  return n;
}

async function analyzePost(item, keyword) {
  const b = blogUrl(item.link);
  const base = { rank: item.rank, type: item.type, title: item.title, link: item.link, source: item.source };
  if (!b) return { ...base, analyzed: false, note: item.type === '카페' ? '카페 글은 본문을 열 수 없어 제목만 봄' : '블로그가 아니라 제목만 봄' };
  let h;
  try {
    const r = await fetch(b.url, { headers: { 'User-Agent': MO_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ...base, analyzed: false, note: '글을 열지 못함(HTTP ' + r.status + ')' };
    h = await r.text();
  } catch (e) { return { ...base, analyzed: false, note: '글을 열지 못함' }; }
  const main = h.indexOf('se-main-container');
  if (main < 0) return { ...base, analyzed: false, note: '예전 편집기 글이라 구조를 읽지 못함' };
  const body = h.slice(main);
  const title = decode((h.match(/property="og:title" content="([^"]*)"/) || [])[1] || item.title);
  const dateTxt = strip((h.match(/class="blog_date"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
  const date = parseDate(dateTxt);
  const comps = {}; for (const m of body.matchAll(/class="se-component se-([a-zA-Z]+)/g)) comps[m[1]] = (comps[m[1]] || 0) + 1;
  // 본문 글자: 텍스트 문단만 모아 공백 빼고 센다
  const text = [...body.matchAll(/<p class="se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g)].map(m => strip(m[1])).join('\n');
  const chars = text.replace(/\s/g, '').length;
  // 소제목: 인용구 블록 + 큰 글씨(fs24 이상) 문단
  const bigHeads = [...body.matchAll(/se-fs-fs(2[4-9]|3\d|4\d)/g)].length;
  const headings = (comps.quotation || 0) + bigHeads;
  return {
    ...base, analyzed: true, title,
    date: date ? date.toISOString().slice(0, 10) : '', ageDays: date ? Math.max(0, Math.round((Date.now() - date) / 86400e3)) : null,
    chars, images: comps.image || 0, headings, videos: (comps.video || 0) + (comps.oembed || 0), map: !!(comps.placesMap || comps.map),
    kwCount: countKw(text, keyword), kwInTitle: norm(title).includes(norm(keyword)), kwTitleFront: norm(title).startsWith(norm(keyword)),
  };
}

const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return Math.round(s[lo] + (s[hi] - s[lo]) * (i - lo)); };
const pct = (n, d) => (d ? Math.round(n / d * 100) : 0);

// 제목에 자주 나온 낱말(키워드 자체·흔한 말 제외)
const STOP = new Set(['그리고', '하는', '있는', '대한', '위한', '이런', '어떻게', '무엇', '이유', '방법', '정리', '후기', '추천', '알아보기', '알아보세요', '알아봤어요', '알아보겠습니다', '있을까요', '할까요', '좋을까요', '까지', '부터', '에서', '에게', '으로', '하고']);
function titleWords(titles, keyword) {
  const k = norm(keyword); const c = {};
  for (const t of titles) {
    const seen = new Set();
    for (let w of String(t).split(/[\s,·|/()\[\]!?.:~"'“”‘’<>-]+/)) {
      // 조사만 떼고(치과·교정 같은 말 끝은 살림), 짧은 낱말은 그대로 둔다
      if (w.length >= 4) w = w.replace(/(은|는|을|를|으로|에서|까지|부터|이란|에게)$/, '');
      if (w.length < 2 || STOP.has(w) || norm(w) === k || k.includes(norm(w))) continue;
      if (seen.has(w)) continue; seen.add(w); c[w] = (c[w] || 0) + 1;
    }
  }
  return Object.entries(c).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, n]) => ({ word: w, count: n }));
}

async function buildGuide(keyword, targets = [], opt = {}) {
  const top = opt.top || 10;
  const s = await checkers.checkSearch(keyword, targets, { interactive: false });
  await checkers.closeBrowser();
  if (s.status === '확인필요') return { keyword, error: s.note || '통검을 읽지 못했습니다.' };
  const list = (s.list || []).slice(0, top);
  const posts = [];
  for (const it of list) posts.push(await analyzePost(it, keyword)); // 차례로(네이버에 부담 덜 주게)
  const a = posts.filter(p => p.analyzed);
  const col = k => a.map(p => p[k]).filter(v => v != null);
  const range = k => { const v = col(k); return v.length ? { min: q(v, 0.25), mid: q(v, 0.5), max: q(v, 0.75) } : null; };
  const titles = posts.map(p => p.title).filter(Boolean);
  const types = {}; posts.forEach(p => { types[p.type] = (types[p.type] || 0) + 1; });
  const st = {
    analyzed: a.length, total: posts.length, types,
    chars: range('chars'), images: range('images'), headings: range('headings'), kwCount: range('kwCount'), ageDays: range('ageDays'),
    kwInTitle: pct(posts.filter(p => norm(p.title).includes(norm(keyword))).length, titles.length),
    kwTitleFront: pct(posts.filter(p => norm(p.title).startsWith(norm(keyword))).length, titles.length),
    titleLen: q(titles.map(t => t.length), 0.5),
    withVideo: pct(a.filter(p => p.videos > 0).length, a.length), withMap: pct(a.filter(p => p.map).length, a.length),
    words: titleWords(titles, keyword),
  };
  // 사람이 읽는 권장 사항
  const tips = [];
  if (st.chars) tips.push(`본문 글자 수(공백 제외) ${st.chars.min.toLocaleString()}~${st.chars.max.toLocaleString()}자 (상위 글 가운데값 ${st.chars.mid.toLocaleString()}자)`);
  if (st.images) tips.push(`사진 ${st.images.min}~${st.images.max}장 (가운데값 ${st.images.mid}장)`);
  if (st.headings) tips.push(`소제목(인용구·큰 글씨) ${st.headings.min}~${st.headings.max}개`);
  if (st.kwCount) tips.push(`본문에 "${keyword}" ${st.kwCount.min}~${st.kwCount.max}회 (띄어쓰기 무시)`);
  tips.push(`제목에 키워드 넣기: 상위 글 ${st.kwInTitle}%가 넣음` + (st.kwTitleFront >= 30 ? `, ${st.kwTitleFront}%는 맨 앞에 둠` : ''));
  if (st.titleLen) tips.push(`제목 길이 ${st.titleLen}자 안팎`);
  if (st.withMap >= 40) tips.push(`지도(장소) 첨부: 상위 블로그 ${st.withMap}%가 넣음`);
  if (st.withVideo >= 40) tips.push(`영상 첨부: 상위 블로그 ${st.withVideo}%가 넣음`);
  if (st.ageDays) tips.push(st.ageDays.mid <= 30 ? `최근 글이 강함: 상위 블로그 글 절반이 ${st.ageDays.mid <= 1 ? '오늘·어제' : st.ageDays.mid + '일 이내'} 발행 → 재발행·새 글 효과가 큼` : `오래된 글도 버팀: 상위 블로그 글 가운데값 ${st.ageDays.mid}일 전 발행 → 내용 보강(수정)도 고려`);
  if (st.words.length) tips.push('제목에 자주 같이 쓰인 말: ' + st.words.slice(0, 8).map(w => w.word).join(', '));
  const own = (s.found || []).filter(f => f.by === '자사 채널').map(f => f.rank);
  return { keyword, checkedAt: new Date().toISOString().slice(0, 16).replace('T', ' '), url: s.url, own, stats: st, tips, posts };
}

module.exports = { buildGuide, analyzePost, parseDate, countKw };
