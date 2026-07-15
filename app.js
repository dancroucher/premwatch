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

const state = {
  fixtures: [],
  standings: [],
  clubs: new Map(),
  source: '',
  filterClubs: false,
  selectedClubs: new Set(),
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
    state.hideCompleted = !!prefs.hideCompleted;
    state.selectedClubs = new Set(Array.isArray(prefs.selectedClubs) ? prefs.selectedClubs : []);
    state.revealed = new Set(Array.isArray(prefs.revealed) ? prefs.revealed : []);
  } catch (_) { /* storage is optional */ }
}

function savePreferences() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      filterClubs: state.filterClubs,
      hideCompleted: state.hideCompleted,
      selectedClubs: [...state.selectedClubs],
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
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).format(date);
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
    .replace(/^afcbournemouth$/, 'bournemouth');
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
    referee: event.strReferee || ''
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
  const fixtures = (data.events || []).map(event => normaliseFixture(event, data.provider || 'football-feed'));
  if (isCompleteFixtureList(fixtures)) return { fixtures, source: data.provider || 'Premier League feed' };
  throw new Error(`Fixture provider returned ${fixtures.length} of ${COMPETITION.expectedFixtures} fixtures`);
}

async function loadStandings() {
  try {
    const data = await fetchJSON('/api/live?type=standings');
    state.standings = data.standings || [];
  } catch (_) {
    state.standings = calculateStandings();
  }
}

