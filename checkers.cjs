// 네이버 순위체커 3종: 플레이스 순위 / 통합검색 노출 순위 / 클립탭 순위
// 실제 브라우저(설치된 Chrome 또는 Edge)를 모바일 화면으로 띄워, 로그인하지 않은 상태의 결과를 읽는다.
// 보안 확인(캡차)은 절대 자동으로 풀지 않는다. 뜨면 브라우저 창을 띄워 사용자가 직접 풀게 하고,
// 정해진 시간 안에 풀리지 않으면 '확인필요'로 기록한다.
const path = require('path');
const { chromium } = require('playwright-core');

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const PROFILE_DIR = path.join(process.env.DATA_DIR || __dirname, '브라우저프로필');

// 브라우저 후보: CHROME_PATH(직접 지정) → 설치된 Chrome → Edge → Playwright 번들 Chromium(리눅스 서버·Docker용).
// 서버(컨테이너)에서는 /dev/shm 이 작아서 --disable-dev-shm-usage, root 실행이라 --no-sandbox 가 필요하다.
// 리눅스 서버(무료 512MB 등)에서는 메모리를 아끼도록 가볍게 띄운다.
const SERVER_ARGS = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--no-zygote', '--renderer-process-limit=1', '--js-flags=--max-old-space-size=192'] : [];
function browserCandidates() {
  const list = [];
  if (process.env.CHROME_PATH) list.push({ executablePath: process.env.CHROME_PATH });
  list.push({ channel: 'chrome' }, { channel: 'msedge' }, {});
  return list;
}
async function launchBrowser(extra = {}) {
  let lastErr;
  for (const c of browserCandidates()) {
    try { return await chromium.launch({ ...c, headless: true, args: [...SERVER_ARGS, ...(extra.args || [])] }); }
    catch (e) { lastErr = e; }
  }
  throw new Error('브라우저를 실행하지 못했습니다: ' + (lastErr && lastErr.message));
}

let ctx = null, ctxHeaded = false;
async function getContext(headed = false) {
  if (ctx && (ctxHeaded || !headed)) return ctx;
  if (ctx) { try { await ctx.close(); } catch {} ctx = null; }
  let lastErr;
  for (const cand of browserCandidates()) {
    try {
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        ...cand, headless: !headed,
        userAgent: MOBILE_UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
        isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
        args: [...SERVER_ARGS, ...(headed ? ['--window-size=460,960'] : [])],
      });
      ctxHeaded = headed;
      return ctx;
    } catch (e) { lastErr = e; }
  }
  throw new Error('Chrome 또는 Edge를 실행하지 못했습니다(다른 체커 창이 열려 있으면 닫아 주세요): ' + (lastErr && lastErr.message));
}
let preferHeaded = false;
function setHeaded(v) { preferHeaded = !!v; }
async function newPage() {
  const c = await getContext(preferHeaded);
  const page = await c.newPage();
  page.setDefaultTimeout(30000);
  return page;
}
async function closePage(page) { try { await page.close(); } catch {} }
async function closeBrowser() { try { if (ctx) await ctx.close(); } catch {} ctx = null; ctxHeaded = false; }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');

async function isBlocked(page) {
  return page.evaluate(() => (document.head && document.head.getAttribute('title') === 'captcha')
    || /보안 확인을 완료해 주세요/.test(document.body ? document.body.innerText : '')).catch(() => false);
}

// 이동 후 보안 확인이 뜨면: 창을 띄워 같은 주소를 열고 사용자가 풀 때까지 기다린다.
// 반환값: 사용할 page(창 모드로 바뀌었으면 새 page) 또는 null(시간 초과).
async function gotoChecked(page, url, opt = {}, settle = 1500) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(settle);
  if (!(await isBlocked(page))) return page;
  if (opt.interactive === false) return null;
  const log = opt.onLog || (() => {});
  log('⚠ 네이버 보안 확인이 떴습니다. 열린 브라우저 창에서 직접 확인을 완료해 주세요(최대 3분 대기).');
  await closePage(page);
  const c = await getContext(true);
  const p = c.pages()[0] || await c.newPage();
  p.setDefaultTimeout(30000);
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.bringToFront().catch(() => {});
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    await sleep(2000);
    if (opt.shouldStop && opt.shouldStop()) return null;
    if (!(await isBlocked(p))) { log('보안 확인 완료, 이어서 진행합니다.'); await sleep(1500); return p; }
  }
  return null;
}

