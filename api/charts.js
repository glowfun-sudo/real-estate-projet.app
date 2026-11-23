// Vercel Serverless Function: GET /api/charts
// 시장 차트 8선용 실시간 데이터
//  - 국토교통부 아파트 매매 실거래가 상세 자료 (서울 25개 구 × 최근 6개월)
//  - 한국부동산원 청약홈 APT 분양정보 (수도권, 최근 6개월 모집공고)
// 공공데이터포털 인증키: 환경변수 DATA_GO_KR_KEY

const SEOUL_GU = [
  ['11110', '종로구', '도심권'], ['11140', '중구', '도심권'], ['11170', '용산구', '도심권'],
  ['11200', '성동구', '동북권'], ['11215', '광진구', '동북권'], ['11230', '동대문구', '동북권'],
  ['11260', '중랑구', '동북권'], ['11290', '성북구', '동북권'], ['11305', '강북구', '동북권'],
  ['11320', '도봉구', '동북권'], ['11350', '노원구', '동북권'],
  ['11380', '은평구', '서북권'], ['11410', '서대문구', '서북권'], ['11440', '마포구', '서북권'],
  ['11470', '양천구', '서남권'], ['11500', '강서구', '서남권'], ['11530', '구로구', '서남권'],
  ['11545', '금천구', '서남권'], ['11560', '영등포구', '서남권'], ['11590', '동작구', '서남권'],
  ['11620', '관악구', '서남권'],
  ['11650', '서초구', '동남권'], ['11680', '강남구', '동남권'], ['11710', '송파구', '동남권'], ['11740', '강동구', '동남권'],
];
const REGIONS = ['도심권', '동북권', '서북권', '서남권', '동남권'];
const MONTHS = 6;
const PRICE_BANDS = [ // 만원
  { label: '6억 이하', max: 60000 },
  { label: '6~9억', max: 90000 },
  { label: '9~15억', max: 150000 },
  { label: '15~25억', max: 250000 },
  { label: '25억 초과', max: Infinity },
];
const AREA_BANDS = [ // 전용 ㎡
  { label: '60㎡ 이하', max: 60 },
  { label: '60~85㎡', max: 85 },
  { label: '85~135㎡', max: 135 },
  { label: '135㎡ 초과', max: Infinity },
];

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
};
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const keyParam = (k) => (/%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k));
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const ym = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const ymLabel = (s) => `${Number(s.slice(4))}월`;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

function friendlyError(msg = '') {
  if (/SERVICE_KEY_IS_NOT_REGISTERED/.test(msg)) return '인증키에 이 API 활용신청이 안 되어 있습니다';
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/.test(msg)) return '공공데이터포털 호출 한도 초과 (잠시 후 다시 시도)';
  return msg;
}

