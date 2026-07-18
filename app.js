const COMPETITION = {
  name: 'Premier League',
  season: '2026/27',
  expectedFixtures: 380
};

const LIVE_STATUSES = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN']);
const INACTIVE_STATUSES = new Set(['NS', 'TBD', 'PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP']);
const PREF_KEY = 'premier_league_2627_prefs';
const REVEAL_KEY = 'pl2627_revealed';
const POLL_MS = 30_000;
const DETAIL_POLL_MS = 15_000;
const DEMO_LIVE = new URLSearchParams(location.search).get('demo') === 'live';

// FIFA men's international match calendar; Sep+Oct are one merged window from 2026
const INTERNATIONAL_BREAKS = [
  { start: Date.parse('2026-09-21T00:00:00Z'), end: Date.parse('2026-10-06T23:59:59Z'), dates: '21 Sep – 6 Oct' },
  { start: Date.parse('2026-11-09T00:00:00Z'), end: Date.parse('2026-11-17T23:59:59Z'), dates: '9 – 17 Nov' },
  { start: Date.parse('2027-03-22T00:00:00Z'), end: Date.parse('2027-03-30T23:59:59Z'), dates: '22 – 30 Mar' },
];

const state = {
  fixtures: [],
  standings: [],
  clubs: new Map(),
  lineups: new Map(),
  squads: new Map(),
  squadRequests: new Map(),
  transfers: new Map(),
  transferRequests: new Map(),
  availability: new Map(),
  availabilityRequests: new Map(),
  playerProfiles: new Map(),
  news: [],
  newsKey: '',
  newsLoading: false,
  health: { league: {}, europe: {}, live: {} },
  source: '',
  filterClubs: false,
  selectedClubs: new Set(),
  newsFilterClubs: false,
  newsSelectedClubs: new Set(),
  includeEurope: true,
  favoriteClub: '',
  hideCompleted: false,
  revealed: new Set(),
  detailTimers: new Map(),
  refreshTimer: 0
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function loadPreferences() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    state.filterClubs = !!prefs.filterClubs;
    state.newsFilterClubs = !!prefs.newsFilterClubs;
    state.includeEurope = prefs.includeEurope !== false;
    state.favoriteClub = typeof prefs.favoriteClub === 'string' ? prefs.favoriteClub : '';
    state.hideCompleted = !!prefs.hideCompleted;
    state.selectedClubs = new Set(Array.isArray(prefs.selectedClubs) ? prefs.selectedClubs : []);
    state.newsSelectedClubs = new Set(Array.isArray(prefs.newsSelectedClubs) ? prefs.newsSelectedClubs : []);
    state.revealed = new Set(Array.isArray(prefs.revealed) ? prefs.revealed : []);
  } catch (_) { /* storage is optional */ }
}

function savePreferences() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      filterClubs: state.filterClubs,
      newsFilterClubs: state.newsFilterClubs,
      includeEurope: state.includeEurope,
      favoriteClub: state.favoriteClub,
      hideCompleted: state.hideCompleted,
      selectedClubs: [...state.selectedClubs],
      newsSelectedClubs: [...state.newsSelectedClubs],
      revealed: [...state.revealed]
    }));
  } catch (_) { /* storage is optional */ }
}

function effectiveTimeZone() {
  return 'Europe/London';
}

function dateParts(iso) {
  if (!iso) return { day: 'Date TBC', date: '', time: '--:--', zone: '' };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { day: 'Date TBC', date: '', time: '--:--', zone: '' };
  const zone = effectiveTimeZone();
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const zoneName = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(date).find(part => part.type === 'timeZoneName')?.value || '';
  return { day, date: shortDate, time, zone: zoneName };
}

function teamKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^afcbournemouth$/, 'bournemouth')
    .replace(/^manunited$/, 'manchesterunited')
    .replace(/^manutd$/, 'manchesterunited')
    .replace(/^mancity$/, 'manchestercity')
    .replace(/^tottenham$/, 'tottenhamhotspur')
    .replace(/^spurs$/, 'tottenhamhotspur')
    .replace(/^nottmforest$/, 'nottinghamforest')
    .replace(/^newcastle$/, 'newcastleunited')
    .replace(/^brighton$/, 'brightonhovealbion')
    .replace(/^ipswich$/, 'ipswichtown')
    .replace(/^leeds$/, 'leedsunited')
    .replace(/^hull$/, 'hullcity')
    .replace(/^coventry$/, 'coventrycity');
}

function pairKey(home, away) {
  return `${teamKey(home)}|${teamKey(away)}`;
}

function roundNumber(round) {
  const matches = String(round || '').match(/(\d+)/g);
  return matches ? Number(matches[matches.length - 1]) : null;
}

function normaliseStatus(value) {
  const status = String(value || 'NS').toUpperCase().trim();
  if (['MATCH FINISHED', 'FINISHED', 'FULL TIME'].includes(status)) return 'FT';
  if (['NOT STARTED', 'SCHEDULED'].includes(status)) return 'NS';
  if (status.includes('POSTPON')) return 'PST';
  if (status.includes('CANCEL')) return 'CANC';
  if (status.includes('ABANDON')) return 'ABD';
  return status;
}

function normaliseTimestamp(event) {
  const raw = event.strTimestamp || '';
  if (raw) return /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  return event.dateEvent ? `${event.dateEvent}T${event.strTime || '00:00:00'}Z` : '';
}

function normaliseFixture(event, source) {
  const timestamp = normaliseTimestamp(event);
  const round = event.strRound || event.intRound || '';
  return {
    id: String(event.idEvent || `${pairKey(event.strHomeTeam, event.strAwayTeam)}:${timestamp}`),
    providerFixtureId: event.providerFixtureId || null,
    source: event.strSource || source,
    isEuropean: !!event.isEuropean,
    competition: event.strCompetition || COMPETITION.name,
    competitionCode: event.strCompetitionCode || 'PL',
    kickoff: timestamp,
    round,
    matchweek: roundNumber(round),
    home: { id: event.idHomeTeam || '', name: event.strHomeTeam || 'TBC', crest: event.strHomeBadge || event.strHomeTeamBadge || '' },
    away: { id: event.idAwayTeam || '', name: event.strAwayTeam || 'TBC', crest: event.strAwayBadge || event.strAwayTeamBadge || '' },
    homeScore: event.intHomeScore == null || event.intHomeScore === '' ? null : Number(event.intHomeScore),
    awayScore: event.intAwayScore == null || event.intAwayScore === '' ? null : Number(event.intAwayScore),
    status: normaliseStatus(event.strStatus),
    statusLong: event.strStatusLong || '',
    progress: event.strProgress || '',
    venue: event.strVenue || event.strStadium || '',
    city: event.strCity || '',
    referee: event.strReferee || '',
    broadcasters: Array.isArray(event.strBroadcasters) ? event.strBroadcasters : []
  };
}

