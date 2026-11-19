// Vercel Serverless Function: GET /api/public
// 공공데이터 실시간 연동
//  1) 청약홈(한국부동산원) APT 분양정보  - 공공데이터포털 인증키 필요 (DATA_GO_KR_KEY)
//  2) 국토교통부 아파트 매매 실거래가    - 공공데이터포털 인증키 필요 (DATA_GO_KR_KEY)
//  3) 국토교통부·행정안전부 보도자료     - 키 불필요 (정책브리핑 RSS, 실패 시 Google 뉴스)
//
// 공공데이터포털(data.go.kr)에서 아래 3개 API를 '활용신청'하면 같은 인증키로 모두 쓸 수 있습니다.
//  - 한국부동산원_청약홈 분양정보 조회 서비스
//  - 국토교통부_아파트 매매 실거래가 자료

const SEOUL_GU = [
  ['11110', '종로구'], ['11140', '중구'], ['11170', '용산구'], ['11200', '성동구'], ['11215', '광진구'],
  ['11230', '동대문구'], ['11260', '중랑구'], ['11290', '성북구'], ['11305', '강북구'], ['11320', '도봉구'],
  ['11350', '노원구'], ['11380', '은평구'], ['11410', '서대문구'], ['11440', '마포구'], ['11470', '양천구'],
  ['11500', '강서구'], ['11530', '구로구'], ['11545', '금천구'], ['11560', '영등포구'], ['11590', '동작구'],
  ['11620', '관악구'], ['11650', '서초구'], ['11680', '강남구'], ['11710', '송파구'], ['11740', '강동구'],
];
const METRO = ['서울', '경기', '인천'];

