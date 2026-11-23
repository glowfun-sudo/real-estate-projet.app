// Vercel Serverless Function: GET /api/applystat
// 한국부동산원 청약홈 청약 신청·당첨자 정보 조회 서비스 (ApplyhomeStatSvc)
//  - 지역별 청약 경쟁률 (getAPTCmpetrtAreaStat)
//  - 지역별 가점제 당첨자 가점 (getAPTApsPrzwnerStat)
//  - 지역별·연령대별 신청자 / 당첨자 (getAPTReqstAreaStat / getAPTPrzwnerAreaStat)
// 모두 월 단위 통계(STAT_DE = YYYYMM). 공공데이터포털 인증키: DATA_GO_KR_KEY

const METRO = ['서울', '경기', '인천'];
const MONTHS = 12;
const keyParam = (k) => (/%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k));

async function op(key, name) {
  const url = `https://api.odcloud.kr/api/ApplyhomeStatSvc/v1/${name}?page=1&perPage=2000&serviceKey=${keyParam(key)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const json = JSON.parse(await r.text());
    if (!Array.isArray(json.data)) throw new Error(json.msg || `HTTP ${r.status}`);
    return json.data;
  } finally { clearTimeout(t); }
}

const num = (v) => {
  // 경쟁률 "(△22)"는 미달(공급보다 22세대 적게 신청) → null
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) { res.status(200).send(JSON.stringify({ ok: false, error: 'NO_KEY' })); return; }

  try {
    const [cmpet, aps, reqst, przwner] = await Promise.all([
      op(key, 'getAPTCmpetrtAreaStat'),
      op(key, 'getAPTApsPrzwnerStat'),
      op(key, 'getAPTReqstAreaStat'),
      op(key, 'getAPTPrzwnerAreaStat'),
    ]);

    // 최신 통계월 기준 최근 12개월
    const allMonths = [...new Set(cmpet.map((d) => d.STAT_DE))].sort();
    const months = allMonths.slice(-MONTHS);
    const latest = months[months.length - 1];

    // 1) 수도권 지역별 월별 일반공급 경쟁률 (신청 건수 ÷ 공급 세대수로 직접 계산 → 미달도 수치로)
    const competition = METRO.map((r) => ({
      name: r,
      values: months.map((m) => {
        const d = cmpet.find((x) => x.STAT_DE === m && x.SUBSCRPT_AREA_CODE_NM === r);
        if (!d || !d.SUPLY_HSHLDCO) return null;
        return round2(d.SUPLY_REQ_CNT / d.SUPLY_HSHLDCO);
      }),
      supply: months.map((m) => {
        const d = cmpet.find((x) => x.STAT_DE === m && x.SUBSCRPT_AREA_CODE_NM === r);
        return d ? d.SUPLY_HSHLDCO : 0;
      }),
      requests: months.map((m) => {
        const d = cmpet.find((x) => x.STAT_DE === m && x.SUBSCRPT_AREA_CODE_NM === r);
        return d ? d.SUPLY_REQ_CNT : 0;
      }),
    }));

    // 최근 12개월 전국 경쟁률 상위 지역
    const byRegion = {};
    for (const d of cmpet.filter((x) => months.includes(x.STAT_DE))) {
      const r = d.SUBSCRPT_AREA_CODE_NM;
      byRegion[r] = byRegion[r] || { supply: 0, req: 0 };
      byRegion[r].supply += d.SUPLY_HSHLDCO || 0;
      byRegion[r].req += d.SUPLY_REQ_CNT || 0;
    }
    const regionRank = Object.entries(byRegion)
      .filter(([, v]) => v.supply)
      .map(([name, v]) => ({ name, supply: v.supply, requests: v.req, rate: round2(v.req / v.supply) }))
      .sort((a, b) => b.rate - a.rate);

    // 2) 가점제 당첨 가점 (해당지역): 수도권 월별 평균, 최근월 상세
    const apsRows = aps.filter((d) => d.RESIDE_SECD_NM === '해당지역');
    const apsMonths = [...new Set(apsRows.map((d) => d.STAT_DE))].sort().slice(-MONTHS);
    const scores = METRO.map((r) => ({
      name: r,
      avg: apsMonths.map((m) => { const d = apsRows.find((x) => x.STAT_DE === m && x.SUBSCRPT_AREA_CODE_NM === r); return d ? num(d.AVRG_SCORE) : null; }),
    }));
    // 최근 12개월 중 가장 최근에 수치가 있는 달 기준 상세
    const scoreLatest = METRO.map((r) => {
      const rows = apsRows.filter((x) => x.SUBSCRPT_AREA_CODE_NM === r && apsMonths.includes(x.STAT_DE)).sort((a, b) => b.STAT_DE.localeCompare(a.STAT_DE));
      const d = rows[0];
      return d ? { name: r, month: d.STAT_DE, avg: num(d.AVRG_SCORE), median: num(d.MED_SCORE), top: num(d.TOP_SCORE), lowest: num(d.LWET_SCORE) } : { name: r, month: null };
    });

    // 3) 연령대별 신청자·당첨자 (수도권 합계, 최근 12개월 누계)
    const ageKeys = ['AGE_30', 'AGE_40', 'AGE_50', 'AGE_60'];
    const sumAges = (rows) => ageKeys.map((k) => rows.reduce((s, d) => s + (d[k] || 0), 0));
    const inWindow = (rows) => rows.filter((d) => months.includes(d.STAT_DE) && METRO.includes(d.SUBSCRPT_AREA_CODE_NM));
    const ages = {
      labels: ['30대 이하', '40대', '50대', '60대 이상'],
      applicants: sumAges(inWindow(reqst)),
      winners: sumAges(inWindow(przwner)),
    };

    res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400');
    res.status(200).send(JSON.stringify({
      ok: true,
      updatedAt: new Date().toISOString(),
      months, latest, apsMonths,
      competition, regionRank, scores, scoreLatest, ages,
    }));
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(200).send(JSON.stringify({ ok: false, error: /인증키/.test(msg) ? '인증키에 청약 신청·당첨자 정보 조회 서비스 활용신청이 필요합니다' : msg }));
  }
};