async function scrollToLoad(page, { maxRounds = 30, wait = 900, stop } = {}) {
  let prevH = 0, same = 0;
  for (let i = 0; i < maxRounds; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(wait);
    if (stop && await stop()) return;
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prevH) { if (++same >= 3) return; } else same = 0;
    prevH = h;
  }
}

/* ---------------- 1. 플레이스 순위 ---------------- */
// 네이버 PC 지도 업체 목록(pcmap.place.naver.com) 1페이지를 그대로 받아 읽는다.
// 이 페이지는 브라우저 없이도 서버가 관련도순 50곳과 광고 목록을 함께 내려주므로 보안 확인이 뜨지 않는다.
// 광고를 뺀 순서가 모바일 플레이스 목록 순위와 같다(2026-11-26 청주치과로 대조 확인).
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
function readApollo(html) {
  const i = html.indexOf('window.__APOLLO_STATE__');
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  // 스크립트 끝의 '};' 까지가 JSON 이다.
  const end = html.indexOf('};', start);
  try { return JSON.parse(html.slice(start, end + 1)); } catch { return null; }
}
// 플레이스 순위: 네이버 플레이스 목록(관련도순, 광고 제외) 50위까지 순위만 본다.
// 통검 플레이스 영역과 순서가 같고(청주치과 27위·금천동치과 1위 대조), 광고 개수에 영향받지 않는다.
// 브라우저 없이 목록 한 번만 받아서 빠르고 가볍다(2026-11-26 사용자 결정).
const PLACE_LIMIT = 50;
async function checkPlaceMap(keyword, targets, opt = {}) {
  const limit = opt.placeLimit || PLACE_LIMIT;
  const url = 'https://pcmap.place.naver.com/place/list?query=' + encodeURIComponent(keyword);
  let res, html;
  try {
    res = await fetch(url, { headers: { 'User-Agent': PC_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(30000) });
    html = await res.text();
  } catch (e) { return { status: '확인필요', note: '접속 실패: ' + e.message, url }; }
  const st = readApollo(html);
  if (!st || !st.ROOT_QUERY) return { status: '확인필요', note: /captcha/i.test(html.slice(0, 500)) ? '보안 확인 표시됨(잠시 후 다시)' : '목록 데이터를 찾지 못함', url: res.url };
  const root = st.ROOT_QUERY;
  const get = r => (r && r.__ref ? st[r.__ref] : r) || {};
  const listKey = Object.keys(root).find(k => k.startsWith('placeList('));
  const biz = listKey && root[listKey] && root[listKey].businesses;
  const raw = biz && biz.items ? biz.items.map(get) : [];
  const typeMatch = res.url.match(/pcmap\.place\.naver\.com\/(\w+)\/list/);
  const ptype = typeMatch ? typeMatch[1] : 'place';
  const list = raw.map((it, i) => ({
    rank: i + 1, id: String(it.id), name: it.name || '', category: it.category || '',
    address: it.commonAddress || it.roadAddress || '',
    visitorReviews: it.visitorReviewCount || '0', blogReviews: it.blogCafeReviewCount || '0',
  }));
  const adKey = Object.keys(root).find(k => k.startsWith('adBusinesses('));
  const adRaw = adKey && root[adKey] ? (root[adKey].items || []).map(get) : [];
  const ads = adRaw.map(x => ({ id: String(x.id || ''), name: x.name || '' }));
  const hits = list.filter(it => matchAny(it.name + ' ' + it.id, targets));
  const adHit = ads.findIndex(x => matchAny(x.name + ' ' + x.id, targets));
  if (!list.length) return { status: '확인필요', note: '플레이스 목록이 없는 키워드(또는 구조 변경)', url: res.url };
  return {
    status: hits.length && hits[0].rank <= limit ? '노출' : '순위밖',
    rank: hits.length && hits[0].rank <= limit ? hits[0].rank : null,
    listRank: hits.length ? hits[0].rank : null, limit,
    found: hits.map(h => ({ ...h, link: 'https://m.place.naver.com/' + ptype + '/' + h.id })),
    total: biz.total, checked: list.length,
    ad: adHit >= 0 ? '광고 ' + (adHit + 1) + '번째 노출' : '',
    top: list.slice(0, 10).map(x => x.rank + '. ' + x.name),
    basis: '플레이스 목록', note: '관련도순 ' + limit + '위까지 확인(전체 ' + (biz.total || '?') + '곳)', url: res.url,
  };
}

// 기본 방식: PC 통합검색 플레이스 영역에서 화살표로 5페이지까지 넘기며 실제 노출 순서를 센다.
// 페이지마다 광고 수가 달라 일반 업체 수가 바뀌므로, 광고(ader 링크)는 순위에서 빼고 페이지별 광고 수를 함께 적는다.
// 영역이 없거나 읽지 못하면 네이버 지도 목록 순위(checkPlaceMap)로 대체한다.
const PC_VIEW = { viewport: { width: 1280, height: 900 } };
// (예전 방식, 지금은 안 씀) 통검 플레이스 영역을 화살표로 5페이지까지 넘기며 세기
async function checkPlacePaged(keyword, targets, opt = {}) {
  const maxPages = opt.placePages || 5;
  const url = 'https://search.naver.com/search.naver?query=' + encodeURIComponent(keyword);
  let ctxPc = null;
  const fallback = async (why) => {
    const m = await checkPlaceMap(keyword, targets, opt);
    return { ...m, basis: '지도 목록(대체)', note: why + ' → 지도 목록 기준' + (m.note ? ' · ' + m.note : '') };
  };
  try {
    const b = await launchBrowser();
    ctxPc = b;
    const page = await (await b.newContext({ ...PC_VIEW, locale: 'ko-KR', timezoneId: 'Asia/Seoul' })).newPage();
    page.setDefaultTimeout(20000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    if (await isBlocked(page)) return await fallback('통검 보안 확인');
    if (!(await page.$('#place-main-section-root'))) return await fallback('통검에 플레이스 영역 없음');
    const read = () => page.evaluate(() => {
      const r = document.querySelector('#place-main-section-root');
      const ul = [...r.querySelectorAll('ul')].sort((a, b) => b.children.length - a.children.length)[0];
      if (!ul) return [];
      return [...ul.children].map(li => {
        const lines = li.innerText.split('\n').map(x => x.trim()).filter(Boolean).filter(x => !/^이미지 수$|^\d+$|^[가-힣]\d{4,6}$/.test(x));
        return { name: lines[0] || '', ad: !!li.querySelector('a[href*="ader.naver.com"]'), text: lines.slice(0, 6).join(' ') };
      }).filter(x => x.name);
    });
    const pages = []; let organic = 0; const hits = []; const top = [];
    for (let pno = 1; pno <= maxPages; pno++) {
      const items = await read();
      if (!items.length) break;
      let ads = 0, pos = 0;
      for (const it of items) {
        pos++;
        if (it.ad) { ads++; if (matchAny(it.name, targets)) hits.push({ ad: true, page: pno, pos, name: it.name }); continue; }
        organic++;
        if (top.length < 10) top.push(organic + '. ' + it.name);
        if (matchAny(it.name + ' ' + it.text, targets)) hits.push({ ad: false, rank: organic, page: pno, pos, name: it.name });
      }
      pages.push({ page: pno, ads, organic: items.length - ads });
      if (hits.some(h => !h.ad) && !opt.fullScan) break;
      if (pno === maxPages) break;
      const before = items.map(x => x.name).join('|');
      const next = await page.$('#place-main-section-root a.cmm_pg_next');
      if (!next || (await next.getAttribute('aria-disabled')) === 'true') break;
      await next.click();
      let changed = false;
      for (let w = 0; w < 10 && !changed; w++) { await sleep(400); changed = (await read()).map(x => x.name).join('|') !== before; }
      if (!changed) break;
    }
    if (!pages.length) return await fallback('통검 플레이스 목록을 읽지 못함');
    const hit = hits.find(h => !h.ad);
    const adHit = hits.find(h => h.ad);
    const adTxt = '페이지별 광고 ' + pages.map(p => p.ads).join('/') + '개';
    let mapNote = '';
    if (!hit) { try { const m = await checkPlaceMap(keyword, targets, { placeLimit: 50 }); if (m.listRank) mapNote = '지도 목록 ' + m.listRank + '위'; } catch {} }
    return {
      status: hit ? '노출' : '순위밖', basis: '통검 플레이스',
      rank: hit ? hit.rank : null, page: hit ? hit.page : null, pos: hit ? hit.pos : null,
      found: hit ? [{ rank: hit.rank, name: hit.name, link: url }] : [],
      ad: adHit ? '광고로도 노출(' + adHit.page + '페이지 ' + adHit.pos + '번째)' : '',
      pagesChecked: pages.length, pageAds: pages, top,
      note: (hit ? hit.page + '페이지 ' + hit.pos + '번째 칸 · ' : pages.length + '페이지(일반 ' + organic + '곳)까지 없음 · ') + adTxt + (mapNote ? ' · ' + mapNote : ''),
      url,
    };
  } catch (e) {
    return await fallback('통검 확인 오류(' + e.message.slice(0, 60) + ')');
  } finally { if (ctxPc) await ctxPc.close().catch(() => {}); }
}

async function checkPlace(keyword, targets, opt = {}) {
  return checkPlaceMap(keyword, targets, { ...opt, placeLimit: PLACE_LIMIT });
}

/* ---------------- 2. 통합검색 노출 순위 ---------------- */
// 순위는 웹페이지·블로그·카페가 쭉 나열되는 "통합 결과" 목록 안에서만 센다(여러 페이지면 이어서 셈).
// 플레이스·클립(따로 재는 영역), 파워링크, 관련검색어, AI 브리핑, 인플루언서처럼 별도 탭·광고 영역은 순위에서 뺀다.
// 인기글 같은 스마트블록(블로그·카페 묶음)에 걸린 글은 순위에 섞지 않고 참고로 따로 적는다.
const EXCLUDED_BLOCK = /^(플레이스|클립|광고|관련검색어|AI ?브리핑|인플루언서|이미지|동영상|쇼핑|뉴스|지식백과|어학사전)/;
async function checkSearch(keyword, targets, opt = {}) {
  const pages = 1; // 통검은 1페이지를 끝까지 스크롤한 범위만 본다.
  let page = await newPage();
  const results = { status: '미노출', found: [], smart: [], blocks: [], list: [], related: [], listTotal: 0, url: 'https://m.search.naver.com/search.naver?query=' + encodeURIComponent(keyword) };
  try {
    let listRank = 0; let blockNo = 0;
    for (let p = 1; p <= pages; p++) {
      const url = results.url + (p > 1 ? `&where=m&start=${(p - 1) * 15 + 1}` : '');
      const pg = await gotoChecked(page, url, opt, 1500);
      if (!pg) { results.status = '확인필요'; results.note = '보안 확인 미완료(자동조회 제한)'; return results; }
      page = pg;
      await scrollToLoad(page, { maxRounds: 20, wait: 800 });
      const blocks = await page.evaluate(extractSearchBlocks);
      for (const b of blocks) {
        const shown = !b.skipRank;
        if (shown) blockNo++;
        const isList = b.name.startsWith('통합 결과');
        const excluded = EXCLUDED_BLOCK.test(b.name);
        const items = b.items.map((it, i) => ({ ...it, pos: i + 1, rank: isList ? ++listRank : null }));
        // 작성 가이드용: 통합 결과 목록 전체(순위·구분·제목·링크·출처)
        if (isList) for (const it of items) results.list.push({ rank: it.rank, type: it.type, title: it.title, link: it.href, source: it.source || '' });
        const mark = it => ({ ...it, by: matchAny((it.owner || '') + ' ' + it.href + (it.type === '플레이스' || it.type === '클립' ? ' ' + it.text : ''), targets) ? '자사 채널' : '외부 ' + it.type });
        const hits = excluded ? [] : items.filter(it => matchAny(it.text + ' ' + it.href + ' ' + (it.owner || ''), targets)).map(mark);
        if (b.related) for (const t of b.related) if (!results.related.includes(t)) results.related.push(t);
        results.blocks.push({ page: p, no: shown ? blockNo : null, name: b.name, count: items.length, hit: hits.length, counted: isList,
          items: b.name === '클립' ? items.map(it => ({ pos: it.pos, title: it.title, href: it.href, mine: matchAny(it.text + ' ' + it.href, targets) })) : undefined });
        for (const h of hits) {
          const rec = { page: p, block: b.name, blockNo: shown ? blockNo : null, pos: h.pos, rank: h.rank, type: h.type, title: h.title, source: h.source || '', by: h.by, link: h.href };
          (isList ? results.found : results.smart).push(rec);
        }
      }
    }
    results.listTotal = listRank;
    if (results.found.length) {
      results.status = '노출';
      // 자사 채널이든 외부 글(외부 블로그 원고일 가능성)이든 가장 위의 것을 대표 순위로 쓴다.
      const f = results.found[0];
      results.best = `${f.rank}위 · ${f.by}`;
    } else if (results.smart.length) {
      results.status = '스마트블록만';
      const f = results.smart[0];
      results.best = `목록 미노출 · ${f.block} ${f.pos}번째`;
    }
    return results;
  } finally { await closePage(page); }
}

// 브라우저 안에서 실행: #ct 의 최상위 블록을 영역으로 보고 영역별 콘텐츠를 뽑는다.
function extractSearchBlocks() {
  const ct = document.querySelector('#ct') || document.body;
  const typeOf = href => {
    if (/blog\.naver\.com|m\.blog\.naver/.test(href)) return '블로그';
    if (/cafe\.naver\.com/.test(href)) return '카페';
    if (/kin\.naver\.com/.test(href)) return '지식iN';
    if (/place\.naver\.com|map\.naver\.com/.test(href)) return '플레이스';
    if (/clip\.naver\.com|naver\.com\/shorts/.test(href)) return '클립';
    if (/post\.naver\.com/.test(href)) return '포스트';
    if (/news|n\.news/.test(href)) return '뉴스';
    if (/tv\.naver|youtube|youtu\.be/.test(href)) return '동영상';
    if (/in\.naver\.com/.test(href)) return '인플루언서';
    return '웹사이트';
  };
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const mainLink = el => {
    const as = [...el.querySelectorAll('a[href^="http"]')].filter(a => !/search\.naver\.com|ader\.naver|help\.naver|nid\.naver|keep\.naver/.test(a.href));
    return as.find(a => clean(a.innerText).length > 6) || as[0] || null;
  };
  // 글 한 편을 가리키는 주소면 그 글의 고유 키를 돌려준다.
  const docKey = href => {
    let m;
    if ((m = href.match(/blog\.naver\.com\/([\w-]+)\/(\d{6,})/))) return 'blog:' + m[1] + '/' + m[2];
    if ((m = href.match(/blog\.naver\.com\/PostView.*?blogId=([\w-]+).*?logNo=(\d+)/))) return 'blog:' + m[1] + '/' + m[2];
    if ((m = href.match(/cafe\.naver\.com\/([\w-]+)\/(\d+)/))) return 'cafe:' + m[1] + '/' + m[2];
    if ((m = href.match(/in\.naver\.com\/([\w-]+)\/contents\/\w+\/(\d+)/))) return 'in:' + m[1] + '/' + m[2];
    if ((m = href.match(/kin\.naver\.com\/qna\/detail.*?docId=(\d+)/))) return 'kin:' + m[1];
    if ((m = href.match(/post\.naver\.com\/viewer.*?volumeNo=(\d+)/))) return 'post:' + m[1];
    if ((m = href.match(/n\.news\.naver\.com\/.*?article\/(\d+)\/(\d+)/))) return 'news:' + m[1] + '/' + m[2];
    return null;
  };
  const splitByDocs = c => {
    const anchors = [...c.querySelectorAll('a[href]')].map(a => ({ a, k: docKey(a.href) })).filter(x => x.k);
    const keys = [...new Set(anchors.map(x => x.k))];
    if (keys.length < 2) return [];
    return keys.map(k => {
      let el = anchors.find(x => x.k === k).a;
      // 다른 글 링크를 품지 않는 가장 바깥 조상까지 올라가 그 글 한 편의 칸으로 본다.
      while (el.parentElement && el.parentElement !== c &&
        ![...el.parentElement.querySelectorAll('a[href]')].some(a => { const kk = docKey(a.href); return kk && kk !== k; })) el = el.parentElement;
      return el;
    });
  };
  const blocks = [];
  const kids = [...ct.children].filter(c => !/^(SCRIPT|LINK|STYLE)$/.test(c.tagName) && !(c.className + '').includes('_scrollLog') && c.id !== 'snb' && !(c.className + '').includes('sp_page') && c.offsetHeight > 0);
  let webRun = null;
  for (const c of kids) {
    const txt = clean(c.innerText);
    if (!txt) continue;
    const head = clean((c.querySelector('h2, h3, .fds-comps-header-headline, .api_title') || {}).innerText).slice(0, 30);
    const ssuids = [...new Set([...c.querySelectorAll('[data-meta-ssuid]')].map(e => e.getAttribute('data-meta-ssuid')).concat(c.getAttribute('data-meta-ssuid') || []))];
    let name = '', skipRank = false, items = [];
    if (c.id === 'place-app-root' || c.querySelector('#place-app-root')) {
      name = '플레이스';
      const re = /place\.naver\.com\/\w+\/(\d+)/; const seen = new Set();
      for (const li of c.querySelectorAll('li')) {
        const a = [...li.querySelectorAll('a[href]')].find(x => re.test(x.href)); if (!a) continue;
        const id = a.href.match(re)[1]; if (seen.has(id)) continue; seen.add(id);
        const nmEl = [...li.querySelectorAll('a[href*="entry="]:not([href*="/photo"]) span')].find(x => clean(x.innerText));
        const nm = clean((nmEl || a).innerText);
        if (/광고/.test(li.innerText.split('\n').slice(0, 6).join(' '))) continue;
        items.push({ type: '플레이스', title: nm, text: clean(li.innerText).slice(0, 200), href: a.href.split("?")[0].replace(/\/photo$/, "") });
      }
    } else if (c.querySelector('.fds-clip-card-container') || ssuids.includes('clip')) {
      name = '클립';
      for (const card of c.querySelectorAll('.fds-clip-card-container')) {
        const a = card.querySelector('a[href*="shorts"], a[href*="clip"]');
        const prof = card.querySelector('a[href*="clip.naver.com/@"]');
        items.push({ type: '클립', title: clean(card.innerText).slice(0, 80), text: clean(card.innerText) + ' ' + (prof ? prof.href : ''), href: a ? a.href : '' });
      }
    } else if (ssuids.length === 1 && ssuids[0] === 'qra' || /^관련 검색어/.test(txt)) {
      name = '관련검색어'; skipRank = true;
      // 관련검색어 글자들(키워드 추천 후보로 씀)
      items = []; var related = [...c.querySelectorAll('a')].map(a => clean(a.innerText)).filter(t => t && t.length >= 2 && t.length <= 30 && !/관련s*검색어|더보기|닫기|열기/.test(t));
    } else if (/파워링크|광고/.test(txt.slice(0, 40)) && !ssuids.length || c.querySelector('.ad_area, [class*="powerlink"], a[href*="ader.naver.com"]') && !ssuids.some(s => s !== 'ad')) {
      name = '광고(파워링크)'; skipRank = true;
    } else {
      // 일반 결과: 안쪽의 [data-meta-ssuid] 하나하나를 콘텐츠로 본다(중첩 제외).
      let units = [...c.querySelectorAll('[data-meta-ssuid]')].filter(e => !e.parentElement.closest('[data-meta-ssuid]'));
      if (c.matches('[data-meta-ssuid]')) units = [c];
      // 인기글·카페글·인플루언서 같은 묶음은 글 주소(블로그 글번호, 카페 글번호 등) 기준으로 한 편씩 나눈다.
      const docUnits = splitByDocs(c);
      if (docUnits.length > units.length) units = docUnits;
      if (!units.length) units = [...c.querySelectorAll('li')].filter(li => li.querySelector('a[href^="http"]') && !li.parentElement.closest('li'));
      if (!units.length) units = [c];
      for (const u of units) {
        if (u.getAttribute('data-meta-ssuid') === 'qra') continue;
        const as = [...u.querySelectorAll('a[href^="http"]')].filter(a => !/search\.naver\.com|ader\.naver|help\.naver|nid\.naver|keep\.naver/.test(a.href));
        if (!as.length) continue;
        const cnt = {}; as.forEach(a => { cnt[a.href] = (cnt[a.href] || 0) + (docKey(a.href) ? 10 : 1); });
        const href = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x])[0];
        const isDate = t => /^\d{4}\.\d{2}\.\d{2}\.?$|전$/.test(t);
        const tA = as.find(a => a.href === href && clean(a.innerText).length >= 4 && !isDate(clean(a.innerText)));
        const first = as[0];
        const source = first.href !== href ? clean(first.innerText).slice(0, 40) : '';
        const title = clean((tA || first).innerText).slice(0, 80);
        items.push({ type: typeOf(href), title, source, text: clean(u.innerText).slice(0, 400), owner: source + ' ' + as.map(x => x.href).join(' '), href });
      }
      if (!items.length) continue;
      const isFlat = !head && c.className.includes('spw_fsolid');
      if (isFlat) {
        // 블로그·카페·웹사이트가 섞여 이어지는 기본 결과 묶음은 하나의 영역으로 합친다.
        if (webRun) { webRun.items.push(...items); continue; }
        name = '통합 결과';
        webRun = { name, skipRank: false, items };
        blocks.push(webRun); continue;
      }
      name = head || (ssuids.includes('review') ? '블로그·카페' : ssuids[0] || '기타');
    }
    webRun = null;
    blocks.push({ name, skipRank, items, related: name === '관련검색어' ? related : undefined });
  }
  return blocks;
}