async function fetchText(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`);
    return text;
  } finally { clearTimeout(t); }
}

async function fetchRetry(url, ms) {
  // 공공데이터포털 순간 호출 제한(429/LIMITED_NUMBER_OF_SERVICE_REQUESTS)·타임아웃이면 1s→2s→4s 쉬고 재시도
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const text = await fetchText(url, ms);
      if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/.test(text)) throw new Error('LIMITED_NUMBER_OF_SERVICE_REQUESTS');
      return text;
    } catch (e) {
      last = e;
      const transient = /429|LIMITED_NUMBER|abort|timeout|ECONNRESET|5\d\d/i.test(String(e && e.message || e) + (e && e.name));
      if (!transient || i === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

async function trades(key, lawd, month) {
  const url = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev' +
    `?serviceKey=${keyParam(key)}&LAWD_CD=${lawd}&DEAL_YMD=${month}&pageNo=1&numOfRows=2000`;
  const xml = await fetchRetry(url);
  const code = tag(xml, 'resultCode');
  if (code && !['000', '00'].includes(code)) throw new Error(`${code} ${tag(xml, 'resultMsg')}`);
  return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => ({
    price: Number(tag(it, 'dealAmount').replace(/,/g, '')) || 0,
    area: Number(tag(it, 'excluUseAr')) || 0,
    direct: tag(it, 'dealingGbn') === '직거래',
    buyer: tag(it, 'buyerGbn'),
    canceled: tag(it, 'cdealType') === 'O',
  })).filter((t) => t.price && !t.canceled);
}

async function seoulTrades(key, months) {
  // 첫 요청으로 키 상태 확인
  try { await trades(key, SEOUL_GU[0][0], months[months.length - 1]); }
  catch (e) { throw new Error(friendlyError(e.message)); }

  const tasks = [];
  for (const [code, name, region] of SEOUL_GU) for (const m of months) tasks.push({ code, name, region, m });

  const results = [];
  let failed = 0;
  for (let i = 0; i < tasks.length; i += 4) {
    const batch = tasks.slice(i, i + 4);
    const res = await Promise.allSettled(batch.map((t) => trades(key, t.code, t.m).then((rows) => ({ ...t, rows }))));
    res.forEach((r) => (r.status === 'fulfilled' ? results.push(r.value) : failed++));
  }
  if (!results.length) throw new Error('실거래가 조회 실패');
  return { results, failed, total: tasks.length };
}

function aggregate(results, months) {
  const prev = months[months.length - 2];
  const byMonth = Object.fromEntries(months.map((m) => [m, []]));
  const byRegionMonth = Object.fromEntries(REGIONS.map((r) => [r, Object.fromEntries(months.map((m) => [m, []]))]));
  const byGuPrev = {};
  for (const { name, region, m, rows } of results) {
    byMonth[m].push(...rows);
    byRegionMonth[region][m].push(...rows);
    if (m === prev) byGuPrev[name] = rows.length;
  }
  const perPyeong = (rows) => median(rows.filter((t) => t.area).map((t) => Math.round((t.price / t.area) * 3.3058)));

  // 1. 서울 3.3㎡당 중위가 추이 + 전월 대비 변동률
  const ppSeries = months.map((m) => perPyeong(byMonth[m]));
  const ppChange = ppSeries.map((v, i) => (i && v && ppSeries[i - 1] ? Math.round(((v - ppSeries[i - 1]) / ppSeries[i - 1]) * 1000) / 10 : null));

  // 2. 월별 거래량
  const volume = months.map((m) => byMonth[m].length);

  // 3. 구별 거래량 (전월)
  const guVolume = Object.entries(byGuPrev).sort((a, b) => b[1] - a[1]);

  // 5. 가격대별 비중 (전월)
  const prevRows = byMonth[prev];
  const priceBands = PRICE_BANDS.map((b, i) => {
    const min = i ? PRICE_BANDS[i - 1].max : -Infinity;
    const n = prevRows.filter((t) => t.price > min && t.price <= b.max).length;
    return { label: b.label, count: n, share: pct(n, prevRows.length) };
  });

  // 6. 권역별 3.3㎡당 중위가 추이
  const regions = REGIONS.map((r) => ({ name: r, values: months.map((m) => perPyeong(byRegionMonth[r][m])) }));

  // 7. 면적대별 비중 (전월)
  const areaBands = AREA_BANDS.map((b, i) => {
    const min = i ? AREA_BANDS[i - 1].max : -Infinity;
    const n = prevRows.filter((t) => t.area > min && t.area <= b.max).length;
    return { label: b.label, count: n, share: pct(n, prevRows.length) };
  });

  // 8. 직거래·법인 매수 비중
  const directShare = months.map((m) => pct(byMonth[m].filter((t) => t.direct).length, byMonth[m].length));
  const corpShare = months.map((m) => pct(byMonth[m].filter((t) => t.buyer && t.buyer !== '개인').length, byMonth[m].length));

  return { ppSeries, ppChange, volume, guVolume, priceBands, regions, areaBands, directShare, corpShare, prevMonth: prev };
}

async function cheongyakSupply(key, months) {
  const first = `${months[0].slice(0, 4)}-${months[0].slice(4)}-01`;
  const url = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail' +
    `?page=1&perPage=1000&serviceKey=${keyParam(key)}&${encodeURIComponent('cond[RCRIT_PBLANC_DE::GTE]')}=${first}`;
  const json = JSON.parse(await fetchRetry(url));
  if (!Array.isArray(json.data)) throw new Error(friendlyError(json.msg || json.message || '응답 형식 오류'));
  const series = { 서울: {}, 경기: {}, 인천: {} };
  const counts = { 서울: 0, 경기: 0, 인천: 0 };
  for (const d of json.data) {
    const r = d.SUBSCRPT_AREA_CODE_NM;
    if (!series[r] || !d.RCRIT_PBLANC_DE) continue;
    const m = d.RCRIT_PBLANC_DE.slice(0, 7).replace('-', '');
    series[r][m] = (series[r][m] || 0) + (Number(d.TOT_SUPLY_HSHLDCO) || 0);
    counts[r]++;
  }
  return {
    regions: Object.keys(series).map((r) => ({ name: r, values: months.map((m) => series[r][m] || 0) })),
    notices: counts,
  };
}

const wrap = (p) => p.then((d) => ({ ok: true, ...d })).catch((e) => ({ ok: false, error: friendlyError(String(e && e.message || e)) }));

module.exports = async (req, res) => {
  const key = process.env.DATA_GO_KR_KEY;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!key) {
    res.status(200).send(JSON.stringify({ keyConfigured: false, updatedAt: new Date().toISOString() }));
    return;
  }

  const now = kstNow();
  const months = [];
  for (let i = MONTHS - 1; i >= 0; i--) months.push(ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));

  const [rt, cy] = await Promise.all([
    wrap(seoulTrades(key, months).then(({ results, failed, total }) => ({ ...aggregate(results, months), failedCalls: failed, totalCalls: total }))),
    wrap(cheongyakSupply(key, months)),
  ]);

  // 엣지 캐시 6시간: 25개 구 × 6개월 = 150회 호출이라 자주 새로 받지 않음. 실패한 결과는 1분만 저장
  res.setHeader('Cache-Control', rt.ok && cy.ok ? 's-maxage=21600, stale-while-revalidate=86400' : 's-maxage=60');
  res.status(200).send(JSON.stringify({
    keyConfigured: true,
    updatedAt: new Date().toISOString(),
    months,
    monthLabels: months.map(ymLabel),
    currentMonth: months[months.length - 1],
    trades: rt,
    cheongyak: cy,
  }));
};
