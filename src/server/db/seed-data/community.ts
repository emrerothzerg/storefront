/**
 * Deterministic generator for seed reviews, questions and answers.
 * All names are invented; session ids are synthetic (`seed_session_NN`,
 * `seed_voter_NN`) and can never match a real session (real ids are UUIDs).
 */

import type { ContentStatus, StarRating } from "@/lib/types";

/** Small deterministic PRNG (mulberry32). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export const SEED_DISPLAY_NAMES: readonly string[] = [
  "Maya R.", "Theo K.", "Ines V.", "Jonah P.", "Priya C.", "Elliot M.", "Sofia L.", "Kwame A.",
  "Hana O.", "Rafael D.", "Greta S.", "Ade B.", "Lena W.", "Mateo F.", "Yuki T.", "Noor H.",
  "Oskar J.", "Clara N.", "Dev P.", "Freya G.", "Tomas I.", "Amara E.", "Luca Z.", "Rosa Q.",
];

const TITLES: Readonly<Record<StarRating, readonly string[]>> = {
  5: ["Exactly what I hoped for", "Worth every penny", "Beautifully made", "Use it every day", "Better than expected", "Lovely quality", "Would buy again"],
  4: ["Very good, one small quibble", "Solid choice", "Really nice overall", "Happy with it", "Good value"],
  3: ["Fine, not amazing", "Does the job", "Mixed feelings", "Okay for the price"],
  2: ["Expected more", "A bit disappointing", "Not quite right for me"],
  1: ["Did not work out", "Would not recommend", "Arrived damaged"],
};

const BODIES: Readonly<Record<StarRating, readonly string[]>> = {
  5: [
    "I've had the {name} for a few weeks now and it still feels brand new. Well made, nicely packaged and it arrived quickly.",
    "Bought the {name} as a gift and ended up ordering a second one for myself. The quality is obvious the moment you pick it up.",
    "Honestly one of the better purchases I've made this year. The {name} does exactly what it says and looks great doing it.",
    "Great attention to detail. Everything about the {name} feels considered, from the materials to the finish.",
    "I read a lot of reviews before choosing the {name} and I'm glad I did. No regrets at all.",
  ],
  4: [
    "Really happy with the {name}. Knocked off one star because it took a little longer to arrive than estimated.",
    "The {name} is well made and works well. I wish it came in more colours, but that's a minor point.",
    "Good quality for the price. The {name} is slightly smaller than I pictured, so check the dimensions.",
    "Does everything I need. The {name} needed a short break-in period but it's been great since.",
  ],
  3: [
    "The {name} is fine. Nothing wrong with it, but nothing that made me love it either.",
    "Decent, but I expected a bit more for the money. The {name} works as described.",
    "It's okay. The {name} looks nicer in the photos than in person, though it does its job.",
  ],
  2: [
    "The {name} felt less sturdy than I expected. It works, but I'm not sure how long it will last.",
    "Not what I was hoping for. The finish on my {name} was uneven and the instructions were vague.",
  ],
  1: [
    "My {name} stopped working properly after a week. Customer support was helpful, but I returned it.",
    "Arrived with a crack in it. The replacement was fine but this was a frustrating start.",
  ],
};

/** Rating distribution skewed positive: 5★ 46%, 4★ 27%, 3★ 12%, 2★ 8%, 1★ 7%. */
function drawRating(rng: () => number): StarRating {
  const r = rng();
  if (r < 0.46) return 5;
  if (r < 0.73) return 4;
  if (r < 0.85) return 3;
  if (r < 0.93) return 2;
  return 1;
}

export interface SeedReviewProduct {
  readonly id: string;
  readonly name: string;
  readonly department: string;
  readonly publishedAt: Date;
  /** Whole days since publication (seed input), so counts never depend on the clock. Negative = not yet published. */
  readonly ageDays: number;
  readonly featured: boolean;
}

export interface SeedReview {
  readonly id: string;
  readonly productId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly rating: StarRating;
  readonly title: string;
  readonly body: string;
  readonly verifiedPurchase: boolean;
  readonly status: ContentStatus;
  readonly createdAt: string;
  /** Synthetic voter session ids that marked this review helpful. */
  readonly voterSessionIds: readonly string[];
}

function between(rng: () => number, from: Date, to: Date): string {
  const start = from.getTime();
  const end = Math.max(start, to.getTime());
  return new Date(start + Math.floor(rng() * (end - start))).toISOString();
}

function voters(rng: () => number, max: number): string[] {
  const n = Math.floor(rng() * (max + 1));
  return Array.from({ length: n }, (_, i) => `seed_voter_${pad(i + 1)}`);
}

