/**
 * Seed taxonomy: 8 departments with 3 categories each, and 12 fictional
 * brands (invented names; any resemblance to a real mark is unintended).
 * Ids are stable: `cat_<slug>` and `brand_<slug>`.
 */

export interface SeedDepartment {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly categories: readonly { readonly slug: string; readonly name: string; readonly description: string }[];
}

export const SEED_DEPARTMENTS: readonly SeedDepartment[] = [
  {
    slug: "home-kitchen",
    name: "Home & Kitchen",
    description: "Cookware, coffee gear, textiles and small things that make a home.",
    categories: [
      { slug: "cookware-dining", name: "Cookware & Dining", description: "Pans, boards and table linen built to last." },
      { slug: "coffee-tea", name: "Coffee & Tea", description: "Brewers, kettles and accessories for a better cup." },
      { slug: "decor-textiles", name: "Decor & Textiles", description: "Throws, candles, prints and soft furnishings." },
    ],
  },
  {
    slug: "electronics",
    name: "Electronics",
    description: "Audio, computer accessories and smart home devices.",
    categories: [
      { slug: "audio", name: "Headphones & Audio", description: "Headphones, earbuds and speakers." },
      { slug: "computer-accessories", name: "Computer Accessories", description: "Keyboards, hubs, chargers and stands." },
      { slug: "smart-home", name: "Smart Home & Lighting", description: "Connected plugs, bulbs and sensors." },
    ],
  },
  {
    slug: "books",
    name: "Books",
    description: "Fiction, cookbooks and curious nonfiction.",
    categories: [
      { slug: "fiction", name: "Fiction", description: "Novels and short stories." },
      { slug: "cookbooks", name: "Cookbooks & Food", description: "Recipes and writing about food." },
      { slug: "nonfiction", name: "Science & Nonfiction", description: "Ideas, history and the natural world." },
    ],
  },
  {
    slug: "clothing",
    name: "Clothing",
    description: "Everyday clothing, knitwear, bags and small accessories.",
    categories: [
      { slug: "tops", name: "Tops & Tees", description: "T-shirts, shirts and layers." },
      { slug: "outerwear", name: "Outerwear & Knitwear", description: "Jackets, jumpers and warm hats." },
      { slug: "bags-accessories", name: "Bags & Accessories", description: "Totes, wallets, pins and more." },
    ],
  },
  {
    slug: "sports-outdoors",
    name: "Sports & Outdoors",
    description: "Gear for training, camping and riding.",
    categories: [
      { slug: "fitness", name: "Fitness & Yoga", description: "Mats, weights and recovery tools." },
      { slug: "camping-hydration", name: "Camping & Hydration", description: "Bottles, lights and camp kit." },
      { slug: "cycling", name: "Cycling", description: "Lights, locks and riding accessories." },
    ],
  },
  {
    slug: "beauty-personal-care",
    name: "Beauty & Personal Care",
    description: "Skincare, hair and body care and fragrance.",
    categories: [
      { slug: "skincare", name: "Skincare", description: "Cleansers, serums and moisturisers." },
      { slug: "hair-body", name: "Hair & Body", description: "Shampoo bars, soaps and body care." },
      { slug: "fragrance", name: "Fragrance", description: "Eau de parfum, solid scents and diffusers." },
    ],
  },
  {
    slug: "toys-games",
    name: "Toys & Games",
    description: "Board games, building sets and soft toys.",
    categories: [
      { slug: "board-games", name: "Board Games & Puzzles", description: "Games and puzzles for the table." },
      { slug: "building-stem", name: "Building & STEM", description: "Construction sets and science kits." },
      { slug: "plush-kids", name: "Plush & Kids", description: "Soft toys and gifts for little ones." },
    ],
  },
  {
    slug: "office",
    name: "Office",
    description: "Desks, lighting and stationery for focused work.",
    categories: [
      { slug: "office-furniture", name: "Office Furniture", description: "Desks, chairs and storage." },
      { slug: "desk-accessories", name: "Desk Accessories & Lighting", description: "Lamps, organisers and desk mats." },
      { slug: "stationery", name: "Notebooks & Stationery", description: "Notebooks, pens and paper goods." },
    ],
  },
];

export interface SeedBrand {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** Upper-case SKU prefix. */
  readonly skuPrefix: string;
}

export const SEED_BRANDS: readonly SeedBrand[] = [
  { slug: "hearthwell", name: "Hearthwell", skuPrefix: "HW", description: "Kitchen tools and cookware made to be used every day." },
  { slug: "northloom", name: "Northloom", skuPrefix: "NL", description: "Natural-fibre textiles and knitwear from small mills." },
  { slug: "kestrel-audio", name: "Kestrel Audio", skuPrefix: "KA", description: "Headphones and speakers tuned for long listening." },
  { slug: "voltline", name: "Voltline", skuPrefix: "VL", description: "Chargers, hubs and smart home basics that just work." },
  { slug: "oakhaven-press", name: "Oakhaven Press", skuPrefix: "OP", description: "An independent publisher of fiction, food and ideas." },
  { slug: "driftwood-pine", name: "Driftwood & Pine", skuPrefix: "DP", description: "Durable gear for trails, campsites and commutes." },
  { slug: "lumen-co", name: "Lumen & Co.", skuPrefix: "LC", description: "Lamps, candles and objects for warm interiors." },
  { slug: "saltmarsh-botanics", name: "Saltmarsh Botanics", skuPrefix: "SB", description: "Small-batch skincare and body care with plant oils." },
  { slug: "tinker-grove", name: "Tinker Grove", skuPrefix: "TG", description: "Games and building toys for curious minds." },
  { slug: "inkwell-studio", name: "Inkwell Studio", skuPrefix: "IS", description: "Paper goods, prints and pins designed in-house." },
  { slug: "ridgeback-athletic", name: "Ridgeback Athletic", skuPrefix: "RA", description: "Training gear and performance apparel." },
  { slug: "morrow-coffee-works", name: "Morrow Coffee Works", skuPrefix: "MC", description: "Brewing equipment for slow mornings." },
];

export function categoryId(slug: string): string {
  return `cat_${slug}`;
}

export function brandId(slug: string): string {
  return `brand_${slug}`;
}
