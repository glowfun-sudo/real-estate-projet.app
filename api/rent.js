// Vercel Serverless Function: GET /api/rent
// 국토교통부 아파트 전월세 실거래가 자료 — 서울 25개 구 × 최근 6개월
// 전세(월세 0) 3.3㎡당 중위 보증금, 중위 보증금, 월세 비중, 권역별 전세 3.3㎡당 중위 보증금
// 공공데이터포털 인증키: DATA_GO_KR_KEY

const SEOUL_GU = [
  ['11110', '도심권'], ['11140', '도심권'], ['11170', '도심권'],
  ['11200', '동북권'], ['11215', '동북권'], ['11230', '동북권'], ['11260', '동북권'], ['11290', '동북권'],
  ['11305', '동북권'], ['11320', '동북권'], ['11350', '동북권'],
  ['11380', '서북권'], ['11410', '서북권'], ['11440', '서북권'],
  ['11470', '서남권'], ['11500', '서남권'], ['11530', '서남권'], ['11545', '서남권'], ['11560', '서남권'],
  ['11590', '서남권'], ['11620', '서남권'],
  ['11650', '동남권'], ['11680', '동남권'], ['11710', '동남권'], ['11740', '동남권'],
];
const REGIONS = ['도심권', '동북권', '서북권', '서남권', '동남권'];
const MONTHS = 6;
const PAGE = 1000;

const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const keyParam = (k) => (/%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k));
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const ym = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

function friendlyError(msg = '') {
  if (/SERVICE_KEY_IS_NOT_REGISTERED/.test(msg)) return '인증키에 아파트 전월세 실거래가 자료 활용신청(또는 승인 반영)이 필요합니다';
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/.test(msg)) return '공공데이터포털 호출 한도 초과 (잠시 후 다시 시도)';
  return msg;
}

async function fetchText(url, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`);
    return text;
  } finally { clearTimeout(t); }
}

async function page(key, lawd, month, no) {
  const url = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent' +
    `?serviceKey=${keyParam(key)}&LAWD_CD=${lawd}&DEAL_YMD=${month}&pageNo=${no}&numOfRows=${PAGE}`;
  let xml;
  try { xml = await fetchText(url); } catch (e) { await new Promise((r) => setTimeout(r, 800)); xml = await fetchText(url); }
  const code = tag(xml, 'resultCode');
  if (code && !['000', '00'].includes(code)) throw new Error(`${code} ${tag(xml, 'resultMsg')}`);
  const rows = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => ({
    deposit: Number(tag(it, 'deposit').replace(/,/g, '')) || 0, // 만원
    rent: Number(tag(it, 'monthlyRent').replace(/,/g, '')) || 0, // 만원
    area: Number(tag(it, 'excluUseAr')) || 0,
  })).filter((r) => r.deposit || r.rent);
  return { rows, total: Number(tag(xml, 'totalCount')) || rows.length };
}

async function rentsFor(key, lawd, month) {
  const first = await page(key, lawd, month, 1);
  const rows = [...first.rows];
  const pages = Math.ceil(first.total / PAGE);
  for (let p = 2; p <= pages; p++) rows.push(...(await page(key, lawd, month, p)).rows);
  return rows;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) { res.status(200).send(JSON.stringify({ ok: false, error: 'NO_KEY' })); return; }

  const now = kstNow();
  const months = [];
  for (let i = MONTHS - 1; i >= 0; i--) months.push(ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));

  try {
    try { await page(key, SEOUL_GU[0][0], months[months.length - 1], 1); }
    catch (e) { throw new Error(friendlyError(e.message)); }

    const tasks = [];
    for (const [code, region] of SEOUL_GU) for (const m of months) tasks.push({ code, region, m });
    const jeonse = Object.fromEntries(months.map((m) => [m, []]));
    const jeonseRegion = Object.fromEntries(REGIONS.map((r) => [r, Object.fromEntries(months.map((m) => [m, []]))]));
    const counts = Object.fromEntries(months.map((m) => [m, { total: 0, wolse: 0 }]));
    let failed = 0;

    for (let i = 0; i < tasks.length; i += 8) {
      const batch = tasks.slice(i, i + 8);
      const res2 = await Promise.allSettled(batch.map((t) => rentsFor(key, t.code, t.m).then((rows) => ({ ...t, rows }))));
      for (const r of res2) {
        if (r.status !== 'fulfilled') { failed++; continue; }
        const { m, region, rows } = r.value;
        for (const x of rows) {
          counts[m].total++;
          if (x.rent > 0) { counts[m].wolse++; continue; }
          if (!x.area) continue;
          const pp = Math.round((x.deposit / x.area) * 3.3058);
          jeonse[m].push({ deposit: x.deposit, pp });
          jeonseRegion[region][m].push(pp);
        }
      }
    }
    if (failed === tasks.length) throw new Error('전월세 실거래가 조회 실패');

    res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400');
    res.status(200).send(JSON.stringify({
      ok: true,
      updatedAt: new Date().toISOString(),
      months,
      jeonsePerPyeong: months.map((m) => median(jeonse[m].map((x) => x.pp))),
      jeonseMedianDeposit: months.map((m) => median(jeonse[m].map((x) => x.deposit))),
      jeonseCount: months.map((m) => jeonse[m].length),
      wolseShare: months.map((m) => (counts[m].total ? Math.round((counts[m].wolse / counts[m].total) * 1000) / 10 : null)),
      totalCount: months.map((m) => counts[m].total),
      regions: REGIONS.map((r) => ({ name: r, values: months.map((m) => median(jeonseRegion[r][m])) })),
      failedCalls: failed, totalCalls: tasks.length,
    }));
  } catch (e) {
    res.status(200).send(JSON.stringify({ ok: false, error: friendlyError(String(e && e.message || e)) }));
  }
};
