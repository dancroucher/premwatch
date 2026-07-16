const FEEDS = [
  { source: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { source: 'Sky Sports', url: 'https://www.skysports.com/rss/12040' },
  { source: 'The Guardian', url: 'https://www.theguardian.com/football/rss' }
];

const CLUBS = [
  { name: 'Arsenal', aliases: ['arsenal', 'gunners'] },
  { name: 'Aston Villa', aliases: ['aston villa'] },
  { name: 'Bournemouth', aliases: ['bournemouth', 'afc bournemouth'] },
  { name: 'Brentford', aliases: ['brentford'] },
  { name: 'Brighton & Hove Albion', aliases: ['brighton', 'brighton & hove albion'] },
  { name: 'Chelsea', aliases: ['chelsea'] },
  { name: 'Coventry City', aliases: ['coventry', 'coventry city'] },
  { name: 'Crystal Palace', aliases: ['crystal palace'] },
  { name: 'Everton', aliases: ['everton'] },
  { name: 'Fulham', aliases: ['fulham'] },
  { name: 'Hull City', aliases: ['hull city'] },
  { name: 'Ipswich Town', aliases: ['ipswich', 'ipswich town'] },
  { name: 'Leeds United', aliases: ['leeds', 'leeds united'] },
  { name: 'Liverpool', aliases: ['liverpool'] },
  { name: 'Manchester City', aliases: ['manchester city', 'man city'] },
  { name: 'Manchester United', aliases: ['manchester united', 'man utd', 'man united'] },
  { name: 'Newcastle United', aliases: ['newcastle', 'newcastle united'] },
  { name: 'Nottingham Forest', aliases: ['nottingham forest', 'nottm forest'] },
  { name: 'Sunderland', aliases: ['sunderland'] },
  { name: 'Tottenham Hotspur', aliases: ['tottenham', 'spurs', 'tottenham hotspur'] }
];

function decode(value) {
  return String(value || '')
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&#(\d+);/g, (_, number) => String.fromCharCode(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCharCode(parseInt(number, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .trim();
}

function text(value) {
  return decode(String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function element(item, tag) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decode(match[1]) : '';
}

function articleLink(item) {
  const raw = element(item, 'link');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.hostname.includes('bing.com')) {
      const target = url.searchParams.get('url');
      if (target) return decodeURIComponent(target);
    }
    return raw;
  } catch (_) {
    return '';
  }
}

function matchingClubs(value) {
  const haystack = ` ${text(value).toLowerCase()} `;
  return CLUBS.filter(club => club.aliases.some(alias => haystack.includes(alias))).map(club => club.name);
}

function parseFeed(xml, fallbackSource, forcedClub = '') {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 60).map(match => {
    const item = match[0];
    const title = text(element(item, 'title'));
    const description = text(element(item, 'description'));
    const source = text(element(item, 'News:Source') || element(item, 'source') || fallbackSource);
    const clubs = matchingClubs(`${title} ${description}`);
    if (forcedClub && !clubs.includes(forcedClub)) clubs.push(forcedClub);
    return {
      title,
      description,
      link: articleLink(item),
      source,
      publishedAt: element(item, 'pubDate'),
      clubs
    };
  }).filter(article => article.title && article.link);
}

async function fetchText(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'Premier-League-News/1.0' }
  });
  if (!response.ok) throw new Error(`News feed HTTP ${response.status}`);
  return response.text();
}

function selectedClubs(raw) {
  const wanted = String(raw || '').split('|').map(value => value.trim().toLowerCase()).filter(Boolean);
  return CLUBS.filter(club => wanted.includes(club.name.toLowerCase()));
}

async function bingArticles(clubs) {
  let searches;
  if (!clubs.length) searches = [{ query: 'Premier League football', club: '' }];
  else if (clubs.length <= 6) searches = clubs.map(club => ({ query: `Premier League "${club.name}"`, club: club.name }));
  else {
    searches = [];
    for (let index = 0; index < clubs.length; index += 5) {
      const group = clubs.slice(index, index + 5);
      searches.push({ query: `Premier League (${group.map(club => `"${club.name}"`).join(' OR ')})`, club: '' });
    }
  }
  const results = await Promise.allSettled(searches.map(async search => {
    const url = `https://www.bing.com/news/search?q=${encodeURIComponent(search.query)}&format=rss`;
    return parseFeed(await fetchText(url), 'Bing News', search.club);
  }));
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

export default async function handler(req, res) {
  const clubs = selectedClubs(req.query.clubs);
  const results = await Promise.allSettled([
    bingArticles(clubs),
    ...FEEDS.map(async feed => parseFeed(await fetchText(feed.url), feed.source))
  ]);
  let articles = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const filterNames = new Set(clubs.map(club => club.name));
  articles = articles.filter(article => {
    if (filterNames.size) return article.clubs.some(club => filterNames.has(club));
    return article.clubs.length || /premier league/i.test(`${article.title} ${article.description}`);
  });

  const seen = new Set();
  articles = articles.filter(article => {
    const key = article.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()).slice(0, 60);

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
  res.status(200).json({ articles, filteredClubs: clubs.map(club => club.name), sources: ['Bing News', ...FEEDS.map(feed => feed.source)] });
}
