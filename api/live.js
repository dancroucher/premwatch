const PULSE_BASE = 'https://footballapi.pulselive.com/football';
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1';
const COMPETITION_ID = '1';
const SEASON_ID = process.env.PREMIER_LEAGUE_SEASON_ID || '841';
const EXPECTED_FIXTURES = 380;

const PULSE_HEADERS = {
  Accept: 'application/json',
  Origin: 'https://www.premierleague.com',
  Referer: 'https://www.premierleague.com/',
  'User-Agent': 'Mozilla/5.0 (compatible; Premier-League-Fixtures/1.0)'
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dayISO(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
}

async function getJSON(url, headers = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers,
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Upstream HTTP ${response.status}`);
    error.status = 502;
    throw error;
  }
  return data;
}

function pulse(path) {
  return getJSON(`${PULSE_BASE}${path}`, PULSE_HEADERS);
}

function espn(path) {
  return getJSON(`${ESPN_BASE}${path}`, { Accept: 'application/json', 'User-Agent': PULSE_HEADERS['User-Agent'] });
}

function pulseCrest(team) {
  const opta = team && team.altIds && team.altIds.opta;
  return opta ? `https://resources.premierleague.com/premierleague/badges/100/${opta}.png` : '';
}

function pulseStatus(fixture) {
  if (fixture.status === 'C') return 'FT';
  if (fixture.status === 'U') return 'NS';
  if (fixture.status === 'P') return 'PST';
  if (fixture.status === 'L') {
    const phase = String(fixture.phase || '').toUpperCase();
    if (['H', 'HT'].includes(phase)) return 'HT';
    if (phase === '1') return '1H';
    if (phase === '2') return '2H';
    return 'LIVE';
  }
  return fixture.status || 'NS';
}

function pulseFixture(fixture) {
  const home = fixture.teams && fixture.teams[0] || {};
  const away = fixture.teams && fixture.teams[1] || {};
  const homeTeam = home.team || {};
  const awayTeam = away.team || {};
  return {
    idEvent: `pulse:${fixture.id}`,
    providerFixtureId: `pulse:${fixture.id}`,
    strSource: 'premier-league',
    strTimestamp: fixture.kickoff && fixture.kickoff.millis ? new Date(fixture.kickoff.millis).toISOString() : '',
    dateEvent: fixture.kickoff && fixture.kickoff.millis ? new Date(fixture.kickoff.millis).toISOString().slice(0, 10) : '',
    strRound: fixture.gameweek && fixture.gameweek.gameweek ? `Matchweek ${fixture.gameweek.gameweek}` : '',
    strHomeTeam: homeTeam.name,
    strAwayTeam: awayTeam.name,
    idHomeTeam: homeTeam.id,
    idAwayTeam: awayTeam.id,
    strHomeBadge: pulseCrest(homeTeam),
    strAwayBadge: pulseCrest(awayTeam),
    intHomeScore: home.score == null ? null : String(home.score),
    intAwayScore: away.score == null ? null : String(away.score),
    strStatus: pulseStatus(fixture),
    strStatusLong: fixture.status === 'C' ? 'Full Time' : fixture.status === 'L' ? 'Live' : 'Scheduled',
    strProgress: fixture.clock && fixture.clock.label ? String(fixture.clock.label).replace(/'00$/, '').replace("'", '') : '',
    strVenue: fixture.ground && fixture.ground.name,
    strCity: fixture.ground && fixture.ground.city,
    strReferee: fixture.matchOfficials && fixture.matchOfficials[0] && fixture.matchOfficials[0].name && fixture.matchOfficials[0].name.display
  };
}

function espnStatus(competition) {
  const status = competition && competition.status;
  const type = status && status.type || {};
  if (type.completed || type.name === 'STATUS_FINAL') return 'FT';
  if (type.name === 'STATUS_HALFTIME') return 'HT';
  if (type.state === 'in') return 'LIVE';
  if (String(type.name || '').includes('POSTPONED')) return 'PST';
  if (String(type.name || '').includes('CANCELED')) return 'CANC';
  return 'NS';
}

function espnFixture(event) {
  const competition = event.competitions && event.competitions[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find(item => item.homeAway === 'home') || competitors[0] || {};
  const away = competitors.find(item => item.homeAway === 'away') || competitors[1] || {};
  const status = espnStatus(competition);
  const score = item => status === 'NS' ? null : (item.score == null ? null : String(item.score));
  return {
    idEvent: `espn:${event.id}`,
    providerFixtureId: `espn:${event.id}`,
    strSource: 'espn',
    strTimestamp: event.date,
    dateEvent: (event.date || '').slice(0, 10),
    strRound: event.week && event.week.number ? `Matchweek ${event.week.number}` : '',
    strHomeTeam: home.team && home.team.displayName,
    strAwayTeam: away.team && away.team.displayName,
    idHomeTeam: home.team && home.team.id,
    idAwayTeam: away.team && away.team.id,
    strHomeBadge: home.team && home.team.logo,
    strAwayBadge: away.team && away.team.logo,
    intHomeScore: score(home),
    intAwayScore: score(away),
    strStatus: status,
    strStatusLong: competition.status && competition.status.type && competition.status.type.description,
    strProgress: competition.status && competition.status.displayClock || '',
    strVenue: competition.venue && competition.venue.fullName,
    strCity: competition.venue && competition.venue.address && competition.venue.address.city
  };
}

function validSeason(events) {
  if (events.length !== EXPECTED_FIXTURES) return false;
  const ids = new Set(events.map(event => event.idEvent));
  const clubs = new Set(events.flatMap(event => [event.strHomeTeam, event.strAwayTeam]));
  return ids.size === EXPECTED_FIXTURES && clubs.size === 20 && events.every(event => event.strHomeTeam && event.strAwayTeam && event.strTimestamp);
}

async function pulseFixtures() {
  const query = `comp=${COMPETITION_ID}&compSeasons=${SEASON_ID}&page=0&pageSize=500&sort=asc&altIds=true`;
  const data = await pulse(`/fixtures?${query}`);
  return (data.content || []).map(pulseFixture);
}

async function espnFixtures() {
  const data = await espn('/scoreboard?dates=20260801-20270531&limit=1000');
  return (data.events || []).map(espnFixture);
}

function fixtureTeamKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^afcbournemouth$/, 'bournemouth');
}

function fixturePairKey(event) {
  return `${fixtureTeamKey(event.strHomeTeam)}|${fixtureTeamKey(event.strAwayTeam)}`;
}

function compareSeasons(primary, secondary) {
  const secondaryByPair = new Map(secondary.map(event => [fixturePairKey(event), event]));
  let missing = 0;
  let kickoffDifferences = 0;
  for (const event of primary) {
    const other = secondaryByPair.get(fixturePairKey(event));
    if (!other) { missing++; continue; }
    if (Math.abs(new Date(event.strTimestamp).getTime() - new Date(other.strTimestamp).getTime()) > 60000) kickoffDifferences++;
  }
  return { secondary: 'ESPN', checked: primary.length, missing, kickoffDifferences, matched: missing === 0 && kickoffDifferences === 0 };
}

async function fixtures() {
  const [pulseResult, espnResult] = await Promise.allSettled([pulseFixtures(), espnFixtures()]);
  const premierLeagueEvents = pulseResult.status === 'fulfilled' ? pulseResult.value : [];
  const espnEvents = espnResult.status === 'fulfilled' ? espnResult.value : [];
  const premierLeagueValid = validSeason(premierLeagueEvents);
  const espnValid = validSeason(espnEvents);

  if (premierLeagueValid) {
    return {
      events: premierLeagueEvents,
      provider: 'Premier League',
      validation: espnValid ? compareSeasons(premierLeagueEvents, espnEvents) : { secondary: 'ESPN', matched: false, unavailable: true }
    };
  }
  if (espnValid) return { events: espnEvents, provider: 'ESPN fallback', validation: { primary: 'Premier League', unavailable: true } };
  const message = pulseResult.status === 'rejected' ? pulseResult.reason.message : `Premier League returned ${premierLeagueEvents.length} fixtures`;
  throw new Error(message);
}

async function pulseFeed() {
  const common = `comp=${COMPETITION_ID}&compSeasons=${SEASON_ID}&page=0&altIds=true`;
  const [live, completed, upcoming] = await Promise.all([
    pulse(`/fixtures?${common}&pageSize=20&statuses=L&sort=asc`),
    pulse(`/fixtures?${common}&pageSize=20&statuses=C&sort=desc`),
    pulse(`/fixtures?${common}&pageSize=20&statuses=U&sort=asc`)
  ]);
  const byId = new Map();
  for (const fixture of [...(live.content || []), ...(completed.content || []), ...(upcoming.content || [])]) byId.set(fixture.id, fixture);
  return [...byId.values()].map(pulseFixture);
}

async function espnFeed() {
  const data = await espn(`/scoreboard?dates=${dayISO(-1)}-${dayISO(1)}&limit=100`);
  return (data.events || []).map(espnFixture);
}

async function feed() {
  try {
    return { events: await pulseFeed(), provider: 'Premier League' };
  } catch (_) {
    return { events: await espnFeed(), provider: 'ESPN fallback' };
  }
}

function standingsRows(data) {
  const table = data.tables && data.tables[0];
  return table && table.entries || [];
}

async function standings() {
  const query = `comp=${COMPETITION_ID}&compSeasons=${SEASON_ID}&page=0&pageSize=100&altIds=true`;
  const data = await pulse(`/standings?${query}`);
  return {
    provider: 'Premier League',
    standings: standingsRows(data).map(entry => {
      const team = entry.team || {};
      const row = entry.overall || {};
      return {
        rank: entry.position,
        teamId: team.id,
        team: team.name,
        crest: pulseCrest(team),
        played: row.played || 0,
        won: row.won || 0,
        drawn: row.drawn || 0,
        lost: row.lost || 0,
        goalsFor: row.goalsFor || 0,
        goalsAgainst: row.goalsAgainst || 0,
        goalDifference: row.goalsDifference || 0,
        points: row.points || 0,
        form: ''
      };
    })
  };
}

const STAT_LABELS = {
  possession_percentage: 'Possession',
  total_scoring_att: 'Total shots',
  ontarget_scoring_att: 'Shots on target',
  won_corners: 'Corners',
  fk_foul_lost: 'Fouls',
  total_offside: 'Offsides',
  total_yel_card: 'Yellow cards',
  total_red_card: 'Red cards',
  total_pass: 'Passes',
  accurate_pass: 'Accurate passes'
};

function findStat(stats, name) {
  return (stats || []).find(stat => stat.name === name)?.value ?? '';
}

async function playerInfo(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const results = await Promise.allSettled(unique.map(id => pulse(`/players/${id}`)));
  const players = new Map();
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    players.set(unique[index], {
      name: result.value.name && result.value.name.display || '',
      teamId: result.value.currentTeam && result.value.currentTeam.id
    });
  });
  return players;
}

