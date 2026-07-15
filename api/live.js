const API_BASE = 'https://v3.football.api-sports.io';
const PREMIER_LEAGUE_ID = process.env.APIFOOTBALL_LEAGUE || '39';
const PREMIER_LEAGUE_SEASON = process.env.APIFOOTBALL_SEASON || '2026';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dayISO(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

async function api(path) {
  const key = process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) {
    const error = new Error('APIFOOTBALL_KEY missing');
    error.status = 503;
    throw error;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: { 'x-apisports-key': key }
  });
  const data = await response.json().catch(() => ({}));
  const apiErrors = data && data.errors && Object.values(data.errors).filter(Boolean);
  if (!response.ok || (apiErrors && apiErrors.length)) {
    const error = new Error(apiErrors && apiErrors.length ? apiErrors.join('; ') : (data.message || `API-Football HTTP ${response.status}`));
    error.status = response.ok ? 502 : response.status;
    throw error;
  }
  return data;
}

function normaliseStatus(short) {
  if (['NS', 'TBD'].includes(short)) return 'NS';
  return short || 'NS';
}

function normaliseFixture(item) {
  return {
    idEvent: `af:${item.fixture.id}`,
    apiFootballFixtureId: item.fixture.id,
    strSource: 'api-football',
    strTimestamp: item.fixture.date,
    dateEvent: (item.fixture.date || '').slice(0, 10),
    strRound: item.league && item.league.round,
    strHomeTeam: item.teams.home.name,
    strAwayTeam: item.teams.away.name,
    idHomeTeam: item.teams.home.id,
    idAwayTeam: item.teams.away.id,
    strHomeBadge: item.teams.home.logo,
    strAwayBadge: item.teams.away.logo,
    intHomeScore: item.goals.home == null ? null : String(item.goals.home),
    intAwayScore: item.goals.away == null ? null : String(item.goals.away),
    strStatus: normaliseStatus(item.fixture.status.short),
    strStatusLong: item.fixture.status.long,
    strProgress: item.fixture.status.elapsed == null ? '' : String(item.fixture.status.elapsed),
    strVenue: item.fixture.venue && item.fixture.venue.name,
    strCity: item.fixture.venue && item.fixture.venue.city,
    strReferee: item.fixture.referee
  };
}

function normaliseTimeline(event) {
  return {
    strTimeline: event.type || '',
    strTimelineDetail: event.detail || '',
    intTime: event.time && event.time.extra ? `${event.time.elapsed}+${event.time.extra}` : String((event.time && event.time.elapsed) || ''),
    strTeam: event.team && event.team.name,
    strPlayer: event.player && event.player.name,
    strAssist: event.assist && event.assist.name
  };
}

function normaliseStat(stat) {
  return {
    strStat: stat.type,
    intHome: stat.home == null ? '' : String(stat.home),
    intAway: stat.away == null ? '' : String(stat.away)
  };
}

async function fixtures() {
  const data = await api(`/fixtures?league=${PREMIER_LEAGUE_ID}&season=${PREMIER_LEAGUE_SEASON}`);
  return { events: (data.response || []).map(normaliseFixture) };
}

async function feed() {
  const from = dayISO(-1);
  const to = dayISO(1);
  const data = await api(`/fixtures?league=${PREMIER_LEAGUE_ID}&season=${PREMIER_LEAGUE_SEASON}&from=${from}&to=${to}`);
  return { events: (data.response || []).map(normaliseFixture) };
}

async function standings() {
  const data = await api(`/standings?league=${PREMIER_LEAGUE_ID}&season=${PREMIER_LEAGUE_SEASON}`);
  const league = (data.response || [])[0] && data.response[0].league;
  const rows = league && league.standings && league.standings[0] || [];
  return {
    standings: rows.map(row => ({
      rank: row.rank,
      teamId: row.team.id,
      team: row.team.name,
      crest: row.team.logo,
      played: row.all.played,
      won: row.all.win,
      drawn: row.all.draw,
      lost: row.all.lose,
      goalsFor: row.all.goals.for,
      goalsAgainst: row.all.goals.against,
      goalDifference: row.goalsDiff,
      points: row.points,
      form: row.form || '',
      description: row.description || ''
    }))
  };
}

async function detail(id) {
  if (!id) return { events: [], timeline: [], eventstats: [] };
  const encodedId = encodeURIComponent(id);
  const [fixture, events, stats] = await Promise.all([
    api(`/fixtures?id=${encodedId}`),
    api(`/fixtures/events?fixture=${encodedId}`),
    api(`/fixtures/statistics?fixture=${encodedId}`)
  ]);
  const event = (fixture.response || [])[0] ? normaliseFixture(fixture.response[0]) : null;
  const timeline = (events.response || []).map(normaliseTimeline);
  const home = (stats.response || [])[0] || { statistics: [] };
  const away = (stats.response || [])[1] || { statistics: [] };
  const names = new Set([...(home.statistics || []), ...(away.statistics || [])].map(value => value.type));
  const eventstats = [...names].map(type => normaliseStat({
    type,
    home: (home.statistics || []).find(value => value.type === type)?.value,
    away: (away.statistics || []).find(value => value.type === type)?.value
  }));
  return { events: event ? [event] : [], timeline, eventstats };
}

export default async function handler(req, res) {
  try {
    const type = req.query.type || 'feed';
    let body;
    if (type === 'fixtures') body = await fixtures();
    else if (type === 'standings') body = await standings();
    else if (type === 'detail') body = await detail(req.query.id);
    else body = await feed();

    const cache = type === 'fixtures'
      ? 's-maxage=3600, stale-while-revalidate=21600'
      : type === 'standings'
        ? 's-maxage=60, stale-while-revalidate=300'
        : type === 'detail'
          ? 's-maxage=10, stale-while-revalidate=10'
          : 's-maxage=20, stale-while-revalidate=30';
    res.setHeader('Cache-Control', cache);
    res.status(200).json(body);
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(error.status || 500).json({ error: error.message || 'API-Football failed' });
  }
}