/** Ids of seed reviews deliberately hidden (moderation demo; excluded from ratings). */
export const HIDDEN_REVIEW_IDS: readonly string[] = ["rev_seed_001_01", "rev_seed_017_02"];

export function buildSeedReviews(products: readonly SeedReviewProduct[], now: Date): SeedReview[] {
  const rng = createRng(20261107);
  const reviews: SeedReview[] = [];
  products.forEach((product, productIndex) => {
    const { ageDays } = product;
    // Future-dated (unpublished) products get no reviews. Returning before
    // any rng() call keeps every other product's reviews unchanged.
    if (ageDays < 0) return;
    // Newer products have fewer reviews; featured ones a few more.
    const base = ageDays < 7 ? 1 : ageDays < 30 ? 3 : 4;
    const count = Math.floor(rng() * (base + 2)) + (product.featured ? 2 : 0);
    for (let n = 0; n < count; n++) {
      const id = `rev_seed_${String(productIndex + 1).padStart(3, "0")}_${pad(n + 1)}`;
      const rating = drawRating(rng);
      reviews.push({
        id,
        productId: product.id,
        sessionId: `seed_session_${pad(n + 1)}`,
        displayName: pick(rng, SEED_DISPLAY_NAMES),
        rating,
        title: pick(rng, TITLES[rating]),
        body: pick(rng, BODIES[rating]).replaceAll("{name}", product.name),
        verifiedPurchase: rng() < 0.4,
        status: HIDDEN_REVIEW_IDS.includes(id) ? "hidden" : "published",
        createdAt: between(rng, product.publishedAt, now),
        voterSessionIds: voters(rng, rating >= 4 ? 9 : 4),
      });
    }
  });
  return reviews;
}

interface QaTemplate {
  readonly question: string;
  readonly answers: readonly { readonly body: string; readonly isStore?: boolean }[];
}

const STORE_NAME = "Storefront Support";

const QA_BY_DEPARTMENT: Readonly<Record<string, readonly QaTemplate[]>> = {
  "home-kitchen": [
    { question: "Is this dishwasher safe?", answers: [{ body: "Please check the care line in the specifications; where it says hand wash, we recommend sticking to that.", isStore: true }, { body: "I hand wash mine to be safe and it still looks new." }] },
    { question: "How heavy is it in practice?", answers: [{ body: "Solid but manageable. I can lift it with one hand." }] },
    { question: "Does the colour match the photos?", answers: [{ body: "Pretty close. Slightly warmer in daylight." }, { body: "Yes, very accurate on my screen." }] },
    { question: "Would this make a good wedding gift?", answers: [{ body: "I gave one as a gift and it went down really well." }, { body: "Yes, and we can add a gift note at checkout.", isStore: true }] },
    { question: "Does it come with any warranty?", answers: [] },
  ],
  electronics: [
    { question: "Does it work with both iPhone and Android?", answers: [{ body: "Yes, it uses standard Bluetooth and USB-C, so it works with both.", isStore: true }, { body: "Using it with an Android phone daily, no issues." }] },
    { question: "How long does a full charge take?", answers: [{ body: "About two hours from empty with a 20 W charger." }] },
    { question: "Is there a charger in the box?", answers: [{ body: "A USB-C cable is included but no wall plug.", isStore: true }] },
    { question: "Can I update the firmware?", answers: [{ body: "Yes, through the companion app. Mine updated on first setup." }, { body: "Updates are free and optional." }] },
    { question: "Does it get warm during use?", answers: [] },
  ],
  books: [
    { question: "Is this suitable for a teenage reader?", answers: [{ body: "My 15-year-old loved it. Nothing graphic." }] },
    { question: "Is the hardback signed?", answers: [{ body: "Not by default, but signed copies appear occasionally as a separate listing.", isStore: true }] },
    { question: "Is there an e-book version?", answers: [] },
    { question: "How big is the print?", answers: [{ body: "Comfortable to read, standard size." }, { body: "Slightly small for me but fine with reading glasses." }] },
  ],
  clothing: [
    { question: "Does it run true to size?", answers: [{ body: "I'm usually a medium and the medium fits well." }, { body: "Slightly roomy; size down if you like a closer fit." }, { body: "See the size guide in the specifications; it lists measurements for each size.", isStore: true }] },
    { question: "Does it shrink in the wash?", answers: [{ body: "Not noticeably after a dozen washes at 30°C." }] },
    { question: "Is the stitching durable?", answers: [{ body: "Mine has held up perfectly for months of daily use." }] },
    { question: "Can I return it if it doesn't fit?", answers: [{ body: "Yes, unworn items can be returned within 30 days.", isStore: true }] },
  ],
  "sports-outdoors": [
    { question: "Is it suitable for beginners?", answers: [{ body: "Yes, I'm a beginner and found it easy to use." }] },
    { question: "How well does it handle rain?", answers: [{ body: "Used it in a downpour with no issues." }, { body: "See the water resistance rating in the specifications.", isStore: true }] },
    { question: "Is it easy to pack for travel?", answers: [{ body: "Fits in my carry-on without trouble." }] },
    { question: "What is the warranty?", answers: [] },
  ],
  "beauty-personal-care": [
    { question: "Is it suitable for sensitive skin?", answers: [{ body: "I have sensitive skin and had no reaction." }, { body: "Formulas are dermatologist tested, but we always suggest a patch test first.", isStore: true }] },
    { question: "Is it tested on animals?", answers: [{ body: "No. All of our products are cruelty free.", isStore: true }] },
    { question: "How long does one bottle last?", answers: [{ body: "About two months with daily use." }] },
    { question: "Is the scent strong?", answers: [{ body: "Light. It fades within a few minutes." }, { body: "Subtle, which I prefer." }] },
  ],
  "toys-games": [
    { question: "What age is this best for?", answers: [{ body: "The recommended age is on the box and in the specifications.", isStore: true }, { body: "My 7-year-old enjoys it with a bit of help." }] },
    { question: "Are there small parts?", answers: [{ body: "Yes, some, so keep them away from toddlers." }] },
    { question: "How long does a game take?", answers: [{ body: "About an hour with four players." }] },
    { question: "Is it fun with two players?", answers: [] },
  ],
  office: [
    { question: "Is assembly required?", answers: [{ body: "Took me about 30 minutes with the included tools." }, { body: "Some assembly is required; instructions are in the box.", isStore: true }] },
    { question: "Will it fit a small desk?", answers: [{ body: "Check the dimensions in the specifications. It fits my 120 cm desk." }] },
    { question: "Is the paper good with fountain pens?", answers: [{ body: "No bleed with my fine nib." }] },
    { question: "Does it come in other colours?", answers: [] },
  ],
};

