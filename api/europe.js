const UEFA_BASE = 'https://match.uefa.com/v5';
const SEASON_YEAR = process.env.UEFA_SEASON_YEAR || '2027';
const COMPETITIONS = [
  { id: '1', code: 'UCL', name: 'Champions League' },
  { id: '14', code: 'UEL', name: 'Europa League' },
  { id: '2019', code: 'UECL', name: 'Conference League' }
];

function pad2(value) { return String(value).padStart(2, '0'); }
function dateISO(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

async function uefa(path) {
  const response = await fetch(`${UEFA_BASE}${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
    headers: { Accept: 'application/json', 'User-Agent': 'Premier-League-Europe-Fixtures/1.0' }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`UEFA HTTP ${response.status}`);
  return data;
}

function status(match) {
  const value = String(match.status || '').toUpperCase();
  if (value === 'FINISHED') return 'FT';
  if (['LIVE', 'PLAYING', 'IN_PROGRESS'].includes(value)) return 'LIVE';
  if (['HALF_TIME', 'HALFTIME'].includes(value)) return 'HT';
  if (value.includes('POSTPON')) return 'PST';
  if (value.includes('CANCEL')) return 'CANC';
  return 'NS';
}

function competitionFor(match) {
  const id = String(match.competition && match.competition.id || '');
  return COMPETITIONS.find(item => item.id === id) || {
    id,
    code: match.competition && match.competition.code || 'UEFA',
    name: match.competition && match.competition.metaData && match.competition.metaData.name || 'European competition'
  };
}

function matchMinute(match) {
  if (typeof match.minute === 'number' || typeof match.minute === 'string') return String(match.minute);
  if (match.minute && match.minute.normal != null) return String(match.minute.normal);
  if (match.minute && match.minute.display != null) return String(match.minute.display);
  return '';
}

function fixture(match) {
  const competition = competitionFor(match);
  const score = match.score && (match.score.total || match.score.regular) || {};
  const isStarted = status(match) !== 'NS';
  const stadium = match.stadium || {};
  const city = stadium.city && stadium.city.translations && stadium.city.translations.name && stadium.city.translations.name.EN;
  return {
    idEvent: `uefa:${match.id}`,
    providerFixtureId: `uefa:${match.id}`,
    strSource: 'uefa',
    isEuropean: true,
    strCompetition: competition.name,
    strCompetitionCode: competition.code,
    strTimestamp: match.kickOffTime && match.kickOffTime.dateTime || '',
    dateEvent: match.kickOffTime && match.kickOffTime.date || '',
    strRound: match.round && match.round.metaData && match.round.metaData.name || match.matchday && match.matchday.longName || '',
    strHomeTeam: match.homeTeam && match.homeTeam.internationalName,
    strAwayTeam: match.awayTeam && match.awayTeam.internationalName,
    idHomeTeam: match.homeTeam && match.homeTeam.id,
    idAwayTeam: match.awayTeam && match.awayTeam.id,
    strHomeBadge: match.homeTeam && match.homeTeam.logoUrl,
    strAwayBadge: match.awayTeam && match.awayTeam.logoUrl,
    intHomeScore: isStarted && score.home != null ? String(score.home) : null,
    intAwayScore: isStarted && score.away != null ? String(score.away) : null,
    strStatus: status(match),
    strStatusLong: match.status || '',
    strProgress: matchMinute(match),
    strVenue: stadium.translations && stadium.translations.name && stadium.translations.name.EN || '',
    strCity: city || ''
  };
}

async function competitionMatches(competition, from, to) {
  const query = `competitionId=${competition.id}&seasonYear=${SEASON_YEAR}&fromDate=${from}&toDate=${to}&order=ASC&limit=500&offset=0`;
  const data = await uefa(`/matches?${query}`);
  return (Array.isArray(data) ? data : []).map(fixture);
}

async function matches(from, to) {
  const results = await Promise.allSettled(COMPETITIONS.map(competition => competitionMatches(competition, from, to)));
  const events = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  if (!events.length && results.every(result => result.status === 'rejected')) throw new Error('UEFA feeds unavailable');
  return { events, provider: 'UEFA' };
}

function lineupTeam(side) {
  if (!side) return null;
  const player = entry => ({
    id: entry.player && entry.player.id,
    name: entry.player && entry.player.internationalName || '',
    shirtNumber: entry.jerseyNumber || '',
    position: entry.player && entry.player.fieldPosition || '',
    captain: !!entry.captain
  });
  return {
    teamId: side.team && side.team.id,
    team: side.team && side.team.internationalName || '',
    crest: side.team && side.team.logoUrl || '',
    formation: '',
    starters: (side.field || []).map(player),
    substitutes: (side.bench || []).filter(entry => entry.type !== 'STAFF').map(player)
  };
}

async function lineup(rawId) {
  const id = String(rawId || '').replace(/^uefa:/, '');
  if (!id) return { confirmed: false, lineups: [] };
  const data = await uefa(`/matches/${encodeURIComponent(id)}/lineups`);
  const lineups = [lineupTeam(data.homeTeam), lineupTeam(data.awayTeam)].filter(Boolean);
  return { confirmed: lineups.length === 2 && lineups.every(team => team.starters.length === 11), lineups };
}

async function lineups(rawIds) {
  const ids = String(rawIds || '').split(',').filter(Boolean).slice(0, 10);
  const results = await Promise.allSettled(ids.map(id => lineup(id)));
  const lineupsById = {};
  results.forEach((result, index) => {
    lineupsById[ids[index]] = result.status === 'fulfilled' ? result.value : { confirmed: false, lineups: [] };
  });
  return { lineupsById };
}

function eventRows(match) {
  const groups = match.playerEvents || {};
  const rows = [];
  for (const [kind, events] of Object.entries(groups)) {
    for (const event of Array.isArray(events) ? events : []) {
      const player = event.player || event.scorer || {};
      rows.push({
        strTimeline: /goal/i.test(kind) ? 'Goal' : /card/i.test(kind) ? 'Card' : kind,
        strTimelineDetail: kind,
        intTime: event.time && (event.time.minute || event.time) || event.minute || '',
        strTeam: event.team && event.team.internationalName || '',
        strPlayer: player.internationalName || '',
        strAssist: event.assist && event.assist.internationalName || ''
      });
    }
  }
  return rows;
}

async function detail(rawId) {
  const id = String(rawId || '').replace(/^uefa:/, '');
  if (!id) return { events: [], timeline: [], eventstats: [], lineups: { confirmed: false, lineups: [] } };
  const [match, teams] = await Promise.all([
    uefa(`/matches/${encodeURIComponent(id)}`),
    lineup(id).catch(() => ({ confirmed: false, lineups: [] }))
  ]);
  return { provider: 'UEFA', events: [fixture(match)], timeline: eventRows(match), eventstats: [], lineups: teams };
}

export default async function handler(req, res) {
  try {
    const type = req.query.type || 'fixtures';
    let body;
    if (type === 'feed') body = await matches(dateISO(-1), dateISO(1));
    else if (type === 'detail') body = await detail(req.query.id);
    else if (type === 'lineups') body = await lineups(req.query.ids);
    else body = await matches('2026-07-01', '2027-06-30');

    const cache = type === 'fixtures'
      ? 's-maxage=1800, stale-while-revalidate=21600'
      : type === 'feed'
        ? 's-maxage=15, stale-while-revalidate=15'
        : type === 'lineups'
          ? 's-maxage=20, stale-while-revalidate=20'
          : 's-maxage=10, stale-while-revalidate=10';
    res.setHeader('Cache-Control', cache);
    res.status(200).json(body);
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: error.message || 'UEFA feed failed' });
  }
}