// ---------- helpers ----------
const decode = (s = '') =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};
const safeUrl = (u) => (u && /^https?:\/\//i.test(u) ? u : null);
const isoDate = (v) => { const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

async function fetchText(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 120)}`);
    return text;
  } finally { clearTimeout(t); }
}

// KST 기준 날짜
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function ym(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
function ymd(d) { return d.toISOString().slice(0, 10); }

// 디코딩 키(일반 문자열)든 인코딩 키(%2B 등 포함)든 받아들임
function keyParam(key) { return /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key); }

// ---------- 1) 청약홈 분양정보 ----------
async function cheongyak(key) {
  const since = new Date(kstNow().getTime() - 45 * 86400000);
  const base = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail';
  const url = `${base}?page=1&perPage=300&serviceKey=${keyParam(key)}` +
    `&${encodeURIComponent('cond[RCRIT_PBLANC_DE::GTE]')}=${ymd(since)}`;
  const json = JSON.parse(await fetchText(url));
  if (!Array.isArray(json.data)) throw new Error(json.msg || json.message || '응답 형식 오류');
  const today = ymd(kstNow());
  const items = json.data
    .filter((d) => METRO.includes(d.SUBSCRPT_AREA_CODE_NM))
    .map((d) => ({
      name: d.HOUSE_NM,
      region: d.SUBSCRPT_AREA_CODE_NM,
      address: d.HSSPLY_ADRES,
      type: d.HOUSE_DTL_SECD_NM || d.HOUSE_SECD_NM,
      households: Number(d.TOT_SUPLY_HSHLDCO) || null,
      noticeDate: d.RCRIT_PBLANC_DE,
      receiptStart: d.RCEPT_BGNDE,
      receiptEnd: d.RCEPT_ENDDE,
      winnerDate: d.PRZWNER_PRESNATN_DE,
      moveIn: d.MVN_PREARNGE_YM,
      url: safeUrl(d.PBLANC_URL) || safeUrl(d.HMPG_ADRES),
      status: !d.RCEPT_BGNDE ? '공고' : today < d.RCEPT_BGNDE ? '접수예정' : today <= d.RCEPT_ENDDE ? '접수중' : '접수마감',
    }))
    .sort((a, b) => (b.receiptStart || b.noticeDate || '').localeCompare(a.receiptStart || a.noticeDate || ''));
  return { since: ymd(since), count: items.length, items: items.slice(0, 40) };
}

// ---------- 2) 국토부 아파트 매매 실거래가 (서울 25개 구) ----------
function parseTrades(xml) {
  const code = tag(xml, 'resultCode');
  if (code && !['000', '00'].includes(code)) throw new Error(`${code} ${tag(xml, 'resultMsg')}`);
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map((it) => ({
    apt: tag(it, 'aptNm'),
    dong: tag(it, 'umdNm'),
    price: Number(tag(it, 'dealAmount').replace(/,/g, '')) || 0, // 만원
    area: Number(tag(it, 'excluUseAr')) || 0,
    floor: tag(it, 'floor'),
    date: `${tag(it, 'dealYear')}-${tag(it, 'dealMonth').padStart(2, '0')}-${tag(it, 'dealDay').padStart(2, '0')}`,
    canceled: tag(it, 'cdealType') === 'O',
  })).filter((t) => t.price && !t.canceled);
}

async function tradesFor(key, lawd, month) {
  const url = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade' +
    `?serviceKey=${keyParam(key)}&LAWD_CD=${lawd}&DEAL_YMD=${month}&pageNo=1&numOfRows=1000`;
  return parseTrades(await fetchText(url));
}

async function realTrades(key) {
  const now = kstNow();
  const thisMonth = ym(now);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevMonth = ym(prev);

  const jobs = [];
  for (const [code, name] of SEOUL_GU) {
    jobs.push(tradesFor(key, code, prevMonth).then((r) => ({ code, name, month: 'prev', r })));
    jobs.push(tradesFor(key, code, thisMonth).then((r) => ({ code, name, month: 'cur', r })));
  }
  const settled = await Promise.allSettled(jobs);
  const errors = settled.filter((s) => s.status === 'rejected').map((s) => s.reason && s.reason.message);
  if (errors.length === settled.length) throw new Error(errors[0] || '실거래가 조회 실패');

  const byGu = new Map(SEOUL_GU.map(([code, name]) => [code, { code, name, prev: [], cur: [] }]));
  settled.forEach((s) => { if (s.status === 'fulfilled') byGu.get(s.value.code)[s.value.month] = s.value.r; });

  const districts = [...byGu.values()].map((g) => {
    const perPyeong = g.prev.filter((t) => t.area).map((t) => Math.round((t.price / t.area) * 3.3058));
    return {
      name: g.name,
      prevCount: g.prev.length,
      curCount: g.cur.length,
      medianPrice: median(g.prev.map((t) => t.price)),
      medianPerPyeong: median(perPyeong),
    };
  });

  const all = [...byGu.values()].flatMap((g) => [...g.cur, ...g.prev].map((t) => ({ ...t, gu: g.name })));
  const recent = all.sort((a, b) => b.date.localeCompare(a.date) || b.price - a.price).slice(0, 15);
  const top = [...all].sort((a, b) => b.price - a.price).slice(0, 10);

  return {
    prevMonth, thisMonth,
    totalPrev: districts.reduce((s, d) => s + d.prevCount, 0),
    totalCur: districts.reduce((s, d) => s + d.curCount, 0),
    districts, recent, top,
    partialErrors: errors.length,
  };
}

// ---------- 3) 국토부·행안부 보도자료 ----------
// 행정안전부: 부처 공식 보도자료 RSS
// 국토교통부: 부처 사이트가 해외 서버 접속을 막아, 정책브리핑(korea.kr) 게시물만 Google 뉴스로 검색
const MOIS_RELEVANT = /주민등록|인구|주소|부동산|주택|지방세|재산세|취득세|전입|정주|공시/;

function parseRss(xml) {
  return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => {
    let title = tag(it, 'title');
    const source = tag(it, 'source');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return {
      title,
      url: safeUrl(tag(it, 'link')),
      source,
      publishedAt: isoDate(tag(it, 'pubDate').replace(/\bKST\b/i, '+0900')),
    };
  }).filter((x) => x.title && x.url);
}

const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };

const MOLIT_RELEVANT = /주택|부동산|아파트|전세|월세|임대|분양|청약|주택공급|공급대책|택지|재건축|재개발|정비사업|공시가격|실거래|주거|입주|신도시|리모델링|집값|LH/;

async function pressMolit() {
  const queries = ['국토교통부 주택 site:korea.kr when:30d', '국토교통부 부동산 site:korea.kr when:30d', '국토교통부 아파트 공급 site:korea.kr when:30d'];
  const results = await Promise.allSettled(queries.map((q) =>
    fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`, UA, 7000).then(parseRss)));
  const seen = new Set();
  const items = [];
  results.forEach((r) => {
    if (r.status !== 'fulfilled') return;
    r.value.forEach((i) => {
      i.title = i.title.replace(/\s+-\s+(카드\/한컷|영상|사진)?\s*\|?\s*멀티미디어$/, '');
      const key = i.title.replace(/\s+/g, '');
      if (!MOLIT_RELEVANT.test(i.title) || seen.has(key)) return;
      seen.add(key);
      items.push(i);
    });
  });
  if (!items.length && results.every((r) => r.status === 'rejected')) throw new Error(results[0].reason.message);
  items.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  return { label: '국토교통부', origin: '정책브리핑(korea.kr) 주택·부동산 게시물 · Google 뉴스 경유', items: items.slice(0, 10) };
}

async function pressMois() {
  const all = parseRss(await fetchText('https://www.mois.go.kr/gpms/view/jsp/rss/rss.jsp?ctxCd=1012', UA, 7000))
    .map((i) => ({ ...i, source: '행정안전부', relevant: MOIS_RELEVANT.test(i.title) }));
  all.sort((a, b) => (b.relevant - a.relevant) || (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  return { label: '행정안전부', origin: '행정안전부 보도자료 RSS · 주민등록·인구·지방세·부동산 관련 우선', items: all.slice(0, 10) };
}

// ---------- handler ----------
const wrap = (p) => p.then((data) => ({ ok: true, ...data })).catch((e) => ({ ok: false, error: String(e && e.message || e) }));

module.exports = async (req, res) => {
  const key = process.env.DATA_GO_KR_KEY;
  const keyConfigured = Boolean(key);
  const noKey = Promise.resolve({ ok: false, error: 'NO_KEY' });

  const [cy, rt, molit, mois] = await Promise.all([
    keyConfigured ? wrap(cheongyak(key)) : noKey,
    keyConfigured ? wrap(realTrades(key)) : noKey,
    wrap(pressMolit()),
    wrap(pressMois()),
  ]);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 엣지 캐시 30분 (공공데이터포털 일일 호출 한도 보호)
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=7200');
  res.status(200).send(JSON.stringify({
    updatedAt: new Date().toISOString(),
    keyConfigured,
    cheongyak: cy,
    realTrades: rt,
    press: { molit, mois },
  }));
};