function pulseLineups(fixture) {
  const lists = (fixture.teamLists || []).filter(Boolean);
  const teams = fixture.teams || [];
  const lineups = lists.map(list => {
    const side = teams.find(team => team.team && team.team.id === list.teamId);
    const player = value => ({
      id: value.id,
      name: value.name && value.name.display || '',
      shirtNumber: value.matchShirtNumber,
      position: value.matchPosition || value.latestPosition || '',
      captain: !!value.captain
    });
    return {
      teamId: list.teamId,
      team: side && side.team && side.team.name || '',
      crest: side && side.team ? pulseCrest(side.team) : '',
      formation: list.formation && list.formation.label || '',
      starters: (list.lineup || []).map(player),
      substitutes: (list.substitutes || []).map(player)
    };
  });
  return { confirmed: lineups.length === 2 && lineups.every(team => team.starters.length === 11), lineups };
}

function espnLineups(data) {
  const lineups = (data.rosters || []).map(roster => {
    const player = value => ({
      id: value.athlete && value.athlete.id,
      name: value.athlete && value.athlete.displayName || '',
      shirtNumber: value.jersey || '',
      position: value.position && value.position.abbreviation || '',
      captain: !!value.captain
    });
    const players = roster.roster || [];
    return {
      teamId: roster.team && roster.team.id,
      team: roster.team && roster.team.displayName || '',
      crest: roster.team && (roster.team.logo || roster.team.logos && roster.team.logos[0] && roster.team.logos[0].href) || '',
      formation: roster.formation || '',
      starters: players.filter(value => value.starter).map(player),
      substitutes: players.filter(value => !value.starter).map(player)
    };
  });
  return { confirmed: lineups.length === 2 && lineups.every(team => team.starters.length === 11), lineups };
}