function registerClubs() {
  state.clubs = new Map();
  for (const fixture of state.fixtures) {
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
  if (club.crest) return `<img class="club-crest${large ? ' large' : ''}" src="${escapeHtml(club.crest)}" alt="" loading="lazy">`;
  return `<span class="club-crest${large ? ' large' : ''}" aria-hidden="true"></span>`;
}

function clubUrl(name) {
  return `#club=${encodeURIComponent(name)}`;
}

function clubLink(club) {
  return `<a class="club-name" href="${clubUrl(club.name)}" data-club="${escapeHtml(club.name)}">${escapeHtml(club.name)}</a>`;
}

function renderFixture(fixture) {
  const parts = dateParts(fixture.kickoff);
  const live = isLive(fixture);
  const final = isFinal(fixture);
  const score = hasScore(fixture) ? `${fixture.homeScore} – ${fixture.awayScore}` : 'v';
  const hiddenScore = final && hasScore(fixture) && !state.revealed.has(fixture.id);
  const classes = ['match-row', final ? 'finished' : '', live ? 'is-live' : '', isPostponed(fixture) ? 'postponed' : ''].filter(Boolean).join(' ');
  const round = fixture.matchweek ? `MW ${fixture.matchweek}` : (fixture.round || 'League');
  const venue = [fixture.venue, fixture.city].filter(Boolean).join(', ') || 'Venue TBC';
  return `<div class="${classes}" data-id="${escapeHtml(fixture.id)}">
    <div class="row-meta"><span class="row-badge">${escapeHtml(round)}</span>${live ? `<span class="live-pill">${escapeHtml(statusLabel(fixture))}</span><span class="detail-caret">▾</span>` : `<span class="row-status">${escapeHtml(statusLabel(fixture))}</span>`}</div>
    <div class="row-teams">
      <span class="row-team home">${clubLink(fixture.home)}${crestHtml(fixture.home)}</span>
      <span class="vs${hasScore(fixture) ? ' score' : ''}${hiddenScore ? ' spoiler' : ''}" title="${hiddenScore ? 'Reveal score' : ''}">${score}</span>
      <span class="row-team away">${crestHtml(fixture.away)}${clubLink(fixture.away)}</span>
    </div>
    <div class="row-when"><span class="row-date">${escapeHtml(parts.date)}</span><span class="row-time">${escapeHtml(parts.time)}<span class="row-tz">${escapeHtml(parts.zone)}</span></span></div>
    <div class="row-venue" title="${escapeHtml(venue)}">${escapeHtml(venue)}</div>
  </div>`;
}

function visibleFixtures() {
  return state.fixtures.filter(fixture => {
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
  const fixtures = visibleFixtures();
  for (const fixture of fixtures) {
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
    <tbody>${rows.map((row, index) => `<tr><td>${row.rank || index + 1}</td><td class="club-col"><a class="table-club" href="${clubUrl(row.team)}" data-club="${escapeHtml(row.team)}">${row.crest ? `<img src="${escapeHtml(row.crest)}" alt="">` : ''}<span>${escapeHtml(row.team)}</span></a></td><td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td><td class="optional">${row.goalsFor}</td><td class="optional">${row.goalsAgainst}</td><td>${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}</td><td><strong>${row.points}</strong></td><td class="form optional">${escapeHtml(row.form || '')}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function fixtureMini(fixture) {
  const parts = dateParts(fixture.kickoff);
  const score = hasScore(fixture) ? `${fixture.homeScore} – ${fixture.awayScore}` : 'v';
  return `<div class="club-fixture${isFinal(fixture) ? ' finished' : ''}${isLive(fixture) ? ' live' : ''}"><div class="cf-meta"><span>${escapeHtml(fixture.matchweek ? `MW ${fixture.matchweek}` : fixture.round)}</span><span>${escapeHtml(isLive(fixture) || isFinal(fixture) ? statusLabel(fixture) : `${parts.date} · ${parts.time} ${parts.zone}`)}</span></div><div class="cf-teams">${escapeHtml(fixture.home.name)} <span class="vs${hasScore(fixture) ? ' score' : ''}">${score}</span> ${escapeHtml(fixture.away.name)}</div></div>`;
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
  target.innerHTML = `<div class="club-card"><div class="club-head">${crestHtml(club, true)}<div><div class="club-title">${escapeHtml(club.name)}</div><div class="club-meta">${tableRow ? `${tableRow.rank}${ordinal(tableRow.rank)} · ${tableRow.points} points · ${tableRow.played} played` : `${matches.length} fixtures`}</div></div></div><div class="club-sections"><div><div class="club-section-title">Upcoming fixtures</div>${upcoming.length ? upcoming.map(fixtureMini).join('') : '<p class="md-empty">No upcoming fixtures available.</p>'}</div><div><div class="club-section-title">Recent results</div>${completed.length ? completed.map(fixtureMini).join('') : '<p class="md-empty">No results yet.</p>'}</div></div></div>`;
}

function ordinal(number) {
  const value = Number(number);
  if (value % 100 >= 11 && value % 100 <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' })[value % 10] || 'th';
}

function updateNextMatch() {
  const target = $('#next-match');
  const live = state.fixtures.find(isLive);
  const now = Date.now();
  const next = live || state.fixtures.find(fixture => !isFinal(fixture) && !isPostponed(fixture) && fixtureTime(fixture) > now);
  if (!next) {
    target.innerHTML = state.fixtures.length ? '<strong>No upcoming fixture found</strong>' : '<strong>Awaiting the official fixture list</strong>';
    return;
  }
  const parts = dateParts(next.kickoff);
  const countdown = live ? statusLabel(next) : countdownText(fixtureTime(next) - now);
  target.innerHTML = `<strong>${live ? 'Live now' : 'Next match'}</strong><span>${escapeHtml(next.home.name)} v ${escapeHtml(next.away.name)}</span><span class="nm-muted">${escapeHtml(parts.date)} ${escapeHtml(parts.time)} ${escapeHtml(parts.zone)}</span><span class="nm-count">${escapeHtml(countdown)}</span>`;
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

function updateSummary() {
  const clubs = state.clubs.size;
  const complete = state.fixtures.length === COMPETITION.expectedFixtures;
  $('#season-summary').textContent = state.fixtures.length
    ? `${state.fixtures.length} fixtures${clubs ? ` · ${clubs} clubs` : ''}${complete ? '' : ' currently published'}`
    : 'Official fixtures have not been published by the configured feeds';
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
  const data = await fetchJSON('/api/live?type=feed');
  return { events: data.events || [], source: data.provider || 'football-feed' };
}

async function refreshLiveScores() {
  try {
    const result = await loadLiveEvents();
    const changed = mergeEvents(result.events, result.source);
    if (changed) {
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
  } catch (_) {
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
  if (!fixture || !isLive(fixture)) return;
  const panel = document.createElement('div');
  panel.className = 'match-detail';
  panel.innerHTML = '<div class="md-empty">Loading live match detail…</div>';
  row.insertAdjacentElement('afterend', panel);
  await refreshMatchDetail(fixture, row, panel);
}

async function refreshMatchDetail(fixture, row, panel) {
  try {
    let data;
    if (!fixture.providerFixtureId) throw new Error('No detail provider available');
    data = await fetchJSON(`/api/live?type=detail&id=${encodeURIComponent(fixture.providerFixtureId)}`);
    if (data.events && data.events.length) mergeEvents(data.events, fixture.source);
    panel.innerHTML = renderDetail(fixture, data.timeline || [], data.eventstats || []);
  } catch (_) {
    panel.innerHTML = '<div class="md-empty">Live detail is temporarily unavailable.</div>';
  }
  clearTimeout(state.detailTimers.get(fixture.id));
  if (document.body.contains(panel) && isLive(fixture)) {
    state.detailTimers.set(fixture.id, setTimeout(() => refreshMatchDetail(fixture, row, panel), DETAIL_POLL_MS));
  }
}

function renderDetail(fixture, timeline, stats) {
  const score = hasScore(fixture) ? `${fixture.homeScore} – ${fixture.awayScore}` : 'v';
  const timelineHtml = timeline.length ? `<div class="md-list">${timeline.map(event => {
    const away = event.strTeam && teamKey(event.strTeam) === teamKey(fixture.away.name);
    const kind = String(event.strTimeline || '').toLowerCase();
    const detail = String(event.strTimelineDetail || '').toLowerCase();
    const icon = kind.includes('goal') || detail.includes('goal') ? '⚽' : kind.includes('card') || detail.includes('card') ? (detail.includes('red') ? '🟥' : '🟨') : kind.includes('subst') ? '🔁' : '•';
    return `<div class="md-item${away ? ' away' : ''}"><span class="md-min">${escapeHtml(event.intTime ? `${event.intTime}'` : '')}</span><span>${icon}</span><span class="md-who">${escapeHtml(event.strPlayer || event.strTimeline || '')}${event.strAssist ? ` <span class="md-sub">(${escapeHtml(event.strAssist)})</span>` : ''}</span></div>`;
  }).join('')}</div>` : '<div class="md-empty">No match events reported yet.</div>';
  const statHtml = stats.length ? `<div class="md-section"><div class="md-section-title">Match statistics</div>${stats.slice(0, 10).map(stat => `<div class="md-stat"><span class="md-stat-value">${escapeHtml(stat.intHome)}</span><span class="md-stat-label">${escapeHtml(stat.strStat)}</span><span class="md-stat-value">${escapeHtml(stat.intAway)}</span></div>`).join('')}</div>` : '';
  return `<div class="md-head"><span>${escapeHtml(fixture.home.name)} ${score} ${escapeHtml(fixture.away.name)}</span><span>${escapeHtml(statusLabel(fixture))}</span></div>${timelineHtml}${statHtml}`;
}

function switchTab(tab, clearHash = true) {
  $$('.tab-btn').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.section').forEach(section => section.classList.remove('visible'));
  $(`#tab-${tab}`)?.classList.add('visible');
  if (clearHash && tab !== 'club' && location.hash.startsWith('#club=')) history.replaceState(null, '', location.pathname + location.search);
}

function openClub(name, updateHash = true) {
  renderClubPage(name);
  switchTab('club', false);
  if (updateHash) history.pushState(null, '', clubUrl(name));
  $('#tab-club')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

function updateClubPickerButton() {
  $('#team-picker').classList.toggle('disabled', !state.filterClubs);
  const count = state.selectedClubs.size;
  $('#team-picker-btn').textContent = !state.filterClubs ? (count ? `Clubs off (${count})` : 'Clubs off') : count === 0 ? 'Clubs: All' : count === 1 ? state.clubs.get([...state.selectedClubs][0])?.name || '1 club' : `Clubs: ${count}`;
}

function installEvents() {
  $$('.tab-btn').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));

  $('#filter-clubs').addEventListener('change', event => {
    state.filterClubs = event.target.checked;
    updateClubPickerButton();
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
  document.addEventListener('click', event => {
    if (!$('#team-picker').contains(event.target)) $('#team-picker').classList.remove('open');
    const club = event.target.closest('[data-club]');
    if (club) { event.preventDefault(); openClub(club.dataset.club); }
  });
  $('#fixture-list').addEventListener('click', event => {
    const spoiler = event.target.closest('.spoiler');
    if (spoiler) {
      const row = spoiler.closest('.match-row');
      spoiler.classList.remove('spoiler');
      state.revealed.add(row.dataset.id);
      savePreferences();
      return;
    }
    if (event.target.closest('a')) return;
    const row = event.target.closest('.match-row.is-live');
    if (row) openMatchDetail(row);
  });
  window.addEventListener('hashchange', openHashClub);
  window.addEventListener('popstate', openHashClub);
  $('#jump-next').addEventListener('click', () => {
    const fixture = state.fixtures.find(isLive) || state.fixtures.find(item => !isFinal(item) && !isPostponed(item) && fixtureTime(item) > Date.now());
    if (fixture) $(`.match-row[data-id="${CSS.escape(fixture.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#jump-today').addEventListener('click', () => {
    const today = new Intl.DateTimeFormat('en-GB', { timeZone: effectiveTimeZone(), weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    $$('.day-divider').find(divider => divider.textContent === today)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#jump-filters').addEventListener('click', () => $('#tab-fixtures .round-label').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

async function initialise() {
  loadPreferences();
  installEvents();
  $('#filter-clubs').checked = state.filterClubs;
  $('#filter-completed').checked = state.hideCompleted;

  try {
    const result = await loadOfficialFixtures();
    state.fixtures = result.fixtures.sort((a, b) => fixtureTime(a) - fixtureTime(b));
    state.source = result.source;
    await loadStandings();
    registerClubs();
    renderClubPicker();
    renderFixtures();
    renderTable();
    updateSummary();
    setFeedStatus('ok', `${state.source} fixture data loaded`);
  } catch (_) {
    state.fixtures = [];
    state.standings = [];
    renderFixtures();
    renderTable();
    updateSummary();
    setFeedStatus('off', 'Fixture providers unavailable — retry on refresh');
  }

  openHashClub();
  setInterval(updateNextMatch, 30_000);
  refreshLiveScores();
}

initialise();
