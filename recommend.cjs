// 재발행 추천: 통검 노출 기록을 보고 업체별로 노출이 떨어진 키워드를 찾아 중요한 키워드부터 정렬한다.
// 중요도 = 키워드 칸에 적은 순서 + 앞에 붙인 '@' 개수(@가 많을수록 먼저). 예) @@청주치과 > @청주임플란트 > 청주치과추천
// 기록 형식(history["search|업체|키워드"]): [{ date:'2026-11-27', rank:12|null, label, by:'자사 채널'|'외부 블로그'..., link, title }]

// 키워드 한 줄 → { keyword, at } ('@' 는 떼고 개수만 센다)
function parseKw(line) {
  const m = String(line).trim().match(/^(@*)\s*(.*)$/);
  return { keyword: m[2].trim(), at: m[1].length };
}
function parseList(text) {
  const seen = new Set(); const out = [];
  String(text || '').split(/\r?\n|\t/).forEach(l => {
    const p = parseKw(l); if (!p.keyword || seen.has(p.keyword)) return;
    seen.add(p.keyword); out.push({ ...p, order: out.length + 1 });
  });
  return out;
}

const DROP_STEP = 3;      // 이만큼 이상 순위가 떨어지면 '하락'
const LOOKBACK_DAYS = 30; // 최고 순위·마지막 노출 글을 찾는 기간

function analyze(entries, today) {
  if (!entries || !entries.length) return { state: '기록 없음', severity: 0 };
  const list = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const cur = list[list.length - 1];
  const before = list.slice(0, -1);
  const prev = before[before.length - 1] || null;
  const since = new Date(new Date(today).getTime() - LOOKBACK_DAYS * 86400e3).toLocaleDateString('sv-SE');
  const recent = before.filter(e => e.date >= since);
  const exposed = recent.filter(e => e.rank);
  const best = exposed.reduce((m, e) => (!m || e.rank < m.rank ? e : m), null);
  // 다시 쓸 글: 떨어지기 전에 노출되던 글(자사 글 우선). 이전 기록에 없으면 지금 글.
  const prevExposed = [...before].reverse().filter(e => e.rank && e.link);
  const lastExposed = prevExposed.find(e => e.by === '자사 채널') || prevExposed[0] || (cur.rank && cur.link ? cur : null);
  const base = { cur, prev, best, lastExposed };
  if (!prev) return { ...base, state: cur.rank ? '첫 기록(노출)' : '첫 기록(미노출)', severity: cur.rank ? 0 : 1, reason: cur.rank ? '' : '처음 확인했는데 미노출 → 발행 검토' };
  if (!cur.rank && prev.rank) return { ...base, state: '이탈', severity: 3, reason: `${prev.date.slice(5)} ${prev.rank}위 → 지금 미노출` };
  if (!cur.rank && best) return { ...base, state: '이탈(최근 노출 있었음)', severity: 3, reason: `최근 ${LOOKBACK_DAYS}일 최고 ${best.rank}위(${best.date.slice(5)}) → 지금 미노출` };
  if (!cur.rank) return { ...base, state: '계속 미노출', severity: 1, reason: `최근 ${LOOKBACK_DAYS}일 노출 기록 없음 → 새 글 발행 검토` };
  if (prev.rank && cur.rank - prev.rank >= DROP_STEP) return { ...base, state: `하락 ${cur.rank - prev.rank}칸`, severity: 2, reason: `${prev.date.slice(5)} ${prev.rank}위 → 지금 ${cur.rank}위` };
  if (prev.by === '자사 채널' && cur.by && cur.by !== '자사 채널') return { ...base, state: '자사 글 빠짐', severity: 2, reason: `자사 글이 빠지고 ${cur.by}만 남음` };
  if (best && cur.rank - best.rank >= DROP_STEP * 2) return { ...base, state: `최고 대비 하락 ${cur.rank - best.rank}칸`, severity: 1, reason: `최근 최고 ${best.rank}위(${best.date.slice(5)}) → 지금 ${cur.rank}위` };
  return { ...base, state: '유지', severity: 0 };
}

// vendor: { name, search: '키워드 칸 원문' }, history: 전체 기록
function recommend(vendor, history, today) {
  const kws = parseList(vendor.search);
  const rows = kws.map(k => {
    const a = analyze(history[`search|${vendor.name}|${k.keyword}`], today);
    const cell = e => (e ? `${e.date.slice(5)} ${e.rank ? e.rank + '위' : '미노출'}${e.by && e.rank ? ' · ' + e.by : ''}` : '-');
    return {
      keyword: k.keyword, at: k.at, order: k.order, importance: '@'.repeat(k.at) + (k.at ? ' ' : '') + k.order + '번째',
      state: a.state, severity: a.severity, reason: a.reason || '',
      prev: cell(a.prev), cur: cell(a.cur), best: a.best ? `${a.best.rank}위 (${a.best.date.slice(5)})` : '-',
      lastLink: a.lastExposed ? a.lastExposed.link : '', lastTitle: a.lastExposed ? (a.lastExposed.title || '') : '',
      lastBy: a.lastExposed ? (a.lastExposed.by || '') : '',
    };
  });
  // 추천 대상: 떨어졌거나 계속 미노출. 정렬은 중요도(@ 개수 → 칸 순서) 먼저, 같은 중요도면 심한 것 먼저.
  const picked = rows.filter(r => r.severity > 0)
    .sort((x, y) => (y.at - x.at) || (x.order - y.order) || (y.severity - x.severity));
  picked.forEach((r, i) => { r.no = i + 1; });
  return { rows: picked, checked: rows.length, noData: rows.filter(r => r.state === '기록 없음').length };
}

module.exports = { parseKw, parseList, analyze, recommend };