/* ---------------- 3. 클립탭 순위 ---------------- */
async function checkClip(keyword, targets, opt = {}) {
  const maxRank = opt.maxRank || 100;
  const sort = opt.sort || 'rel';
  let page = await newPage();
  const nso = sort === 'date' ? '&nso=so%3Add' : sort === 'view' ? '&nso=so%3Aview' : '';
  const url = 'https://m.search.naver.com/search.naver?ssc=tab.m_clip.all&sm=mtb_jum&query=' + encodeURIComponent(keyword) + nso;
  try {
    const pg = await gotoChecked(page, url, opt, 1500);
    if (!pg) return { status: '확인필요', note: '보안 확인 미완료(자동조회 제한)', url };
    page = pg;
    const count = () => page.evaluate(() => document.querySelectorAll('.fds-clip-card-container').length);
    await scrollToLoad(page, { maxRounds: 40, wait: 900, stop: async () => (await count()) >= maxRank });
    const cards = await page.evaluate(() => [...document.querySelectorAll('.fds-clip-card-container')].map(c => {
      const lines = c.innerText.split('\n').map(s => s.trim()).filter(Boolean);
      const prof = c.querySelector('a[href*="clip.naver.com/@"]');
      const link = c.querySelector('a[href*="shorts"], a[href*="clip.naver.com"]');
      const views = lines.find(l => /^조회/.test(l)) || '';
      const date = lines.find(l => /전$|^\d{2}\.\d{2}$|^\d{4}\.\d{2}\.\d{2}\.?$/.test(l)) || '';
      return { caption: lines[0] || '', channel: lines[1] || '', date, views: views.replace('조회', '').trim(), profile: prof ? prof.href : '', href: link ? link.href : '', html: [...c.querySelectorAll('a[href]')].map(a => a.href).join(' ') };
    }));
    const list = cards.slice(0, maxRank).map((c, i) => ({ ...c, rank: i + 1 }));
    const hits = list.filter(c => matchAny(c.channel + ' ' + c.caption + ' ' + c.profile + ' ' + c.html, targets));
    return {
      status: list.length ? (hits.length ? '노출' : '순위밖') : '확인필요',
      rank: hits.length ? hits[0].rank : null,
      count: hits.length,
      found: hits.map(h => ({ rank: h.rank, channel: h.channel, caption: h.caption, date: h.date, views: h.views, link: h.href })),
      total: list.length, note: list.length ? `${list.length}개까지 확인` : '클립 결과를 읽지 못함', url,
    };
  } finally { await closePage(page); }
}

