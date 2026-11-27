// 오늘의 추천 키워드: 키워드마다 노출 난이도·외부카페 적합도·업체 적합성·필요도를 점수로 매기고 추천 채널을 정한다.
// 채널 힘(평균): 외부블(건바이) > 외부블(체험) > 외부카페 > 공식 블로그 — 사용자 기준(2026-11-27). 실제 성과로 보정하기 전 기본값.
// 검색량: 환경변수 NAVER_AD_API_KEY / NAVER_AD_SECRET / NAVER_AD_CUSTOMER_ID 가 있으면 네이버 검색광고 키워드도구에서 받는다.
const crypto = require('crypto');
const checkers = require('./checkers.cjs');
const { analyzePost } = require('./guide.cjs');
const { parseList } = require('./recommend.cjs');

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');
const clamp = v => Math.max(0, Math.min(100, Math.round(v)));

/* ---- 검색광고 키워드도구 ---- */
const AD = process.env.NAVER_AD_API_KEY && process.env.NAVER_AD_SECRET && process.env.NAVER_AD_CUSTOMER_ID
  ? { key: process.env.NAVER_AD_API_KEY, secret: process.env.NAVER_AD_SECRET, customer: process.env.NAVER_AD_CUSTOMER_ID } : null;
const num = v => (typeof v === 'number' ? v : /</.test(String(v)) ? 5 : +String(v).replace(/[^\d]/g, '') || 0);
async function adKeywords(keyword) {
  if (!AD) return null;
  const ts = String(Date.now()), uri = '/keywordstool';
  const sig = crypto.createHmac('sha256', AD.secret).update(`${ts}.GET.${uri}`).digest('base64');
  const url = 'https://api.searchad.naver.com' + uri + '?showDetail=1&hintKeywords=' + encodeURIComponent(norm(keyword));
  const r = await fetch(url, { headers: { 'X-Timestamp': ts, 'X-API-KEY': AD.key, 'X-Customer': AD.customer, 'X-Signature': sig }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { error: 'HTTP ' + r.status };
  const j = await r.json();
  const list = (j.keywordList || []).map(k => ({ keyword: k.relKeyword, pc: num(k.monthlyPcQcCnt), mo: num(k.monthlyMobileQcCnt), comp: k.compIdx || '' }));
  const self = list.find(k => norm(k.keyword) === norm(keyword));
  return { self: self ? { ...self, total: self.pc + self.mo } : null, related: list.slice(0, 40).map(k => ({ ...k, total: k.pc + k.mo })) };
}

/* ---- 업체 단어(지역어·진료어) ---- */
// 업체 설정에 areas/topics 가 없으면 키워드 칸에서 뽑는다: 앞 2~3글자(동·구·시로 끝나면 3글자)를 지역어로, 나머지를 진료어로.
function vendorWords(v) {
  const kws = parseList(v.search).map(k => k.keyword.replace(/\s+/g, ''));
  const areas = new Set(String(v.areas || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean));
  const topics = new Set(String(v.topics || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean));
  if (!areas.size || !topics.size) for (const k of kws) {
    const a = /^[가-힣]{2}[동구시읍면]/.test(k) ? k.slice(0, 3) : k.slice(0, 2);
    if (!v.areas) areas.add(a);
    if (!v.topics && k.length > a.length) topics.add(k.slice(a.length));
  }
  return { areas: [...areas], topics: [...topics], kws };
}
const GENERIC = ['가격', '비용', '추천', '후기', '잘하는곳', '수면', '뼈이식', '전체', '틀니', '통증', '기간', '과정', '종류', '비교', '보험', '야간', '주말', '어린이', '소아', '교정', '투명', '성인', '잇몸', '신경', '충치', '사랑니', '발치', '스케일링', '임플란트', '치아', '치과', '상담', '병원', '어디', '잘하는', '괜찮은', '근처'];
// 다른 업체 이름이 섞인 키워드는 후보에서 뺀다: 낱말 중 업체 키워드·지역어·일반어로 설명되지 않는 부분이 2글자 이상 남으면 상호로 본다.
function isForeignBrand(keyword, words) {
  const pool = norm(words.kws.join(' ') + ' ' + words.areas.join(' ') + ' ' + words.topics.join(' '));
  return String(keyword).split(/\s+/).some(t => {
    const n = norm(t); if (!n || pool.includes(n)) return false;
    let rest = n; for (const a of [...words.areas, ...words.topics, ...GENERIC]) rest = rest.split(norm(a)).join('');
    rest = rest.replace(/[0-9]/g, '').replace(/^[시동구읍면군]/, ''); // 청주시치과의 '시' 같은 행정구역 글자는 허용
    // 치과·병원·의원으로 끝나는 낱말에 설명 안 되는 글자가 한 글자라도 남으면 상호(예: 청주웰치과)
    return rest.length >= 2 || (rest.length >= 1 && /(치과|병원|의원|클리닉)$/.test(n));
  });
}

const QUESTION = /추천|어디|후기|잘하는|괜찮은|비용|가격|비교|싼곳|근처|어때/;
const PRICE_COMP = /싼곳|최저|이벤트|할인|\d+\s*만\s*원|\d+만원|무료/;

/* ---- 자사 블로그 최근 글 제목(최근에 같은 주제로 썼는지) ---- */
const rssCache = new Map();
async function recentTitles(ids) {
  for (const id of ids.filter(x => /^[a-z0-9_-]{4,}$/i.test(x) && !/^\d+$/.test(x))) {
    const c = rssCache.get(id); if (c && Date.now() - c.at < 600e3) return c.items;
    try {
      const r = await fetch(`https://rss.blog.naver.com/${id}.xml`, { signal: AbortSignal.timeout(10000) }); if (!r.ok) continue;
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({ title: ((m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '').trim(), date: new Date(((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim()) }));
      rssCache.set(id, { at: Date.now(), items }); return items;
    } catch {}
  }
  return [];
}

// 키워드 하나 분석. vendor: 저장된 업체 설정, history: 순위 기록
async function analyzeKeyword(keyword, vendor, history) {
  const words = vendorWords(vendor);
  const ids = String(vendor.ids || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
  const imp = parseList(vendor.search).find(k => norm(k.keyword) === norm(keyword));
  const s = await checkers.checkSearch(keyword, ids, { interactive: false });
  await checkers.closeBrowser();
  if (s.status === '확인필요') return { keyword, error: s.note || '통검을 읽지 못함' };
  const top = (s.list || []).slice(0, 10);
  const cnt = t => top.filter(x => x.type === t).length;
  // 상위 블로그 글 발행일(최대 4개)로 최신성 판단
  const ages = [];
  for (const it of top.filter(x => x.type === '블로그').slice(0, 4)) { const p = await analyzePost(it, keyword); if (p.analyzed && p.ageDays != null) ages.push(p.ageDays); }
  ages.sort((a, b) => a - b); const medAge = ages.length ? ages[Math.floor(ages.length / 2)] : null;
  let ad = null; try { ad = await adKeywords(keyword); } catch {}
  const vol = ad && ad.self ? ad.self.total : null;
  const own = (s.found || []).filter(f => f.by === '자사 채널').map(f => f.rank);
  const ownBest = own.length ? Math.min(...own) : null;
  const ext = (s.found || []).filter(f => f.by !== '자사 채널').map(f => f.rank);

  // 노출 난이도(높을수록 어려움)
  let diff = 40 + cnt('웹사이트') * 8;
  if (medAge != null) diff += medAge > 90 ? 20 : medAge > 30 ? 10 : medAge <= 7 ? -15 : medAge <= 14 ? -8 : 0;
  if (vol != null) diff += vol > 5000 ? 15 : vol > 1000 ? 8 : vol < 200 ? -10 : 0;
  if (ad && ad.self && ad.self.comp === '높음') diff += 5;
  diff = clamp(diff);
  // 외부카페 적합도
  const cafe = clamp(cnt('카페') * 15 + (QUESTION.test(keyword) ? 30 : 0));
  // 업체 적합성
  const banned = String(vendor.banned || '').split(/\r?\n/).map(l => l.split('|')[0].trim()).filter(Boolean);
  const reasons = [];
  let fit = 20 + (words.areas.some(a => norm(keyword).includes(norm(a))) ? 40 : 0) + (words.topics.some(t => norm(keyword).includes(norm(t))) ? 40 : 0);
  if (banned.some(b => norm(keyword).includes(norm(b)))) { fit = 0; reasons.push('업체 금지어 포함'); }
  if (isForeignBrand(keyword, words)) { fit = 0; reasons.push('다른 업체 이름 포함'); }
  if (PRICE_COMP.test(keyword)) { fit -= 30; reasons.push('가격 경쟁·할인 의도라 조심'); }
  fit = clamp(fit);
  // 필요도
  let need = ownBest == null ? 60 : ownBest <= 3 ? 10 : ownBest <= 10 ? 30 : 45;
  const hist = history[`search|${vendor.name}|${keyword}`] || [];
  const prevExposed = hist.slice(0, -1).some(e => e.rank);
  if (ownBest == null && prevExposed) { need += 30; reasons.push('예전엔 노출됐는데 지금 빠짐'); }
  if (imp) need += imp.at * 10 + Math.max(0, 10 - imp.order);
  const recent = (await recentTitles(ids)).filter(x => norm(x.title).includes(norm(keyword)) && Date.now() - x.date < 14 * 86400e3);
  if (recent.length) { need -= 25; reasons.push('최근 2주 안에 자사 블로그에 같은 키워드 글 있음'); }
  if (vol != null) need += Math.min(15, Math.round(Math.log10(Math.max(vol, 1)) * 4));
  need = clamp(need);
  // 채널
  let channel;
  if (ownBest != null && ownBest <= 5) channel = '유지(발행 불필요)';
  else if (cafe >= 60) channel = '외부카페';
  else if (diff >= 65) channel = '외부블(건바이)';
  else if (diff >= 40) channel = '외부블(체험)';
  else channel = '공식 블로그';
  const level = diff >= 65 ? '상' : diff >= 40 ? '중' : '하';
  const volScore = vol == null ? 50 : clamp(Math.log10(Math.max(vol, 1)) * 25);
  const score = fit < 40 || channel.startsWith('유지') ? 0 : Math.round(need * 0.5 + fit * 0.3 + volScore * 0.2);
  if (ownBest != null) reasons.push(`자사 ${ownBest}위`); else reasons.push('자사 노출 없음');
  if (ext.length) reasons.push(`외부 글 ${Math.min(...ext)}위`);
  if (medAge != null) reasons.push(`상위 블로그 가운데 발행 ${medAge}일 전`);
  reasons.push(`상위10: 블로그 ${cnt('블로그')} · 카페 ${cnt('카페')} · 웹 ${cnt('웹사이트')}`);
  return {
    keyword, important: imp ? imp.at : 0, volume: vol, comp: ad && ad.self ? ad.self.comp : '', adError: ad && ad.error ? ad.error : '',
    difficulty: diff, level, cafe, fit, need, channel, score, ownBest, reasons, url: s.url,
    related: (s.related || []).concat(ad && ad.related ? ad.related.map(k => k.keyword) : []),
  };
}

// 관련 키워드 가운데 업체에 맞는 후보만 고르기(지역어 포함, 다른 업체 이름 제외)
function pickCandidates(list, vendor, already) {
  const words = vendorWords(vendor); const seen = new Set(already.map(norm)); const out = [];
  for (const k of list) {
    const n = norm(k); if (!n || seen.has(n)) continue; seen.add(n);
    if (!words.areas.some(a => n.includes(norm(a)))) continue;
    if (isForeignBrand(k, words)) continue;
    out.push(k);
  }
  return out;
}

// 검색광고 키 점검: 고정 키워드 하나로 호출해 성공 여부와 HTTP 상태만 돌려준다
async function adCheck() {
  const r = await adKeywords('임플란트');
  if (!r) return { ok: false, status: 'no-key' };
  if (r.error) return { ok: false, status: r.error };
  return { ok: true, status: 'ok', sample: !!(r.related && r.related.length) };
}

module.exports = { analyzeKeyword, pickCandidates, vendorWords, isForeignBrand, adEnabled: () => !!AD, adCheck };