async function espnDetail(id) {
  const data = await espn(`/summary?event=${encodeURIComponent(id)}`);
  const statistics = data.boxscore && data.boxscore.teams || [];
  const homeStats = statistics.find(team => team.homeAway === 'home') || statistics[0] || {};
  const awayStats = statistics.find(team => team.homeAway === 'away') || statistics[1] || {};
  const statValue = (team, label) => (team.statistics || []).find(stat => stat.label === label || stat.name === label)?.displayValue || '';
  const labels = [...new Set(statistics.flatMap(team => (team.statistics || []).map(stat => stat.label || stat.name)).filter(Boolean))];
  return {
    provider: 'ESPN fallback',
    events: [],
    timeline: [],
    lineups: espnLineups(data),
    eventstats: labels.slice(0, 10).map(label => ({ strStat: label, intHome: statValue(homeStats, label), intAway: statValue(awayStats, label) }))
  };
}

async function detail(rawId) {
  if (!rawId) return { events: [], timeline: [], eventstats: [] };
  const value = String(rawId);
  if (value.startsWith('espn:')) return espnDetail(value.slice(5));
  const id = value.startsWith('pulse:') ? value.slice(6) : value;
  const [fixture, stats] = await Promise.all([
    pulse(`/fixtures/${encodeURIComponent(id)}`),
    pulse(`/stats/match/${encodeURIComponent(id)}`).catch(() => ({ data: {} }))
  ]);
  const matchEvents = (fixture.events || fixture.goals || []).filter(event => ['G', 'B', 'S'].includes(event.type));
  const players = new Map();
  for (const list of fixture.teamLists || []) {
    if (!list) continue;
    for (const player of [...(list.lineup || []), ...(list.substitutes || [])]) {
      players.set(player.id, { name: player.name && player.name.display || '', teamId: list.teamId });
    }
  }
  const eventPlayerIds = matchEvents.flatMap(event => [event.personId, event.assistId]).filter(Boolean);
  const missingIds = eventPlayerIds.filter(id => !players.has(id));
  const fetchedPlayers = await playerInfo(missingIds);
  fetchedPlayers.forEach((value, key) => players.set(key, value));
  const home = fixture.teams && fixture.teams[0] && fixture.teams[0].team || {};
  const away = fixture.teams && fixture.teams[1] && fixture.teams[1].team || {};
  const homeStats = stats.data && stats.data[String(home.id)] && stats.data[String(home.id)].M || [];
  const awayStats = stats.data && stats.data[String(away.id)] && stats.data[String(away.id)].M || [];
  return {
    provider: 'Premier League',
    events: [pulseFixture(fixture)],
    lineups: pulseLineups(fixture),
    timeline: matchEvents.map(event => ({
      strTimeline: event.type === 'G' ? 'Goal' : event.type === 'B' ? 'Card' : 'Substitution',
      strTimelineDetail: event.type === 'B' ? (event.description === 'R' ? 'Red card' : 'Yellow card') : event.type === 'S' ? `Substitution ${event.description === 'ON' ? 'on' : 'off'}` : 'Goal',
      intTime: event.clock && String(event.clock.label || '').replace(/'00$/, '') || '',
      strTeam: (event.teamId || players.get(event.personId)?.teamId) === away.id ? away.name : home.name,
      strPlayer: players.get(event.personId)?.name || '',
      strAssist: players.get(event.assistId)?.name || ''
    })),
    eventstats: Object.entries(STAT_LABELS).map(([name, label]) => ({
      strStat: label,
      intHome: String(findStat(homeStats, name)),
      intAway: String(findStat(awayStats, name))
    })).filter(stat => stat.intHome || stat.intAway)
  };
}

async function lineup(rawId) {
  const value = String(rawId || '');
  if (!value) return { confirmed: false, lineups: [] };
  if (value.startsWith('espn:')) {
    const data = await espn(`/summary?event=${encodeURIComponent(value.slice(5))}`);
    return espnLineups(data);
  }
  const id = value.startsWith('pulse:') ? value.slice(6) : value;
  return pulseLineups(await pulse(`/fixtures/${encodeURIComponent(id)}`));
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

export default async function handler(req, res) {
  try {
    const type = req.query.type || 'feed';
    let body;
    if (type === 'fixtures') body = await fixtures();
    else if (type === 'standings') body = await standings();
    else if (type === 'detail') body = await detail(req.query.id);
    else if (type === 'lineups') body = await lineups(req.query.ids);
    else body = await feed();

    const cache = type === 'fixtures'
      ? 's-maxage=1800, stale-while-revalidate=21600'
      : type === 'standings'
        ? 's-maxage=60, stale-while-revalidate=300'
        : type === 'detail'
          ? 's-maxage=10, stale-while-revalidate=10'
          : type === 'lineups'
            ? 's-maxage=20, stale-while-revalidate=20'
            : 's-maxage=15, stale-while-revalidate=15';
    res.setHeader('Cache-Control', cache);
    res.status(200).json(body);
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(error.status || 500).json({ error: error.message || 'Football data provider failed' });
  }
}
