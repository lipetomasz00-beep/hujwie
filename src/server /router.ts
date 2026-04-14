import * as cheerio from 'cheerio';

export interface Offer {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  url: string;
  sourcePage?: string;
  features?: string[];
}

type UserProfile = {
  goal?: string;
  amount?: string;
  time?: string;
  score?: string;
};

const BASE_URL = 'https://toomasz-money.oferty-kredytowe.pl';
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_PAGES = 40;
const REQUEST_TIMEOUT_MS = 6000;

const GOAL_KEYWORDS: Record<string, string[]> = {
  business: ['firm', 'biznes', 'dzialalnosc', 'przedsiebior'],
  cash: ['kredyt gotowk', 'pozyczk', 'chwilowk', 'gotowk'],
  debt: ['konsolidac', 'oddlu', 'rat'],
  house: ['hipotek', 'mieszk', 'nieruchom'],
  car: ['auto', 'samoch', 'car', 'leasing'],
  insurance: ['ubezpieczen', 'oc', 'ac']
};

let offersCache: { at: number; offers: Offer[] } | null = null;
const performanceMap: Record<string, { views: number; conversions: number }> = {};

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildOfferId(url: string): string {
  const normalized = normalizeText(url);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `m2m-${hash.toString(16)}`;
}

function resolveUrl(href: string, currentUrl: string): string | null {
  try {
    const absolute = new URL(href, currentUrl);
    const root = new URL(BASE_URL);

    if (absolute.origin !== root.origin) return null;
    absolute.hash = '';

    // Odrzucamy zasoby statyczne
    if (/\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|css|js)$/i.test(absolute.pathname)) {
      return null;
    }

    return absolute.toString();
  } catch {
    return null;
  }
}

function inferCategory(pathText: string): { category: string; subcategory?: string } {
  const p = normalizeText(pathText);

  if (p.includes('konta-dla-firm')) return { category: 'business', subcategory: 'konta-dla-firm' };
  if (p.includes('kredyty-dla-firm')) return { category: 'business', subcategory: 'kredyty-dla-firm' };
  if (p.includes('kredyty-konsolidacyjne')) return { category: 'debt', subcategory: 'konsolidacja' };
  if (p.includes('kredyty-gotowkowe')) return { category: 'cash', subcategory: 'kredyty-gotowkowe' };
  if (p.includes('chwilowki')) return { category: 'cash', subcategory: 'chwilowki' };
  if (p.includes('pozyczki-bankowe-online')) return { category: 'cash', subcategory: 'pozyczki-bankowe-online' };
  if (p.includes('pozyczki')) return { category: 'cash', subcategory: 'pozyczki' };
  if (p.includes('ubezpieczenia-ac-oc')) return { category: 'insurance', subcategory: 'oc-ac' };
  if (p.includes('pozostale-ubezpieczenia')) return { category: 'insurance', subcategory: 'inne-ubezpieczenia' };
  if (p.includes('karty-kredytowe')) return { category: 'cash', subcategory: 'karty-kredytowe' };
  if (p.includes('konta-osobiste')) return { category: 'cash', subcategory: 'konta-osobiste' };
  if (p.includes('konta-oszczednosciowe')) return { category: 'cash', subcategory: 'konta-oszczednosciowe' };
  if (p.includes('lokaty-i-inwestycje')) return { category: 'cash', subcategory: 'lokaty-i-inwestycje' };

  return { category: 'cash' };
}

function isLikelyOfferLink(url: string, anchorText: string): boolean {
  const v = normalizeText(`${url} ${anchorText}`);
  return [
    'kredyt',
    'pozyczk',
    'chwilowk',
    'konta-',
    'ubezpieczen',
    'lokaty',
    'inwestycje',
    'karty-kredytowe',
    'dla-firm',
    'gotowk',
    'konsolidac'
  ].some((k) => v.includes(k));
}

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CashmakerBot/1.0 (+offer-matching)'
      }
    });

    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function crawlAllOffers(): Promise<Offer[]> {
  const toVisit: string[] = [BASE_URL, `${BASE_URL}/`];
  const visited = new Set<string>();
  const discovered = new Map<string, Offer>();

  while (toVisit.length > 0 && visited.size < MAX_PAGES) {
    const current = toVisit.shift();
    if (!current || visited.has(current)) continue;

    visited.add(current);

    const html = await fetchHtml(current);
    if (!html) continue;

    const $ = cheerio.load(html);

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const absolute = resolveUrl(href, current);
      if (!absolute) return;

      if (!visited.has(absolute) && !toVisit.includes(absolute)) {
        toVisit.push(absolute);
      }

      const anchorText = ($(el).text() || '').trim();
      if (!isLikelyOfferLink(absolute, anchorText)) return;

      const existing = discovered.get(absolute);
      if (existing) return;

      const inferred = inferCategory(`${absolute} ${anchorText}`);
      const slug = new URL(absolute).pathname.split('/').filter(Boolean).pop() || 'oferta';
      const prettyName = anchorText || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

      discovered.set(absolute, {
        id: buildOfferId(absolute),
        name: prettyName,
        category: inferred.category,
        subcategory: inferred.subcategory,
        url: absolute,
        sourcePage: current
      });
    });
  }

  return [...discovered.values()];
}

async function getDynamicOffers(): Promise<Offer[]> {
  if (offersCache && Date.now() - offersCache.at < CACHE_TTL_MS) {
    return offersCache.offers;
  }

  const offers = await crawlAllOffers();
  offersCache = { at: Date.now(), offers };
  return offers;
}

function scoreOfferForProfile(offer: Offer, profile: UserProfile): number {
  let score = 0;

  const goal = profile.goal || '';

  // 🎯 dopasowanie kategorii
  if (goal && offer.category === goal) score += 10;

  const haystack = normalizeText(`${offer.name} ${offer.category} ${offer.subcategory || ''} ${offer.url}`);

  const goalKeywords = GOAL_KEYWORDS[goal] || [];
  for (const k of goalKeywords) {
    if (haystack.includes(k)) score += 2;
  }

  // 🧠 profil usera
  if (profile.amount === 'small' && haystack.includes('chwilow')) score += 2;
  if (profile.amount === 'huge' && haystack.includes('hipotek')) score += 2;
  if (profile.time === 'fast' && haystack.includes('online')) score += 2;
  if (profile.score === 'bad' && haystack.includes('konsolid')) score += 3;

  // 🔥 AUTO LEARNING (NOWE)
  const perf = performanceMap[offer.id] || { views: 1, conversions: 0 };
  const conversionRate = perf.conversions / perf.views;

  score += conversionRate * 20;

  return score;
  }

  const filtered = profile.goal ? offers.filter((o) => o.category === profile.goal) : offers;
  const candidatePool = filtered.length > 0 ? filtered : offers;

  const ranked = candidatePool
  .map((offer) => ({ offer, score: scoreOfferForProfile(offer, profile) }))
  .sort((a, b) => b.score - a.score)
  .map((x) => x.offer);

// 🔥 AUTO LEARNING — zapis views
if (ranked[0]) {
  const id = ranked[0].id;

  performanceMap[id] = performanceMap[id] || { views: 0, conversions: 0 };
  performanceMap[id].views += 1;
}

return ranked;
}

export async function routeOffer(offerId: string): Promise<Offer | undefined> {
  const offers = await getDynamicOffers();
  return offers.find((o) => o.id === offerId);
}