/* ---------------- 3-1. 통합검색 클립 영역 노출 ---------------- */
// 우선순위: ① 모바일 통합검색에 클립 영역이 있는가 ② 있다면 몇 번째 영역인가 ③ 그 안에 내 클립이 있는가
// (선택) ④ 클립 탭에서 내 클립 순위
async function checkClipExposure(keyword, targets, opt = {}) {
  const s = await checkSearch(keyword, targets, { ...opt, pages: 1 });
  const url = s.url;
  if (s.status === '확인필요') return { status: '확인필요', note: s.note, url };
  const counted = s.blocks.filter(b => b.no);
  const clip = s.blocks.find(b => b.name === '클립');
  const r = {
    status: clip ? '클립 노출' : '클립 없음', url,
    exists: !!clip, blockNo: clip ? clip.no : null, blockTotal: counted.length,
    cards: clip ? clip.count : 0,
    mine: clip ? clip.items.filter(x => x.mine).map(x => x.pos) : [],
    cardsList: clip ? clip.items : [],
    order: counted.map(b => b.name).filter((n, i, a) => n !== a[i - 1]),
  };
  if (opt.withTab) {
    try { r.tab = await checkClip(keyword, targets, opt); } catch (e) { r.tab = { status: '확인필요', note: e.message }; }
  }
  return r;
}

