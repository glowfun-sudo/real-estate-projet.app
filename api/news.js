// Vercel Serverless Function: GET /api/news
// 한국부동산원·네이버·주요 언론의 수도권 부동산 뉴스를 모아 JSON으로 돌려줍니다.
// - 기본: Google 뉴스 RSS (키 불필요)
// - 선택: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 있으면 네이버 뉴스 검색 API 추가

const FEEDS = [
  { category: 'reb', label: '한국부동산원', query: '한국부동산원 아파트' },
  { category: 'market', label: '매매·시장', query: '수도권 아파트 매매가격' },
  { category: 'finance', label: '금융·대출', query: '주택담보대출 금리 DSR' },
  { category: 'rent', label: '전월세', query: '아파트 전세가격 수도권' },
  { category: 'supply', label: '공급·정책', query: '주택 공급 인허가 국토교통부' },
];

const NAVER_QUERIES = [
  { category: 'naver', label: '네이버 뉴스', query: '수도권 아파트' },
  { category: 'naver', label: '네이버 뉴스', query: '한국부동산원 주간 아파트' },
];

const decode = (s = '') =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
};

const isoDate = (v) => {
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
};

const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : null);

function parseGoogleRss(xml, feed) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map((it) => {
    let title = decode(tag(it, 'title'));
    const source = decode(tag(it, 'source'));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return {
      title,
      url: safeUrl(decode(tag(it, 'link'))),
      source: source || 'Google 뉴스',
      publishedAt: isoDate(decode(tag(it, 'pubDate'))),
      category: feed.category,
      categoryLabel: feed.label,
    };
  });
}

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fromGoogle(feed) {
  const q = encodeURIComponent(`${feed.query} when:7d`);
  const xml = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (weekly-market-dashboard)' },
  });
  return parseGoogleRss(xml, feed).slice(0, 8);
}

async function fromNaver(feed, id, secret) {
  const q = encodeURIComponent(feed.query);
  const text = await fetchText(
    `https://openapi.naver.com/v1/search/news.json?query=${q}&display=10&sort=date`,
    { headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret } }
  );
  const json = JSON.parse(text);
  return (json.items || []).map((it) => {
    let host = '네이버 뉴스';
    try { host = new URL(it.originallink || it.link).hostname.replace(/^www\./, ''); } catch {}
    return {
      title: decode(it.title),
      url: safeUrl(it.link) || safeUrl(it.originallink),
      source: host,
      publishedAt: isoDate(it.pubDate),
      category: feed.category,
      categoryLabel: feed.label,
    };
  });
}

module.exports = async (req, res) => {
  const jobs = FEEDS.map((f) => fromGoogle(f));
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  const naverEnabled = Boolean(id && secret);
  if (naverEnabled) NAVER_QUERIES.forEach((f) => jobs.push(fromNaver(f, id, secret)));

  const results = await Promise.allSettled(jobs);
  const errors = [];
  const seen = new Set();
  const items = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      errors.push(`${i < FEEDS.length ? FEEDS[i].label : '네이버'}: ${r.reason && r.reason.message}`);
      return;
    }
    for (const it of r.value) {
      if (!it.url || !it.title) continue;
      const key = it.title.replace(/\s+/g, '').slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  });

  items.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 엣지 캐시 10분, 만료 후 1시간까지는 이전 결과를 보여주며 백그라운드 갱신
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  res.status(items.length ? 200 : 502).send(
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      naverEnabled,
      count: items.length,
      items: items.slice(0, 60),
      errors,
    })
  );
};
