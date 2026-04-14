// src/server/router.ts

import * as cheerio from 'cheerio';

/* ======================
   📦 TYPES
====================== */
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

/* ======================
   ⚙️ CONFIG
====================== */
const BASE_URL = 'https://toomasz-money.oferty-kredytowe.pl';
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_PAGES = 40;
const REQUEST_TIMEOUT_MS = 6000;

/* ======================
   🧠 LEARNING MEMORY
====================== */
const performanceMap: Record<string, { views: number; conversions: number }> = {};

/* ======================
   🎯 KEYWORDS
====================== */
const GOAL_KEYWORDS: Record<string, string[]> = {
  business: ['firm', 'biznes', 'dzialalnosc', 'przedsiebior'],
  cash: ['kredyt gotowk', 'pozyczk', 'chwilowk', 'gotowk'],
  debt: ['konsolidac', 'oddlu', 'rat'],
  house: ['hipotek', 'mieszk', 'nieruchom'],
  car: ['auto', 'samoch', 'car', 'leasing'],
  insurance: ['ubezpieczen', 'oc', 'ac']
};

let offersCache: { at: number; offers: Offer[] } | null = null;

/* ======================
   🧹 UTILS
====================== */
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

    if (/\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|css|js)$/i.test(absolute.pathname)) {
      return null;
    }

    return absolute.toString();
  } catch {
    return null;
  }
}

/* ======================
   🧠 CATEGORY
====================== */
function inferCategory(pathText: string): { category: string; subcategory?: string } {
  const p = normalizeText(pathText);

  if (p.includes('konsolidac')) return { category: 'debt' };
  if (p.includes('firm')) return { category: 'business' };
  if (p.includes('ubezpieczen')) return { category: 'insurance' };
  if (p.includes('hipotek')) return { category: 'house' };

  return { category: 'cash' };
}

/* ======================
   🔍 FILTER
====================== */
function isLikelyOfferLink(url: string, text: string): boolean {
  const v = normalizeText(`${url} ${text}`);
  return ['kredyt', 'pozyczk', 'chwilowk', 'konsolidac', 'ubezpieczen']
    .some(k => v.includes(k));
}

/* ======================
   🌐 FETCH
====================== */
async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ======================
   🕷 CRAWLER
====================== */
async function crawlAllOffers(): Promise<Offer[]> {
  const toVisit = [BASE_URL];
  const visited = new Set<string>();
  const found = new Map<string, Offer>();

  while (toVisit.length && visited.size < MAX_PAGES) {
    const current = toVisit.shift();
    if (!current || visited.has(current)) continue;

    visited.add(current);

    const html = await fetchHtml(current);
    if (!html) continue;

    const $ = cheerio.load(html);

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const url = resolveUrl(href, current);
      if (!url) return;

      if (!visited.has(url)) toVisit.push(url);

      const text = ($(el).text() || '').trim();
      if (!isLikelyOfferLink(url, text)) return;

      if (found.has(url)) return;

      const cat = inferCategory(url + text);

      found.set(url, {
        id: buildOfferId(url),
        name: text || 'Oferta',
        url,
        category: cat.category
      });
    });
  }

  return [...found.values()];
}

/* ======================
   📦 CACHE
====================== */
async function getDynamicOffers(): Promise<Offer[]> {
  if (offersCache && Date.now() - offersCache.at < CACHE_TTL_MS) {
    return offersCache.offers;
  }

  const offers = await crawlAllOffers();
  offersCache = { at: Date.now(), offers };
  return offers;
}

/* ======================
   🧠 AI SCORING + LEARNING
====================== */
function scoreOffer(offer: Offer, profile: UserProfile): number {
  let score = 0;

  if (profile.goal && offer.category === profile.goal) score += 10;

  const text = normalizeText(`${offer.name} ${offer.url}`);

  const keywords = GOAL_KEYWORDS[profile.goal || ''] || [];
  for (const k of keywords) {
    if (text.includes(k)) score += 2;
  }

  // 🔥 LEARNING
  const perf = performanceMap[offer.id] || { views: 1, conversions: 0 };
  const cr = perf.conversions / perf.views;

  score += cr * 20;

  return score;
}

/* ======================
   🚀 MAIN ENGINE
====================== */
export async function getOffersForProfile(profile: UserProfile): Promise<Offer[]> {
  const offers = await getDynamicOffers();

  const ranked = offers
    .map(o => ({ offer: o, score: scoreOffer(o, profile) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.offer);

  // 🔥 zapis views
  if (ranked[0]) {
    const id = ranked[0].id;
    performanceMap[id] = performanceMap[id] || { views: 0, conversions: 0 };
    performanceMap[id].views++;
  }

  return ranked;
}

/* ======================
   🔁 ROUTE
====================== */
export async function routeOffer(offerId: string): Promise<Offer | undefined> {
  const offers = await getDynamicOffers();
  return offers.find(o => o.id === offerId);
}

/* ======================
   💰 CONVERSION TRACK
====================== */
export function registerConversion(offerId: string) {
  performanceMap[offerId] = performanceMap[offerId] || { views: 1, conversions: 0 };
  performanceMap[offerId].conversions++;
}
