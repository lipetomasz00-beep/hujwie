// src/server/router.js

let offersDB = [
  {
    id: "1",
    name: "Kredyt bez BIK",
    url: "https://tmlead.pl/redirect/388900_1134",
    category: "risk",
    payout: 120,
    views: 1,
    conversions: 0,
  },
  {
    id: "2",
    name: "Standard kredyt",
    url: "https://tmlead.pl/redirect/388900_1134",
    category: "credit",
    payout: 80,
    views: 1,
    conversions: 0,
  }
];

/* ======================
   🧠 AUTO LEARNING SCORE
====================== */
function scoreOffer(offer, profile) {
  let score = 0;

  // 🎯 dopasowanie usera
  if (profile?.step1 === "zła" && offer.category === "risk") {
    score += 5;
  }

  if (profile?.step4 === "kredyt" && offer.category === "credit") {
    score += 3;
  }

  // 💰 payout
  score += offer.payout * 0.05;

  // 📊 conversion rate (auto learning)
  const conversionRate = offer.conversions / offer.views;
  score += conversionRate * 20;

  return score;
}

/* ======================
   🥇 PICK BEST OFFER
====================== */
function pickBestOffer(profile) {
  let best = null;
  let bestScore = -999;

  for (let offer of offersDB) {
    const score = scoreOffer(offer, profile);

    if (score > bestScore) {
      bestScore = score;
      best = offer;
    }
  }

  // 🔥 learning: zwiększ views
  best.views += 1;

  return best;
}

/* ======================
   📦 GET OFFERS FOR USER
====================== */
export async function getOffersForProfile(profile) {
  const best = pickBestOffer(profile);
  return best;
}

/* ======================
   🔁 ROUTE OFFER BY ID
====================== */
export async function routeOffer(offerId) {
  return offersDB.find(o => o.id === offerId);
}

/* ======================
   💰 TRACK CONVERSION (AUTO LEARNING)
====================== */
export async function registerConversion(offerId) {
  const offer = offersDB.find(o => o.id === offerId);

  if (offer) {
    offer.conversions += 1;
  }
}
