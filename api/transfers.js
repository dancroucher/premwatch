const API_BASE = 'https://api.premierleague.com/content/premierleague/playlist/EN';
const MASTER_PLAYLIST_ID = process.env.PL_TRANSFER_PLAYLIST_ID || '4658365';
const HEADERS = { Accept: 'application/json', Origin: 'https://www.premierleague.com', 'User-Agent': 'Premier-League-Transfers/1.0' };

function key(value) {
  return String(value || '').toLowerCase().replace(/afc/g, '').replace(/[^a-z0-9]/g, '')
    .replace(/^manutd$/, 'manchesterunited').replace(/^mancity$/, 'manchestercity').replace(/^spurs$/, 'tottenhamhotspur');
}

async function playlist(id) {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}?detail=DETAILED`, { cache: 'no-store', signal: AbortSignal.timeout(12000), headers: HEADERS });
  if (!response.ok) throw new Error(`Premier League transfers HTTP ${response.status}`);
  return response.json();
}

function clubName(title) {
  return String(title || '').replace(/^Summer 2026\s*-\s*Transfer Centre\s*-\s*/i, '').replace(/^AFC\s+/i, '').trim();
}

function transfer(item, club) {
  const promo = item && item.response || {};
  const tag = promo.tags && promo.tags[0] && promo.tags[0].label || '';
  return {
    id: promo.id,
    player: promo.title || '',
    detail: promo.description || '',
    type: tag,
    club,
    confirmedAt: promo.publishFrom ? new Date(promo.publishFrom).toISOString() : promo.date || '',
    link: promo.links && promo.links[0] && promo.links[0].promoUrl || ''
  };
}

export default async function handler(req, res) {
  try {
    const requested = key(req.query.club);
    const master = await playlist(MASTER_PLAYLIST_ID);
    const clubPlaylists = (master.items || []).map(item => item.response).filter(Boolean);
    const selected = requested ? clubPlaylists.filter(item => key(clubName(item.title)) === requested) : clubPlaylists;
    const results = await Promise.allSettled(selected.map(item => playlist(item.id)));
    const transfers = results.flatMap((result, index) => {
      if (result.status !== 'fulfilled') return [];
      const club = clubName(selected[index].title);
      return (result.value.items || []).map(item => transfer(item, club));
    }).filter(item => item.player && item.type);
    transfers.sort((a, b) => new Date(b.confirmedAt).getTime() - new Date(a.confirmedAt).getTime());
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=21600');
    res.status(200).json({ provider: 'Premier League Transfer Watch', transfers });
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: error.message || 'Transfer feed failed' });
  }
}