export interface SeedAnswer {
  readonly id: string;
  readonly questionId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly body: string;
  readonly isStore: boolean;
  readonly createdAt: string;
  readonly voterSessionIds: readonly string[];
}

export interface SeedQuestion {
  readonly id: string;
  readonly productId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly body: string;
  readonly createdAt: string;
  readonly voterSessionIds: readonly string[];
  readonly answers: readonly SeedAnswer[];
}

export function buildSeedQuestions(products: readonly SeedReviewProduct[], now: Date): SeedQuestion[] {
  const rng = createRng(4207);
  const questions: SeedQuestion[] = [];
  products.forEach((product, productIndex) => {
    const pool = QA_BY_DEPARTMENT[product.department] ?? [];
    // Future-dated (unpublished) products get no questions (no rng() consumed).
    if (pool.length === 0 || product.ageDays < 0) return;
    const r = rng();
    const count = r < 0.4 ? 0 : r < 0.85 ? 1 : 2;
    const offset = Math.floor(rng() * pool.length);
    for (let n = 0; n < count; n++) {
      const template = pool[(offset + n) % pool.length];
      if (template === undefined) continue;
      const id = `q_seed_${String(productIndex + 1).padStart(3, "0")}_${pad(n + 1)}`;
      const askedAt = between(rng, product.publishedAt, now);
      const answers = template.answers.slice(0, 3).map((answer, a): SeedAnswer => ({
        id: `${id.replace("q_", "a_")}_${pad(a + 1)}`,
        questionId: id,
        sessionId: answer.isStore === true ? "seed_store" : `seed_session_${pad(20 + a)}`,
        displayName: answer.isStore === true ? STORE_NAME : pick(rng, SEED_DISPLAY_NAMES),
        body: answer.body,
        isStore: answer.isStore === true,
        createdAt: between(rng, new Date(askedAt), now),
        voterSessionIds: voters(rng, 5),
      }));
      questions.push({
        id,
        productId: product.id,
        sessionId: `seed_session_${pad(10 + n)}`,
        displayName: pick(rng, SEED_DISPLAY_NAMES),
        body: template.question,
        createdAt: askedAt,
        voterSessionIds: voters(rng, 4),
        answers,
      });
    }
  });
  return questions;
}
