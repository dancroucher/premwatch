const ALLOWED_ENDPOINTS = new Set([
  'eventsseason.php',
  'eventsday.php',
  'lookupevent.php',
  'lookuptimeline.php',
  'lookupeventstats.php',
  'searchevents.php'
]);

function cacheSeconds(endpoint) {
  if (endpoint === 'eventsseason.php') return 60 * 60;
  if (endpoint === 'eventsday.php') return 30;
  if (endpoint === 'lookupevent.php') return 5;
  if (endpoint === 'lookuptimeline.php') return 5;
  if (endpoint === 'lookupeventstats.php') return 60;
  if (endpoint === 'searchevents.php') return 24 * 60 * 60;
  return 60;
}

function staleSeconds(endpoint) {
  if (endpoint === 'lookupevent.php') return 0;
  if (endpoint === 'lookuptimeline.php') return 0;
  if (endpoint === 'eventsday.php') return 60;
  return 600;
}

export default async function handler(req, res) {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  const endpoint = path.split('?')[0];

  if (!path || !ALLOWED_ENDPOINTS.has(endpoint) || path.includes('://') || path.includes('..')) {
    res.status(400).json({ error: 'Unsupported feed path' });
    return;
  }

  const key = process.env.THESPORTSDB_KEY || '3';
  const upstream = `https://www.thesportsdb.com/api/v1/json/${key}/${path}`;

  try {
    const upstreamRes = await fetch(upstream, {
      cache: ['lookupevent.php', 'lookuptimeline.php'].includes(endpoint) ? 'no-store' : 'default',
      headers: { 'User-Agent': 'Premier League 2026-27 Fixtures/1.0' }
    });
    const text = await upstreamRes.text();

    if (upstreamRes.status === 429) {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      res.setHeader('Retry-After', upstreamRes.headers.get('Retry-After') || '300');
      res.status(429).send(text || 'rate limited');
      return;
    }

    res.setHeader('Content-Type', upstreamRes.headers.get('Content-Type') || 'application/json');
    res.setHeader('Cache-Control', `s-maxage=${cacheSeconds(endpoint)}, stale-while-revalidate=${staleSeconds(endpoint)}`);
    res.status(upstreamRes.status).send(text);
  } catch (err) {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
    res.status(502).json({ error: 'Feed proxy failed' });
  }
}
