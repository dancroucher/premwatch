const API_BASE = 'https://api.premierleague.com/content/premierleague/playlist/EN';
const MASTER_PLAYLIST_ID = process.env.PL_TRANSFER_PLAYLIST_ID || '4658365';
const HEADERS = { Accept: 'application/json', Origin: 'https://www.premierleague.com', 'User-Agent': 'Premier-League-Transfers/1.0' };
const PULSE_BASE = 'https://footballapi.pulselive.com/football';
const CLUB_IDS = {
  arsenal: 1, astonvilla: 2, bournemouth: 127, brentford: 130, brightonhovealbion: 131,
  chelsea: 4, coventrycity: 5, crystalpalace: 6, everton: 7, fulham: 34, hullcity: 41,
  ipswichtown: 8, leedsunited: 9, liverpool: 10, manchestercity: 11, manchesterunited: 12,
  newcastleunited: 23, nottinghamforest: 15, sunderland: 29, tottenhamhotspur: 21
};

function key(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/afc/g, '').replace(/[^a-z0-9]/g, '')
    .replace(/^manutd$/, 'manchesterunited').replace(/^mancity$/, 'manchestercity').replace(/^spurs$/, 'tottenhamhotspur');
}

async function playlist(id) {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}?detail=DETAILED`, { cache: 'no-store', signal: AbortSignal.timeout(12000), headers: HEADERS });
  if (!response.ok) throw new Error(`Premier League transfers HTTP ${response.status}`);
  return response.json();
}

async function playerIndex(club) {
  const teamId = CLUB_IDS[key(club)];
  if (!teamId) return new Map();
  const results = await Promise.allSettled(['841', '777'].map(season => fetch(`${PULSE_BASE}/players?comp=1&compSeasons=${season}&teams=${teamId}&page=0&pageSize=100&altIds=true`, { cache: 'no-store', signal: AbortSignal.timeout(12000), headers: HEADERS }).then(response => {
    if (!response.ok) throw new Error(`Player feed HTTP ${response.status}`);
    return response.json();
  })));
  const players = new Map();
  results.forEach(result => {
    if (result.status !== 'fulfilled') return;
    (result.value.content || []).forEach(player => {
      const name = player.name && player.name.display;
      if (name && player.id) players.set(key(name), player.id);
    });
  });
  return players;
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
    const [results, players] = await Promise.all([
      Promise.allSettled(selected.map(item => playlist(item.id))),
      selected.length === 1 ? playerIndex(clubName(selected[0].title)) : Promise.resolve(new Map())
    ]);
    const transfers = results.flatMap((result, index) => {
      if (result.status !== 'fulfilled') return [];
      const club = clubName(selected[index].title);
      return (result.value.items || []).map(item => transfer(item, club));
    }).filter(item => item.player && item.type).map(item => {
      const playerKey = key(item.player);
      const related = [...players.entries()].find(([name]) => name.startsWith(playerKey) || playerKey.startsWith(name));
      return { ...item, playerId: players.get(playerKey) || related && related[1] || null };
    });
    transfers.sort((a, b) => new Date(b.confirmedAt).getTime() - new Date(a.confirmedAt).getTime());
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=21600');
    res.status(200).json({ provider: 'Premier League Transfer Watch', transfers });
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: error.message || 'Transfer feed failed' });
  }
}