/* ---------------- 3-2. 통검 클립 존재 여부(대량용, 브라우저 없음) ---------------- */
// 모바일 통합검색 첫 응답 HTML에 클립 전용 영역(data-meta-ssuid="clip" / data-template-type="clip" / 클립 카드)이 있으면 '있음'.
// 2026-11-26 충치치료·치아미백·청주 맛집(있음), 청주치과·금천동치과(없음)로 브라우저 결과와 대조 확인.
const MO_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
async function checkClipFast(keyword, targets, opt = {}) {
  const url = 'https://m.search.naver.com/search.naver?query=' + encodeURIComponent(keyword);
  let html;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': MO_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { status: '확인필요', note: 'HTTP ' + res.status, url };
    html = await res.text();
  } catch (e) { return { status: '확인필요', note: '접속 실패: ' + e.message, url }; }
  if (html.length < 5000 || !/<title>[^<]*네이버\s*검색/.test(html)) return { status: '확인필요', note: '검색 결과 페이지가 아님(차단 가능성)', url };
  const exists = /data-meta-ssuid=["']clip["']|data-template-type=["']clip["']|fds-clip-card-container/.test(html);
  const cards = (html.match(/fds-clip-card-container/g) || []).length;
  let mine = false;
  if (exists && targets.length) {
    const i = html.search(/data-meta-ssuid=["']clip["']|data-template-type=["']clip["']|fds-clip-card-container/);
    mine = matchAny(html.slice(Math.max(0, i - 2000), i + 60000).replace(/<[^>]+>/g, ' '), targets) || matchAny(html.slice(i, i + 60000), targets);
  }
  return { status: exists ? '클립 있음' : '클립 없음', exists, cards, mine, url, note: '' };
}

function matchAny(text, targets) {
  const t = norm(text);
  return targets.some(k => k && t.includes(norm(k)));
}

module.exports = { setHeaded, checkClipFast, checkClipExposure, checkPlace, checkSearch, checkClip, closeBrowser };