async function fetchJSON(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function isCompleteFixtureList(fixtures) {
  if (fixtures.length !== COMPETITION.expectedFixtures) return false;
  const ids = new Set(fixtures.map(fixture => fixture.id));
  return ids.size === COMPETITION.expectedFixtures && fixtures.every(fixture => fixture.home.name !== 'TBC' && fixture.away.name !== 'TBC' && fixture.kickoff);
}

async function loadOfficialFixtures() {
  const data = await fetchJSON('/api/live?type=fixtures');
  state.health.league = { provider: data.provider || 'Football feed', validation: data.validation || null, updatedAt: new Date().toISOString(), ok: true };
  const fixtures = (data.events || []).map(event => normaliseFixture(event, data.provider || 'football-feed'));
  if (isCompleteFixtureList(fixtures)) return { fixtures, source: data.provider || 'Premier League feed' };
  throw new Error(`Fixture provider returned ${fixtures.length} of ${COMPETITION.expectedFixtures} fixtures`);
}

async function loadEuropeanFixtures() {
  try {
    const data = await fetchJSON('/api/europe?type=fixtures');
    const published = (data.events || []).map(event => normaliseFixture(event, 'uefa'));
    const relevant = published.filter(fixture => state.clubs.has(teamKey(fixture.home.name)) || state.clubs.has(teamKey(fixture.away.name)));
    state.health.europe = { provider: data.provider || 'UEFA', published: published.length, relevant: relevant.length, updatedAt: new Date().toISOString(), ok: true };
    return relevant;
  } catch (error) {
    state.health.europe = { provider: 'UEFA', ok: false, error: error.message, updatedAt: new Date().toISOString() };
    return [];
  }
}

async function loadStandings() {
  try {
    const data = await fetchJSON('/api/live?type=standings');
    state.standings = data.standings || [];
  } catch (_) {
    state.standings = calculateStandings();
  }
}

function demoTeamSheet(club) {
  const positions = ['GK', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'F', 'F', 'F'];
  const starters = positions.map((position, index) => ({
    id: `demo-${teamKey(club.name)}-${index + 1}`,
    name: `${club.name} Player ${index + 1}`,
    shirtNumber: index + 1,
    position,
    captain: index === 5
  }));
  return {
    teamId: club.id,
    team: club.name,
    crest: club.crest,
    formation: '4-3-3',
    formationLines: [[starters[0].id], starters.slice(1, 5).map(player => player.id), starters.slice(5, 8).map(player => player.id), starters.slice(8).map(player => player.id)],
    starters,
    substitutes: Array.from({ length: 9 }, (_, index) => ({
      id: `demo-${teamKey(club.name)}-sub-${index + 1}`,
      name: `${club.name} Substitute ${index + 1}`,
      shirtNumber: index + 12,
      position: index === 0 ? 'GK' : index < 4 ? 'D' : index < 7 ? 'M' : 'F',
      captain: false
    }))
  };
}

function applyLiveDemo() {
  const fixture = state.fixtures[0];
  if (!fixture) return;
  fixture.kickoff = new Date(Date.now() - 67 * 60000).toISOString();
  fixture.status = '2H';
  fixture.statusLong = 'Live demo';
  fixture.progress = '67';
  fixture.homeScore = 2;
  fixture.awayScore = 1;
  const lineups = { confirmed: true, lineups: [demoTeamSheet(fixture.home), demoTeamSheet(fixture.away)] };
  state.lineups.set(fixture.id, lineups);
  fixture.demoDetails = {
    lineups,
    timeline: [
      { strTimeline: 'Goal', strTimelineDetail: 'Goal', intTime: '12', strTeam: fixture.home.name, strPlayer: `${fixture.home.name} Player 9`, strAssist: `${fixture.home.name} Player 7` },
      { strTimeline: 'Goal', strTimelineDetail: 'Goal', intTime: '34', strTeam: fixture.away.name, strPlayer: `${fixture.away.name} Player 10`, strAssist: '' },
      { strTimeline: 'Card', strTimelineDetail: 'Yellow card', intTime: '51', strTeam: fixture.away.name, strPlayer: `${fixture.away.name} Player 4`, strAssist: '' },
      { strTimeline: 'Goal', strTimelineDetail: 'Goal', intTime: '63', strTeam: fixture.home.name, strPlayer: `${fixture.home.name} Player 11`, strAssist: `${fixture.home.name} Player 8` }
    ],
    stats: [
      { strStat: 'Possession', intHome: '58%', intAway: '42%' },
      { strStat: 'Total shots', intHome: '12', intAway: '7' },
      { strStat: 'Shots on target', intHome: '6', intAway: '3' },
      { strStat: 'Corners', intHome: '5', intAway: '2' },
      { strStat: 'Fouls', intHome: '8', intAway: '11' }
    ]
  };
}

function registerClubs() {
  state.clubs = new Map();
  for (const fixture of state.fixtures) {
    if (fixture.isEuropean) continue;
    for (const club of [fixture.home, fixture.away]) {
      const key = teamKey(club.name);
      const current = state.clubs.get(key) || {};
      state.clubs.set(key, { ...current, ...club, crest: club.crest || current.crest || '' });
    }
  }
  for (const row of state.standings) {
    const key = teamKey(row.team);
    const current = state.clubs.get(key) || { name: row.team };
    state.clubs.set(key, { ...current, id: row.teamId || current.id, crest: row.crest || current.crest || '' });
  }
}

function updateFavoriteClubUI() {
  const button = $('#favorite-club-link');
  const club = state.favoriteClub && state.clubs.get(state.favoriteClub);
  if (!button) return;
  button.hidden = !club;
  button.textContent = club ? `★ Favourite: ${club.name}` : '';
  button.dataset.club = club ? club.name : '';
}

function fixtureTime(fixture) {
  const value = new Date(fixture.kickoff).getTime();
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

function isLive(fixture) {
  return LIVE_STATUSES.has(fixture.status) || (!INACTIVE_STATUSES.has(fixture.status) && !FINAL_STATUSES.has(fixture.status) && fixture.status !== '');
}

function isFinal(fixture) {
  return FINAL_STATUSES.has(fixture.status);
}

function hasScore(fixture) {
  return Number.isFinite(fixture.homeScore) && Number.isFinite(fixture.awayScore);
}

function isPostponed(fixture) {
  return ['PST', 'CANC', 'ABD'].includes(fixture.status);
}

function statusLabel(fixture) {
  if (isLive(fixture)) return fixture.progress ? `${fixture.progress}'` : (fixture.status === 'HT' ? 'HT' : 'Live');
  if (isFinal(fixture)) return fixture.status;
  return ({ PST: 'Postponed', CANC: 'Cancelled', ABD: 'Abandoned', SUSP: 'Suspended', TBD: 'TBC' })[fixture.status] || '';
}

function crestHtml(club, large = false) {
  if (club.crest) return `<img class="club-crest${large ? ' large' : ''}" src="${escapeHtml(club.crest)}" data-fallback="/icon.svg" alt="" loading="lazy">`;
  return `<span class="club-crest${large ? ' large' : ''}" aria-hidden="true"></span>`;
}

function clubUrl(name) {
  return `#club=${encodeURIComponent(name)}`;
}

function clubLink(club) {
  if (!state.clubs.has(teamKey(club.name))) return `<span class="club-name">${escapeHtml(club.name)}</span>`;
  return `<a class="club-name" href="${clubUrl(club.name)}" data-club="${escapeHtml(club.name)}">${escapeHtml(club.name)}</a>`;
}

function renderFixture(fixture) {
  const parts = dateParts(fixture.kickoff);
  const live = isLive(fixture);
  const final = isFinal(fixture);
  const score = hasScore(fixture) ? `${fixture.homeScore} – ${fixture.awayScore}` : 'v';
  const hiddenScore = final && hasScore(fixture) && !state.revealed.has(fixture.id);
  const lineup = state.lineups.get(fixture.id);
  const hasLineups = !!(lineup && lineup.confirmed);
  const favorite = state.favoriteClub && [fixture.home.name, fixture.away.name].some(name => teamKey(name) === state.favoriteClub);
  const classes = ['match-row', favorite ? 'favorite' : '', fixture.isEuropean ? 'european' : '', final ? 'finished' : '', live ? 'is-live' : '', hasLineups ? 'has-lineups' : '', isPostponed(fixture) ? 'postponed' : ''].filter(Boolean).join(' ');
  const venue = [fixture.venue, fixture.city].filter(Boolean).join(', ') || 'Venue TBC';
  const scoreStatus = live
    ? `<span class="live-pill">${escapeHtml(statusLabel(fixture))}</span>`
    : statusLabel(fixture) ? `<span class="row-status">${escapeHtml(statusLabel(fixture))}</span>` : '';
  const competitionStatus = fixture.isEuropean ? `<span class="europe-pill" title="${escapeHtml(fixture.competition)}">${escapeHtml(fixture.competitionCode)}</span>` : '';
  const lineupStatus = hasLineups ? '<button type="button" class="lineup-pill">Line-ups</button>' : '';
  const tvStatus = fixture.broadcasters.length ? `<span class="tv-pill" title="Confirmed UK broadcaster">TV: ${escapeHtml(fixture.broadcasters.join(', '))}</span>` : '';
  const matchStatus = `${competitionStatus}${tvStatus}${scoreStatus}${lineupStatus}${live || hasLineups ? '<span class="detail-caret">▾</span>' : ''}`;
  return `<div class="${classes}" data-id="${escapeHtml(fixture.id)}">
    <div class="row-teams">
      <span class="row-team home">${clubLink(fixture.home)}${crestHtml(fixture.home)}</span>
      <span class="vs${hasScore(fixture) ? ' score' : ''}${hiddenScore ? ' spoiler' : ''}" title="${hiddenScore ? 'Reveal score' : ''}">${score}</span>
      <span class="row-team away">${crestHtml(fixture.away)}${clubLink(fixture.away)}</span>
    </div>
    <div class="row-when"><span class="row-match-status">${matchStatus}</span><span class="row-date">${escapeHtml(parts.date)}</span><span class="row-time">${escapeHtml(parts.time)}<span class="row-tz">${escapeHtml(parts.zone)}</span></span></div>
    <div class="row-venue" title="${escapeHtml(venue)}">${escapeHtml(venue)}</div>
  </div>`;
}

function visibleFixtures() {
  return state.fixtures.filter(fixture => {
    if (!state.includeEurope && fixture.isEuropean) return false;
    if (state.hideCompleted && isFinal(fixture)) return false;
    if (state.filterClubs && state.selectedClubs.size) {
      return state.selectedClubs.has(teamKey(fixture.home.name)) || state.selectedClubs.has(teamKey(fixture.away.name));
    }
    return true;
  });
}

function renderFixtures() {
  const list = $('#fixture-list');
  if (!state.fixtures.length) {
    list.innerHTML = `<div class="empty-state"><h2>Fixtures are not available yet</h2><p>The 2026/27 fixture list will appear here as soon as a configured provider publishes it. No placeholder or invented matches are shown.</p></div>`;
    $('#fixture-count').textContent = 'Awaiting release';
    updateNextMatch();
    return;
  }

  let html = '';
  let lastDay = '';
  let prevKick = 0;
  const fixtures = visibleFixtures();
  for (const fixture of fixtures) {
    const kick = new Date(fixture.kickoff).getTime();
    const brk = INTERNATIONAL_BREAKS.find(b => prevKick && prevKick < b.start && kick > b.end);
    if (brk) html += `<div class="break-divider">International break · ${brk.dates}</div>`;
    prevKick = kick;
    const day = dateParts(fixture.kickoff).day;
    if (day !== lastDay) {
      html += `<div class="day-divider">${escapeHtml(day)}</div>`;
      lastDay = day;
    }
    html += renderFixture(fixture);
  }
  list.innerHTML = html || '<div class="empty-state"><h2>No fixtures match these filters</h2><p>Clear a club filter or show completed matches.</p></div>';
  const labels = [];
  if (state.filterClubs && state.selectedClubs.size) labels.push(`${state.selectedClubs.size} clubs`);
  if (!state.includeEurope) labels.push('league only');
  if (state.hideCompleted) labels.push('upcoming');
  $('#fixture-count').textContent = labels.length ? `${fixtures.length} · ${labels.join(' + ')}` : `${state.fixtures.length} · kick-off order`;
  updateNextMatch();
}

function calculateStandings() {
  const table = new Map();
  const ensure = club => {
    const key = teamKey(club.name);
    if (!table.has(key)) table.set(key, { team: club.name, crest: club.crest, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, form: '' });
    return table.get(key);
  };
  state.fixtures.forEach(fixture => {
    if (fixture.isEuropean) return;
    const home = ensure(fixture.home);
    const away = ensure(fixture.away);
    if (!isFinal(fixture) || !hasScore(fixture)) return;
    home.played++; away.played++;
    home.goalsFor += fixture.homeScore; home.goalsAgainst += fixture.awayScore;
    away.goalsFor += fixture.awayScore; away.goalsAgainst += fixture.homeScore;
    if (fixture.homeScore > fixture.awayScore) { home.won++; home.points += 3; away.lost++; }
    else if (fixture.homeScore < fixture.awayScore) { away.won++; away.points += 3; home.lost++; }
    else { home.drawn++; away.drawn++; home.points++; away.points++; }
  });
  const rows = [...table.values()];
  rows.forEach(row => { row.goalDifference = row.goalsFor - row.goalsAgainst; });
  rows.sort((a, b) => (b.points - a.points) || (b.goalDifference - a.goalDifference) || (b.goalsFor - a.goalsFor) || a.team.localeCompare(b.team));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

function renderTable() {
  const rows = state.standings.length ? state.standings : calculateStandings();
  const wrap = $('#table-wrap');
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state"><h2>Table not available</h2><p>The league table will appear when the season data is published.</p></div>';
    return;
  }
  wrap.innerHTML = `<div class="league-table-wrap"><table class="league-table">
    <thead><tr><th>Pos</th><th class="club-col">Club</th><th>P</th><th>W</th><th>D</th><th>L</th><th class="optional">GF</th><th class="optional">GA</th><th>GD</th><th>Pts</th><th class="optional">Form</th></tr></thead>
    <tbody>${rows.map((row, index) => `<tr><td>${row.rank || index + 1}</td><td class="club-col"><a class="table-club" href="${clubUrl(row.team)}" data-club="${escapeHtml(row.team)}">${row.crest ? `<img src="${escapeHtml(row.crest)}" data-fallback="/icon.svg" alt="">` : ''}<span>${escapeHtml(row.team)}</span></a></td><td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td><td class="optional">${row.goalsFor}</td><td class="optional">${row.goalsAgainst}</td><td>${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}</td><td><strong>${row.points}</strong></td><td class="form optional">${escapeHtml(row.form || '')}</td></tr>`).join('')}</tbody>
  </table></div><p class="table-legend"><span class="legend-swatch cl"></span> Champions League<span class="legend-swatch rel"></span> Relegation</p>`;
}

function fixtureMini(fixture) {
  const parts = dateParts(fixture.kickoff);
  const score = hasScore(fixture) ? `${fixture.homeScore} – ${fixture.awayScore}` : 'v';
  return `<div class="club-fixture${fixture.isEuropean ? ' european' : ''}${isFinal(fixture) ? ' finished' : ''}${isLive(fixture) ? ' live' : ''}"><div class="cf-meta"><span>${fixture.isEuropean ? `<strong>${escapeHtml(fixture.competitionCode)}</strong> · ` : ''}${escapeHtml(fixture.venue || '')}</span><span>${escapeHtml(isLive(fixture) || isFinal(fixture) ? statusLabel(fixture) : `${parts.date} · ${parts.time} ${parts.zone}`)}${fixture.broadcasters?.length ? ` · TV: ${escapeHtml(fixture.broadcasters.join(', '))}` : ''}</span></div><div class="cf-teams">${escapeHtml(fixture.home.name)} <span class="vs${hasScore(fixture) ? ' score' : ''}">${score}</span> ${escapeHtml(fixture.away.name)}</div></div>`;
}

const POSITION_GROUPS = [
  ['G', 'Goalkeepers'],
  ['D', 'Defenders'],
  ['M', 'Midfielders'],
  ['F', 'Forwards']
];

function renderClubInfo(data) {
  if (!data) return '';
  const facts = [
    data.club?.stadium ? ['Stadium', data.club.stadium] : null,
    data.club?.capacity ? ['Capacity', Number(data.club.capacity).toLocaleString('en-GB')] : null,
    data.club?.city ? ['City', data.club.city] : null,
    data.club?.founded ? ['Founded', data.club.founded] : null
  ].filter(Boolean);
  const staff = data.staff || [];
  if (!facts.length && !staff.length) return '';
  return `<div class="club-info-grid">${staff.length ? `<section><div class="club-section-title">Manager & staff</div><div class="staff-list">${staff.map(person => `<div class="staff-row"><strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(person.role)}${person.nationality ? ` · ${escapeHtml(person.nationality)}` : ''}</span></div>`).join('')}</div></section>` : ''}${facts.length ? `<section><div class="club-section-title">Club details</div><dl class="club-facts">${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></section>` : ''}</div>`;
}

function renderSquad(squad, club) {
  if (!squad) return '<div class="loading-dots">Loading squad</div>';
  if (!squad.players || !squad.players.length) return '<p class="md-empty">Squad data is currently unavailable.</p>';
  return `<div class="squad-groups">${POSITION_GROUPS.map(([code, label]) => {
    const players = squad.players.filter(player => player.position === code).sort((a, b) => (Number(a.shirtNumber) || 999) - (Number(b.shirtNumber) || 999) || a.name.localeCompare(b.name));
    if (!players.length) return '';
    return `<section class="squad-group"><h4>${label}</h4><div class="squad-grid">${players.map(player => `<button type="button" class="squad-player" data-player-id="${escapeHtml(player.id)}" data-player-club="${escapeHtml(club.name)}"><span class="squad-shirt">${escapeHtml(player.shirtNumber || '–')}</span><strong>${escapeHtml(player.name)}</strong><span class="squad-role">${escapeHtml(player.positionInfo || label.slice(0, -1))}</span><span class="squad-nationality">${escapeHtml(player.nationality || '')}</span></button>`).join('')}</div></section>`;
  }).join('')}</div>`;
}

async function loadClubSquad(key, club) {
  if (!club.id || state.squads.has(key) || state.squadRequests.has(key)) return;
  const request = fetchJSON(`/api/live?type=squad&teamId=${encodeURIComponent(club.id)}`)
    .then(data => state.squads.set(key, { players: data.players || [], staff: data.staff || [], club: data.club || {}, provider: data.provider || '' }))
    .catch(() => state.squads.set(key, { players: [] }))
    .finally(() => {
      state.squadRequests.delete(key);
      const hash = location.hash.match(/^#club=(.+)$/);
      if (hash && teamKey(decodeURIComponent(hash[1])) === key) renderClubPage(club.name);
    });
  state.squadRequests.set(key, request);
}

function renderAvailability(data) {
  if (!data) return '<div class="loading-dots">Checking availability</div>';
  if (!data.items.length) return `<p class="md-empty">No current injuries are listed by ${escapeHtml(data.provider)}. Suspensions are only shown when explicitly supplied by a provider.</p>`;
  return `<div class="availability-list">${data.items.map(item => `<div class="availability-row"><strong>${escapeHtml(item.player)}</strong><span>${escapeHtml([item.status, item.detail].filter(Boolean).join(' · ') || 'Unavailable')}</span>${item.returnDate ? `<small>Possible return: ${escapeHtml(dateParts(item.returnDate).date)}</small>` : ''}</div>`).join('')}</div><p class="source-note">Source: ${escapeHtml(data.provider)}. Availability can change.</p>`;
}

async function loadClubAvailability(key, club) {
  if (state.availability.has(key) || state.availabilityRequests.has(key)) return;
  const request = fetchJSON(`/api/live?type=injuries&team=${encodeURIComponent(club.name)}`)
    .then(data => state.availability.set(key, { items: data.injuries || [], provider: data.provider || 'availability feed' }))
    .catch(() => state.availability.set(key, { items: [], provider: 'availability feed' }))
    .finally(() => {
      state.availabilityRequests.delete(key);
      const hash = location.hash.match(/^#club=(.+)$/);
      if (hash && teamKey(decodeURIComponent(hash[1])) === key) renderClubPage(club.name);
    });
  state.availabilityRequests.set(key, request);
}

function statCards(stats) {
  return [['Apps', stats.appearances], ['Starts', stats.starts], ['Goals', stats.goals], ['Assists', stats.assists], ['Yellow cards', stats.yellowCards], ['Red cards', stats.redCards]].map(([label, value]) => `<div><strong>${Number(value) || 0}</strong><span>${label}</span></div>`).join('');
}

async function openPlayerProfile(id, clubName) {
  const dialog = $('#player-dialog');
  const target = $('#player-profile');
  dialog.showModal();
  history.pushState({ ...(history.state || {}), playerDialog: true }, '', location.href);
  document.body.classList.add('dialog-open');
  target.innerHTML = '<div class="loading-dots">Loading player</div>';
  try {
    let data = state.playerProfiles.get(String(id));
    if (!data) {
      const [profile, news] = await Promise.all([fetchJSON(`/api/live?type=player&playerId=${encodeURIComponent(id)}`), fetchJSON(`/api/news?clubs=${encodeURIComponent(clubName)}`).catch(() => ({ articles: [] }))]);
      const fullName = profile.player.name.toLowerCase();
      const surname = fullName.split(' ').slice(-1)[0];
      profile.news = (news.articles || []).filter(article => article.title.toLowerCase().includes(fullName) || article.title.toLowerCase().includes(surname)).slice(0, 6);
      data = profile;
      state.playerProfiles.set(String(id), data);
    }
    const player = data.player;
    target.innerHTML = `<div class="player-profile-head"><span class="squad-shirt">${escapeHtml(player.shirtNumber || '–')}</span><div><h2>${escapeHtml(player.name)}</h2><p>${escapeHtml([player.club, player.position, player.nationality].filter(Boolean).join(' · '))}</p></div></div><div class="player-facts">${player.age ? `<span><strong>Age</strong>${escapeHtml(player.age)}</span>` : ''}${player.height ? `<span><strong>Height</strong>${escapeHtml(player.height)} cm</span>` : ''}${player.birthDate ? `<span><strong>Born</strong>${escapeHtml(player.birthDate)}</span>` : ''}${player.debut ? `<span><strong>PL debut</strong>${escapeHtml(player.debut)}</span>` : ''}</div><section class="player-stat-section"><h3>2026/27 Premier League</h3><div class="player-stats">${statCards(data.season)}</div></section><section class="player-stat-section"><h3>Premier League career</h3><div class="player-stats">${statCards(data.career)}</div></section><section class="player-stat-section"><h3>Recent headlines</h3>${data.news.length ? `<div class="player-news">${data.news.map(article => `<a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(article.title)}</strong><span>${escapeHtml(article.source)}</span></a>`).join('')}</div>` : '<p class="md-empty">No recent attributed headlines found.</p>'}</section><p class="source-note">Player information and statistics: ${escapeHtml(data.provider)}.</p>`;
  } catch (_) {
    target.innerHTML = '<div class="empty-state"><h2>Player unavailable</h2><p>The player feed could not be loaded.</p></div>';
  }
}

function transferLabel(type) {
  return ({ 'transfer-in': 'Signed', 'transfer-out': 'Departed', 'loan-in': 'Loan in', 'loan-out': 'Loan out', 'loan-recall': 'Loan recalled', 'player-released': 'Released', 'end-of-loan': 'End of loan' })[type] || type;
}

function renderTransfers(data) {
  if (!data) return '<div class="loading-dots">Loading confirmed transfers</div>';
  if (!data.length) return '<p class="md-empty">No confirmed transfers are currently listed.</p>';
  return `<div class="squad-grid transfer-list">${data.map(item => `<article class="squad-player transfer-row"><span class="squad-shirt transfer-symbol">${['transfer-in', 'loan-in', 'loan-recall'].includes(item.type) ? '←' : '→'}</span>${item.playerId ? `<button type="button" class="transfer-player-link" data-player-id="${escapeHtml(item.playerId)}" data-player-club="${escapeHtml(item.club)}">${escapeHtml(item.player)}</button>` : `<strong>${escapeHtml(item.player)}</strong>`}<span class="squad-role transfer-type ${escapeHtml(item.type)}">${escapeHtml(transferLabel(item.type))}</span><span class="squad-nationality">${escapeHtml(item.detail || '')}</span></article>`).join('')}</div>`;
}

async function loadClubTransfers(key, club) {
  if (state.transfers.has(key) || state.transferRequests.has(key)) return;
  const request = fetchJSON(`/api/transfers?club=${encodeURIComponent(club.name)}`)
    .then(data => state.transfers.set(key, data.transfers || []))
    .catch(() => state.transfers.set(key, []))
    .finally(() => {
      state.transferRequests.delete(key);
      const hash = location.hash.match(/^#club=(.+)$/);
      if (hash && teamKey(decodeURIComponent(hash[1])) === key) renderClubPage(club.name);
    });
  state.transferRequests.set(key, request);
}

function renderClubPage(name) {
  const key = teamKey(name);
  const club = state.clubs.get(key);
  const target = $('#club-detail');
  if (!club) {
    $('#club-page-pill').textContent = 'Select a club';
    target.innerHTML = '<div class="empty-state"><h2>Club not found</h2><p>Select a club from the fixture list or table.</p></div>';
    return;
  }
  $('#club-page-pill').textContent = COMPETITION.season;
  const matches = state.fixtures.filter(fixture => teamKey(fixture.home.name) === key || teamKey(fixture.away.name) === key);
  const completed = matches.filter(isFinal).sort((a, b) => fixtureTime(b) - fixtureTime(a)).slice(0, 8);
  const upcoming = matches.filter(fixture => !isFinal(fixture) && !isPostponed(fixture)).sort((a, b) => fixtureTime(a) - fixtureTime(b)).slice(0, 8);
  const tableRow = (state.standings.length ? state.standings : calculateStandings()).find(row => teamKey(row.team) === key);
  const squad = state.squads.get(key);
  const transfers = state.transfers.get(key);
  const availability = state.availability.get(key);
  target.innerHTML = `<div class="club-card"><div class="club-head">${crestHtml(club, true)}<div><div class="club-title">${escapeHtml(club.name)}</div><div class="club-meta">${tableRow ? `${tableRow.rank}${ordinal(tableRow.rank)} · ${tableRow.points} points · ${tableRow.played} played` : `${matches.length} fixtures`}</div></div><button type="button" class="favorite-action${state.favoriteClub === key ? ' active' : ''}" data-favorite-club="${escapeHtml(key)}">${state.favoriteClub === key ? '★ Favourite club' : '☆ Set as favourite'}</button></div>${renderClubInfo(squad)}<div class="club-sections"><div><div class="club-section-title">Upcoming fixtures</div>${upcoming.length ? upcoming.map(fixtureMini).join('') : '<p class="md-empty">No upcoming fixtures available.</p>'}</div><div><div class="club-section-title">Recent results</div>${completed.length ? completed.map(fixtureMini).join('') : '<p class="md-empty">No results yet.</p>'}</div></div><div class="club-availability"><div class="club-section-title">Injuries & suspensions</div>${renderAvailability(availability)}</div><div class="club-squad"><div class="club-section-title">2026/27 squad</div>${renderSquad(squad, club)}<div class="squad-transfer-block"><h4>Confirmed transfers</h4>${renderTransfers(transfers)}</div></div></div>`;
  loadClubSquad(key, club);
  loadClubAvailability(key, club);
  loadClubTransfers(key, club);
}

function ordinal(number) {
  const value = Number(number);
  if (value % 100 >= 11 && value % 100 <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' })[value % 10] || 'th';
}

function updateNextMatch() {
  const target = $('#next-match');
  const now = Date.now();
  const favoriteFixtures = state.favoriteClub ? state.fixtures.filter(fixture => [fixture.home.name, fixture.away.name].some(name => teamKey(name) === state.favoriteClub)) : [];
  const pool = favoriteFixtures.length ? favoriteFixtures : state.fixtures;
  const live = pool.find(isLive);
  const next = live || pool.find(fixture => !isFinal(fixture) && !isPostponed(fixture) && fixtureTime(fixture) > now);
  if (!next) {
    target.innerHTML = state.fixtures.length ? '<strong>No upcoming fixture found</strong>' : '<strong>Awaiting the official fixture list</strong>';
    return;
  }
  const parts = dateParts(next.kickoff);
  const countdown = live ? statusLabel(next) : countdownText(fixtureTime(next) - now);
  const label = live ? 'Live now' : state.favoriteClub && favoriteFixtures.length ? 'Favourite club next' : 'Next match';
  target.innerHTML = `<strong>${label}</strong><span>${escapeHtml(next.home.name)} v ${escapeHtml(next.away.name)}</span><span class="nm-muted">${escapeHtml(parts.date)} ${escapeHtml(parts.time)} ${escapeHtml(parts.zone)}</span><span class="nm-count">${escapeHtml(countdown)}</span>`;
}

function countdownText(milliseconds) {
  if (milliseconds <= 0) return 'soon';
  const minutes = Math.floor(milliseconds / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(1, minutes)}m`;
}

function setFeedStatus(className, text) {
  const target = $('#feed-status');
  target.className = `feed-status ${className}`;
  target.textContent = text;
}

function healthTime(value) {
  if (!value) return 'Not checked';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function renderDataHealth() {
  const panel = $('#data-health-panel');
  if (!panel) return;
  const league = state.health.league || {};
  const europe = state.health.europe || {};
  const live = state.health.live || {};
  const validation = league.validation;
  panel.innerHTML = `<div class="health-grid"><div><span class="health-dot ${league.ok ? 'ok' : 'bad'}"></span><strong>League schedule</strong><span>${escapeHtml(league.provider || 'Unavailable')}</span><small>${validation ? (validation.matched ? '380 fixtures matched against ESPN' : 'Secondary validation unavailable or disagreed') : 'Awaiting validation'} · ${escapeHtml(healthTime(league.updatedAt))}</small></div><div><span class="health-dot ${europe.ok ? 'ok' : 'bad'}"></span><strong>European schedule</strong><span>${escapeHtml(europe.provider || 'UEFA')}</span><small>${europe.ok ? `${europe.published || 0} UEFA fixtures checked · ${europe.relevant || 0} relevant` : 'Feed unavailable'} · ${escapeHtml(healthTime(europe.updatedAt))}</small></div><div><span class="health-dot ${live.ok ? 'ok' : 'bad'}"></span><strong>Live scores</strong><span>${escapeHtml(live.providers || 'Not checked')}</span><small>${live.ok ? `${live.events || 0} current events returned` : 'Last check failed'} · ${escapeHtml(healthTime(live.updatedAt))}</small></div></div>`;
}

function updateEuropeFilter() {
  const count = state.fixtures.filter(fixture => fixture.isEuropean).length;
  const input = $('#filter-europe');
  const label = $('#europe-filter-label');
  input.disabled = count === 0;
  label.classList.toggle('disabled', count === 0);
  label.title = count ? `${count} published European fixture${count === 1 ? '' : 's'} involving Premier League clubs` : 'European fixtures have not been published for Premier League clubs yet';
  input.checked = state.includeEurope;
}

function updateSummary() {
  const clubs = state.clubs.size;
  const leagueCount = state.fixtures.filter(fixture => !fixture.isEuropean).length;
  const europeCount = state.fixtures.filter(fixture => fixture.isEuropean).length;
  $('#season-summary').textContent = leagueCount
    ? `${leagueCount} league fixtures${europeCount ? ` · ${europeCount} European fixtures` : ''}${clubs ? ` · ${clubs} clubs` : ''}`
    : 'Official fixtures have not been published by the configured feeds';
  updateEuropeFilter();
}

function mergeEvents(events, source) {
  const byId = new Map(state.fixtures.map(fixture => [fixture.id, fixture]));
  const byPair = new Map(state.fixtures.map(fixture => [pairKey(fixture.home.name, fixture.away.name), fixture]));
  let changed = false;
  for (const event of events) {
    const incoming = normaliseFixture(event, source);
    const current = byId.get(incoming.id) || byPair.get(pairKey(incoming.home.name, incoming.away.name));
    if (!current) continue;
    const before = JSON.stringify([current.kickoff, current.status, current.progress, current.homeScore, current.awayScore, current.venue]);
    Object.assign(current, incoming, {
      home: { ...current.home, ...incoming.home, crest: incoming.home.crest || current.home.crest },
      away: { ...current.away, ...incoming.away, crest: incoming.away.crest || current.away.crest }
    });
    const after = JSON.stringify([current.kickoff, current.status, current.progress, current.homeScore, current.awayScore, current.venue]);
    if (before !== after) changed = true;
  }
  if (changed) state.fixtures.sort((a, b) => fixtureTime(a) - fixtureTime(b));
  return changed;
}

async function loadLiveEvents() {
  const results = await Promise.allSettled([
    fetchJSON('/api/live?type=feed'),
    fetchJSON('/api/europe?type=feed')
  ]);
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const events = fulfilled.flatMap(result => result.value.events || []);
  if (!events.length && results.every(result => result.status === 'rejected')) throw new Error('All live feeds unavailable');
  return { events, source: 'live-football-feeds', providers: fulfilled.map(result => result.value.provider).filter(Boolean).join(' + ') || 'Football feeds' };
}

function nearbyLineupFixtures() {
  const now = Date.now();
  return state.fixtures.filter(fixture => {
    const kickoff = fixtureTime(fixture);
    return fixture.providerFixtureId && kickoff >= now - 4 * 60 * 60 * 1000 && kickoff <= now + 2 * 60 * 60 * 1000;
  }).slice(0, 10);
}

async function refreshNearbyLineups() {
  const fixtures = nearbyLineupFixtures();
  if (!fixtures.length) return false;
  try {
    const premierIds = fixtures.filter(fixture => !fixture.isEuropean).map(fixture => fixture.providerFixtureId);
    const europeanIds = fixtures.filter(fixture => fixture.isEuropean).map(fixture => fixture.providerFixtureId);
    const requests = [];
    if (premierIds.length) requests.push(fetchJSON(`/api/live?type=lineups&ids=${encodeURIComponent(premierIds.join(','))}`));
    if (europeanIds.length) requests.push(fetchJSON(`/api/europe?type=lineups&ids=${encodeURIComponent(europeanIds.join(','))}`));
    const responses = await Promise.allSettled(requests);
    const lineupsById = Object.assign({}, ...responses.filter(result => result.status === 'fulfilled').map(result => result.value.lineupsById || {}));
    let changed = false;
    fixtures.forEach(fixture => {
      const incoming = lineupsById[fixture.providerFixtureId];
      if (!incoming) return;
      const current = state.lineups.get(fixture.id);
      if (JSON.stringify(current || null) !== JSON.stringify(incoming)) {
        state.lineups.set(fixture.id, incoming);
        changed = true;
      }
    });
    return changed;
  } catch (_) {
    return false;
  }
}

async function refreshLiveScores() {
  try {
    const result = await loadLiveEvents();
    state.health.live = { ok: true, providers: result.providers, events: result.events.length, updatedAt: new Date().toISOString() };
    renderDataHealth();
    const scoreChanged = mergeEvents(result.events, result.source);
    const lineupsChanged = await refreshNearbyLineups();
    if (scoreChanged || lineupsChanged) {
      state.standings = calculateStandings();
      registerClubs();
      renderFixtures();
      renderTable();
      rerenderOpenClub();
    } else {
      updateNextMatch();
    }
    const liveCount = state.fixtures.filter(isLive).length;
    const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: effectiveTimeZone(), hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
    setFeedStatus(liveCount ? 'live' : 'ok', liveCount ? `● ${liveCount} live · updated ${stamp}` : `Scores checked · ${stamp}`);
  } catch (error) {
    state.health.live = { ok: false, error: error.message, updatedAt: new Date().toISOString() };
    renderDataHealth();
    setFeedStatus('off', 'Live score feed unavailable — retrying automatically');
  } finally {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refreshLiveScores, POLL_MS);
  }
}

async function openMatchDetail(row) {
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains('match-detail')) {
    existing.remove();
    clearTimeout(state.detailTimers.get(row.dataset.id));
    state.detailTimers.delete(row.dataset.id);
    return;
  }
  const fixture = state.fixtures.find(item => item.id === row.dataset.id);
  const hasLineups = state.lineups.get(fixture && fixture.id)?.confirmed;
  if (!fixture || (!isLive(fixture) && !hasLineups)) return;
  const panel = document.createElement('div');
  panel.className = 'match-detail';
  row.insertAdjacentElement('afterend', panel);
  if (fixture.demoDetails) {
    panel.innerHTML = renderDetail(fixture, fixture.demoDetails.timeline, fixture.demoDetails.stats, fixture.demoDetails.lineups);
    return;
  }
  panel.innerHTML = '<div class="loading-dots">Loading live match detail…</div>';
  await refreshMatchDetail(fixture, row, panel);
}

async function refreshMatchDetail(fixture, row, panel) {
  try {
    let data;
    if (!fixture.providerFixtureId) throw new Error('No detail provider available');
    const endpoint = fixture.isEuropean ? '/api/europe' : '/api/live';
    data = await fetchJSON(`${endpoint}?type=detail&id=${encodeURIComponent(fixture.providerFixtureId)}`);
    if (data.events && data.events.length) mergeEvents(data.events, fixture.source);
    if (data.lineups) state.lineups.set(fixture.id, data.lineups);
    panel.innerHTML = renderDetail(fixture, data.timeline || [], data.eventstats || [], data.lineups || state.lineups.get(fixture.id));
  } catch (_) {
    panel.innerHTML = '<div class="md-empty">Live detail is temporarily unavailable.</div>';
  }
  clearTimeout(state.detailTimers.get(fixture.id));
  if (document.body.contains(panel) && isLive(fixture)) {
    state.detailTimers.set(fixture.id, setTimeout(() => refreshMatchDetail(fixture, row, panel), DETAIL_POLL_MS));
  }
}

function renderFormation(team) {
  if (!team.formation || !Array.isArray(team.formationLines) || team.formationLines.length < 2) return '';
  const players = new Map(team.starters.map(player => [String(player.id), player]));
  const lines = team.formationLines.map(line => line.map(id => players.get(String(id))).filter(Boolean)).filter(line => line.length);
  if (lines.length < 2 || lines.flat().length !== 11) return '';
  return `<div class="formation-pitch" aria-label="${escapeHtml(`${team.team} ${team.formation} formation`)}">${lines.map(line => `<div class="formation-line">${line.map(player => `<div class="formation-player"><span>${escapeHtml(player.shirtNumber || '')}</span><small>${escapeHtml(player.name.split(' ').slice(-1)[0])}</small></div>`).join('')}</div>`).join('')}</div>`;
}

function renderLineups(data) {
  if (!data || !data.confirmed) return '<div class="md-section"><div class="md-section-title">Line-ups</div><div class="md-empty">Teams have not been announced.</div></div>';
  return `<div class="md-section"><div class="md-section-title">Confirmed line-ups</div><div class="lineups-grid">${data.lineups.map(team => {
    const playerRow = player => `<li><span class="squad-number">${escapeHtml(player.shirtNumber || '–')}</span><span>${escapeHtml(player.name)}${player.captain ? ' <strong class="captain">C</strong>' : ''}</span><span class="player-position">${escapeHtml(player.position)}</span></li>`;
    return `<div class="lineup-team"><div class="lineup-head">${team.crest ? `<img src="${escapeHtml(team.crest)}" data-fallback="/icon.svg" alt="">` : ''}<div><strong>${escapeHtml(team.team)}</strong>${team.formation ? `<span>${escapeHtml(team.formation)}</span>` : ''}</div></div>${renderFormation(team)}<ol class="player-list">${team.starters.map(playerRow).join('')}</ol><div class="subs-title">Substitutes</div><ul class="player-list substitutes">${team.substitutes.map(playerRow).join('')}</ul></div>`;
  }).join('')}</div></div>`;
}

function renderDetail(fixture, timeline, stats, lineups) {
  const score = hasScore(fixture) ? `${fixture.homeScore} – ${fixture.awayScore}` : 'v';
  const timelineHtml = timeline.length ? `<div class="md-section"><div class="md-section-title">Match events</div><div class="md-list">${timeline.map(event => {
    const away = event.strTeam && teamKey(event.strTeam) === teamKey(fixture.away.name);
    const kind = String(event.strTimeline || '').toLowerCase();
    const detail = String(event.strTimelineDetail || '').toLowerCase();
    const icon = kind.includes('goal') || detail.includes('goal') ? '⚽' : kind.includes('card') || detail.includes('card') ? (detail.includes('red') ? '🟥' : '🟨') : kind.includes('subst') ? '🔁' : '•';
    return `<div class="md-item${away ? ' away' : ''}"><span class="md-min">${escapeHtml(event.intTime ? `${event.intTime}'` : '')}</span><span>${icon}</span><span class="md-who">${escapeHtml(event.strPlayer || event.strTimeline || '')}${event.strAssist ? ` <span class="md-sub">(${escapeHtml(event.strAssist)})</span>` : ''}</span></div>`;
  }).join('')}</div></div>` : '<div class="md-section"><div class="md-section-title">Match events</div><div class="md-empty">No match events reported yet.</div></div>';
  const statHtml = stats.length ? `<div class="md-section"><div class="md-section-title">Match statistics</div>${stats.slice(0, 10).map(stat => `<div class="md-stat"><span class="md-stat-value">${escapeHtml(stat.intHome)}</span><span class="md-stat-label">${escapeHtml(stat.strStat)}</span><span class="md-stat-value">${escapeHtml(stat.intAway)}</span></div>`).join('')}</div>` : '';
  return `<div class="md-head"><span>${escapeHtml(fixture.home.name)} ${score} ${escapeHtml(fixture.away.name)}</span><span>${escapeHtml(statusLabel(fixture))}</span></div>${timelineHtml}${statHtml}${renderLineups(lineups)}`;
}

function selectedNewsClubs() {
  if (!state.newsFilterClubs || !state.newsSelectedClubs.size) return [];
  return [...state.newsSelectedClubs].map(key => state.clubs.get(key)?.name).filter(Boolean).sort();
}

function newsDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function renderNews() {
  const grid = $('#news-grid');
  if (!grid) return;
  const clubs = selectedNewsClubs();
  $('#news-filter-label').textContent = clubs.length ? (clubs.length === 1 ? clubs[0] : `${clubs.length} clubs`) : 'All clubs';
  if (state.newsLoading) {
    grid.innerHTML = '<div class="loading-dots">Loading news</div>';
    return;
  }
  if (!state.news.length) {
    grid.innerHTML = '<div class="empty-state"><h2>No matching headlines</h2><p>Try clearing the club filter or check again shortly.</p></div>';
    return;
  }
  const favoriteName = state.favoriteClub && state.clubs.get(state.favoriteClub)?.name;
  const articles = [...state.news].sort((a, b) => favoriteName ? Number((b.clubs || []).includes(favoriteName)) - Number((a.clubs || []).includes(favoriteName)) : 0);
  grid.innerHTML = articles.map(article => `<article class="news-card"><h2><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)}</a></h2><div class="news-meta"><span>${escapeHtml(article.source)}</span><time>${escapeHtml(newsDate(article.publishedAt))}</time></div></article>`).join('');
}

async function loadNews(force = false) {
  const clubs = selectedNewsClubs();
  const key = clubs.join('|') || 'all';
  if (!force && (state.newsKey === key || state.newsLoading)) {
    renderNews();
    return;
  }
  state.newsKey = key;
  state.newsLoading = true;
  renderNews();
  try {
    const query = clubs.length ? `?clubs=${encodeURIComponent(clubs.join('|'))}` : '';
    const data = await fetchJSON(`/api/news${query}`);
    if (state.newsKey !== key) return;
    state.news = data.articles || [];
  } catch (_) {
    if (state.newsKey === key) state.news = [];
  } finally {
    if (state.newsKey === key) {
      state.newsLoading = false;
      renderNews();
    }
  }
}

function newsFilterChanged() {
  state.newsKey = '';
  if ($('#tab-news')?.classList.contains('visible')) loadNews(true);
  else renderNews();
}

function switchTab(tab, clearHash = true) {
  $$('.tab-btn').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.section').forEach(section => section.classList.remove('visible'));
  $(`#tab-${tab}`)?.classList.add('visible');
  if (clearHash && tab !== 'club' && location.hash.startsWith('#club=')) history.replaceState(null, '', location.pathname + location.search);
  if (tab === 'news') loadNews();
}

function openClub(name, updateHash = true) {
  renderClubPage(name);
  switchTab('club', false);
  if (updateHash) history.pushState(null, '', clubUrl(name));
  $('#tab-club')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function dismissPlayerProfile() {
  const dialog = $('#player-dialog');
  if (!dialog.open) return;
  if (history.state?.playerDialog) history.back();
  else dialog.close();
}

function openHashClub() {
  const match = location.hash.match(/^#club=(.+)$/);
  if (!match) return false;
  openClub(decodeURIComponent(match[1]), false);
  return true;
}

function rerenderOpenClub() {
  const match = location.hash.match(/^#club=(.+)$/);
  if (match && $('#tab-club').classList.contains('visible')) renderClubPage(decodeURIComponent(match[1]));
}

function renderClubPicker() {
  const clubs = [...state.clubs.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  $('#team-picker-grid').innerHTML = clubs.map(([key, club]) => `<label class="team-choice"><input type="checkbox" value="${escapeHtml(key)}"${state.selectedClubs.has(key) ? ' checked' : ''}>${crestHtml(club)}<span>${escapeHtml(club.name)}</span></label>`).join('');
  updateClubPickerButton();
}

function renderNewsClubPicker() {
  const clubs = [...state.clubs.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  $('#news-team-picker-grid').innerHTML = clubs.map(([key, club]) => `<label class="team-choice"><input type="checkbox" value="${escapeHtml(key)}"${state.newsSelectedClubs.has(key) ? ' checked' : ''}>${crestHtml(club)}<span>${escapeHtml(club.name)}</span></label>`).join('');
  updateNewsClubPickerButton();
}

function updateClubPickerButton() {
  $('#team-picker').classList.toggle('disabled', !state.filterClubs);
  const count = state.selectedClubs.size;
  $('#team-picker-btn').textContent = !state.filterClubs ? (count ? `Clubs off (${count})` : 'Clubs off') : count === 0 ? 'Clubs: All' : count === 1 ? state.clubs.get([...state.selectedClubs][0])?.name || '1 club' : `Clubs: ${count}`;
}

function updateNewsClubPickerButton() {
  $('#news-team-picker').classList.toggle('disabled', !state.newsFilterClubs);
  const count = state.newsSelectedClubs.size;
  $('#news-team-picker-btn').textContent = !state.newsFilterClubs ? (count ? `Clubs off (${count})` : 'Clubs off') : count === 0 ? 'Clubs: All' : count === 1 ? state.clubs.get([...state.newsSelectedClubs][0])?.name || '1 club' : `Clubs: ${count}`;
}

function installEvents() {
  $$('.tab-btn').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  $('#player-dialog-close').addEventListener('click', dismissPlayerProfile);
  $('#player-dialog').addEventListener('click', event => { if (event.target === $('#player-dialog')) dismissPlayerProfile(); });
  $('#player-dialog').addEventListener('cancel', event => { event.preventDefault(); dismissPlayerProfile(); });
  $('#player-dialog').addEventListener('close', () => document.body.classList.remove('dialog-open'));
  $('#data-health-toggle').addEventListener('click', () => {
    const panel = $('#data-health-panel');
    const open = panel.hidden;
    panel.hidden = !open;
    $('#data-health-toggle').setAttribute('aria-expanded', String(open));
    renderDataHealth();
  });

  $('#filter-clubs').addEventListener('change', event => {
    state.filterClubs = event.target.checked;
    updateClubPickerButton();
    renderFixtures();
    savePreferences();
  });
  $('#filter-europe').addEventListener('change', event => {
    state.includeEurope = event.target.checked;
    renderFixtures();
    savePreferences();
  });
  $('#filter-completed').addEventListener('change', event => {
    state.hideCompleted = event.target.checked;
    renderFixtures();
    savePreferences();
  });
  $('#team-picker-btn').addEventListener('click', () => $('#team-picker').classList.toggle('open'));
  $('#team-clear').addEventListener('click', () => {
    state.selectedClubs.clear();
    state.filterClubs = false;
    $('#filter-clubs').checked = false;
    renderClubPicker();
    renderFixtures();
    savePreferences();
  });
  $('#team-picker-grid').addEventListener('change', event => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) state.selectedClubs.add(input.value); else state.selectedClubs.delete(input.value);
    if (state.selectedClubs.size) state.filterClubs = true;
    $('#filter-clubs').checked = state.filterClubs;
    updateClubPickerButton();
    renderFixtures();
    savePreferences();
  });
  $('#news-filter-clubs').addEventListener('change', event => {
    state.newsFilterClubs = event.target.checked;
    updateNewsClubPickerButton();
    newsFilterChanged();
    savePreferences();
  });
  $('#news-team-picker-btn').addEventListener('click', () => $('#news-team-picker').classList.toggle('open'));
  $('#news-team-clear').addEventListener('click', () => {
    state.newsSelectedClubs.clear();
    state.newsFilterClubs = false;
    $('#news-filter-clubs').checked = false;
    renderNewsClubPicker();
    newsFilterChanged();
    savePreferences();
  });
  $('#news-team-picker-grid').addEventListener('change', event => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) state.newsSelectedClubs.add(input.value); else state.newsSelectedClubs.delete(input.value);
    if (state.newsSelectedClubs.size) state.newsFilterClubs = true;
    $('#news-filter-clubs').checked = state.newsFilterClubs;
    updateNewsClubPickerButton();
    newsFilterChanged();
    savePreferences();
  });
  document.addEventListener('error', event => {
    const image = event.target.closest && event.target.closest('img[data-fallback]');
    if (!image || image.dataset.fallbackApplied) return;
    image.dataset.fallbackApplied = 'true';
    image.src = image.dataset.fallback;
  }, true);
  document.addEventListener('click', event => {
    if (!$('#team-picker').contains(event.target)) $('#team-picker').classList.remove('open');
    if (!$('#news-team-picker').contains(event.target)) $('#news-team-picker').classList.remove('open');
    const player = event.target.closest('[data-player-id]');
    if (player) {
      openPlayerProfile(player.dataset.playerId, player.dataset.playerClub || '');
      return;
    }
    const favorite = event.target.closest('[data-favorite-club]');
    if (favorite) {
      const key = favorite.dataset.favoriteClub;
      state.favoriteClub = state.favoriteClub === key ? '' : key;
      savePreferences();
      updateFavoriteClubUI();
      renderFixtures();
      updateNextMatch();
      renderClubPage(state.clubs.get(key)?.name || '');
      return;
    }
    const club = event.target.closest('[data-club]');
    if (club) { event.preventDefault(); openClub(club.dataset.club); }
  });
  $('#fixture-list').addEventListener('click', event => {
    const lineupButton = event.target.closest('.lineup-pill');
    if (lineupButton) {
      openMatchDetail(lineupButton.closest('.match-row'));
      return;
    }
    const spoiler = event.target.closest('.spoiler');
    if (spoiler) {
      const row = spoiler.closest('.match-row');
      spoiler.classList.remove('spoiler');
      state.revealed.add(row.dataset.id);
      savePreferences();
      return;
    }
    if (event.target.closest('a')) return;
    const row = event.target.closest('.match-row.is-live, .match-row.has-lineups');
    if (row) openMatchDetail(row);
  });
  window.addEventListener('hashchange', openHashClub);
  window.addEventListener('popstate', event => {
    if ($('#player-dialog').open && !event.state?.playerDialog) $('#player-dialog').close();
    openHashClub();
  });
  $('#jump-next').addEventListener('click', () => {
    const fixture = state.fixtures.find(isLive) || state.fixtures.find(item => !isFinal(item) && !isPostponed(item) && fixtureTime(item) > Date.now());
    if (fixture) $(`.match-row[data-id="${CSS.escape(fixture.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#jump-today').addEventListener('click', () => {
    const today = new Intl.DateTimeFormat('en-GB', { timeZone: effectiveTimeZone(), weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    $$('.day-divider').find(divider => divider.textContent === today)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#jump-filters').addEventListener('click', () => $('#tab-fixtures .round-label').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

async function initialise() {
  loadPreferences();
  installEvents();
  $('#filter-clubs').checked = state.filterClubs;
  $('#news-filter-clubs').checked = state.newsFilterClubs;
  $('#filter-europe').checked = state.includeEurope;
  $('#filter-completed').checked = state.hideCompleted;

  try {
    const result = await loadOfficialFixtures();
    state.fixtures = result.fixtures.sort((a, b) => fixtureTime(a) - fixtureTime(b));
    state.source = result.source;
    if (DEMO_LIVE) applyLiveDemo();
    await loadStandings();
    registerClubs();
    updateFavoriteClubUI();
    const europeanFixtures = await loadEuropeanFixtures();
    state.fixtures.push(...europeanFixtures);
    state.fixtures.sort((a, b) => fixtureTime(a) - fixtureTime(b));
    renderClubPicker();
    renderNewsClubPicker();
    renderFixtures();
    renderTable();
    updateSummary();
    renderDataHealth();
    setFeedStatus(DEMO_LIVE ? 'live' : 'ok', DEMO_LIVE ? '● Demo match live — simulated data' : `${state.source} fixture data loaded`);
  } catch (error) {
    state.health.league = { ok: false, error: error.message, updatedAt: new Date().toISOString() };
    state.fixtures = [];
    state.standings = [];
    renderFixtures();
    renderTable();
    updateSummary();
    renderDataHealth();
    setFeedStatus('off', 'Fixture providers unavailable — retry on refresh');
  }

  openHashClub();
  setInterval(updateNextMatch, 30_000);
  if (!DEMO_LIVE) refreshLiveScores();
}

initialise();
