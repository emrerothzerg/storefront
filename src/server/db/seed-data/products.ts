/**
 * Seed product content. The first 15 entries (`legacy: true`) are the MVP
 * catalogue: their slugs, names, descriptions, prices, stock and colours
 * must never change (tests and the HTTP smoke depend on them). The next 45
 * extend the catalogue for phase 2; the 65 after them are the phase 3 sample
 * expansion (SEED-EXPAND). Append only: array position drives SKUs,
 * gallery view counts and the deterministic review / Q&A generator.
 *
 * `daysAgo` staggers `published_at` over the last 90 days relative to the
 * seed run (published products use 3..90: `publishedAtFor` stamps 09:00 UTC,
 * so 0-2 would flip with the time of day / fixed test clocks); a NEGATIVE
 * `daysAgo` is a future date, i.e. the product is
 * unpublished until then (published = published_at <= now), and gets no
 * seed reviews or questions. `listPriceCents` (when set) is the "was"
 * price, 10-40% above.
 * Legacy products deliberately have no list price: the CHECK
 * list_price_cents >= price_cents would otherwise reject the MVP tests that
 * raise their prices.
 */

export interface SeedProductInput {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly stock: number;
  /** Placeholder image background colour (hex), unique per product. */
  readonly color: string;
  readonly brand: string;
  readonly category: string;
  readonly listPriceCents?: number;
  readonly featured?: boolean;
  /** Days before the seed run; negative = future-dated (unpublished). */
  readonly daysAgo: number;
  readonly legacy?: boolean;
  readonly bullets: readonly string[];
  readonly specs: readonly (readonly [label: string, value: string])[];
}

export const SEED_PRODUCT_INPUT: readonly SeedProductInput[] = [
  // ---- Legacy MVP catalogue (do not change slug/name/description/price/stock/color) ----
  {
    legacy: true, slug: "canvas-tote-bag", name: "Canvas Tote Bag", description: "Heavyweight natural cotton tote with an inside pocket. Carries a week of groceries.",
    priceCents: 1999, stock: 42, color: "#1f4e79", brand: "northloom", category: "bags-accessories", daysAgo: 88,
    bullets: ["16 oz heavyweight cotton canvas that softens with use", "Inside zip pocket keeps keys and phone separate", "Reinforced box-stitched handles carry up to 15 kg", "Machine washable at 30°C"],
    specs: [["Material", "100% cotton canvas, 16 oz"], ["Dimensions", "40 x 38 x 12 cm"], ["Handle drop", "28 cm"], ["Weight", "380 g"], ["Care", "Machine wash cold, line dry"]],
  },
  {
    legacy: true, slug: "enamel-pin-set", name: "Enamel Pin Set", description: "Three hard-enamel pins with rubber clutches, packed on a recycled card.",
    priceCents: 50, stock: 100, color: "#7a1f3d", brand: "inkwell-studio", category: "bags-accessories", daysAgo: 85,
    bullets: ["Set of three hard-enamel pins with gold-tone plating", "Rubber clutches stay put on jackets and bags", "Packed on a 100% recycled backing card", "Designed in-house by our illustration team"],
    specs: [["Pieces", "3"], ["Pin size", "25 mm each"], ["Finish", "Hard enamel, gold-tone metal"], ["Backing", "Rubber clutch"], ["Packaging", "Recycled card"]],
  },
  {
    legacy: true, slug: "walnut-desk", name: "Walnut Standing Desk", description: "Solid walnut top on a dual-motor frame with four height presets.",
    priceCents: 125000, stock: 3, color: "#5b3a1e", brand: "lumen-co", category: "office-furniture", featured: true, daysAgo: 80,
    bullets: ["Solid American walnut top, oiled by hand", "Dual-motor lift moves from 65 to 130 cm in under 20 seconds", "Four programmable height presets with anti-collision", "Cable tray and grommet included", "10-year warranty on the frame"],
    specs: [["Top", "Solid walnut, 160 x 80 x 2.5 cm"], ["Height range", "65-130 cm"], ["Motors", "2"], ["Load capacity", "120 kg"], ["Presets", "4"], ["Noise", "< 48 dB"], ["Warranty", "10 years frame, 2 years electronics"]],
  },
  {
    legacy: true, slug: "ceramic-pour-over", name: "Ceramic Pour-Over", description: "Hand-glazed single-cup dripper. Fits standard #2 filters.",
    priceCents: 3400, stock: 0, color: "#2e5d4b", brand: "morrow-coffee-works", category: "coffee-tea", daysAgo: 76,
    bullets: ["Hand-glazed stoneware keeps brewing temperature steady", "Spiral ribs promote an even extraction", "Fits standard #2 cone filters", "Wide base sits on most mugs and carafes"],
    specs: [["Material", "Glazed stoneware"], ["Capacity", "1-2 cups"], ["Filter size", "#2 cone"], ["Height", "9.5 cm"], ["Dishwasher safe", "Yes"]],
  },
  {
    legacy: true, slug: "limited-print-no-1", name: "Limited Print No. 1", description: "Signed giclee print, A3, numbered edition. Only one left.",
    priceCents: 18000, stock: 1, color: "#4b2e83", brand: "inkwell-studio", category: "decor-textiles", daysAgo: 72,
    bullets: ["Archival giclee print on 310 gsm cotton rag paper", "Signed and numbered by the artist", "Edition of 50, ships with a certificate of authenticity", "Unframed; fits a standard A3 frame"],
    specs: [["Size", "A3 (297 x 420 mm)"], ["Paper", "310 gsm cotton rag"], ["Edition", "50"], ["Framed", "No"], ["Signed", "Yes"]],
  },
  {
    legacy: true, slug: "merino-beanie", name: "Merino Beanie", description: "Ribbed 100% merino wool beanie. Soft, warm and itch-free.",
    priceCents: 2800, stock: 64, color: "#8a3b12", brand: "northloom", category: "outerwear", daysAgo: 70,
    bullets: ["Extra-fine 18.5 micron merino is soft against skin", "Double-layer rib knit for warmth without bulk", "Naturally odour resistant and breathable", "One size fits most adults"],
    specs: [["Material", "100% merino wool"], ["Knit", "2x2 rib, double layer"], ["Size", "One size"], ["Care", "Hand wash cold, dry flat"]],
  },
  {
    legacy: true, slug: "linen-napkins", name: "Linen Napkins (Set of 4)", description: "Stonewashed European linen napkins that soften with every wash.",
    priceCents: 3200, stock: 25, color: "#3d5a80", brand: "northloom", category: "cookware-dining", daysAgo: 66,
    bullets: ["Set of four stonewashed napkins in European flax linen", "Pre-washed so they will not shrink further", "Mitred corners for a clean edge", "Gets softer with every wash"],
    specs: [["Pieces", "4"], ["Size", "45 x 45 cm"], ["Material", "100% European linen"], ["Care", "Machine wash 40°C"], ["Finish", "Stonewashed"]],
  },
  {
    legacy: true, slug: "brass-desk-lamp", name: "Brass Desk Lamp", description: "Articulated brass lamp with a warm 2700K LED and dimmer.",
    priceCents: 14900, stock: 12, color: "#6b4f0f", brand: "lumen-co", category: "desk-accessories", featured: true, daysAgo: 61,
    bullets: ["Solid brass arms that develop a patina over time", "Warm 2700K LED with a stepless dimmer", "Two-joint arm reaches 55 cm", "Weighted base keeps it steady"],
    specs: [["Material", "Solid brass, steel base"], ["Light", "8 W LED, 2700K, 600 lm"], ["Reach", "55 cm"], ["Cable", "1.8 m fabric cord"], ["Dimmable", "Yes"], ["CRI", "> 90"]],
  },
  {
    legacy: true, slug: "notebook-dot-grid", name: "Dot Grid Notebook", description: "A5 lay-flat notebook, 160 pages of 100gsm fountain-pen-friendly paper.",
    priceCents: 1450, stock: 88, color: "#264653", brand: "inkwell-studio", category: "stationery", daysAgo: 58,
    bullets: ["Lay-flat binding opens fully on the desk", "100 gsm paper handles fountain pens without bleed", "5 mm dot grid, numbered pages and index", "Two ribbon markers and a back pocket"],
    specs: [["Size", "A5 (148 x 210 mm)"], ["Pages", "160"], ["Paper", "100 gsm, ivory"], ["Ruling", "5 mm dot grid"], ["Binding", "Lay-flat, thread-sewn"]],
  },
  {
    legacy: true, slug: "wool-throw-blanket", name: "Wool Throw Blanket", description: "Herringbone lambswool throw, 130 x 180 cm, woven in Wales.",
    priceCents: 11900, stock: 15, color: "#5e3c58", brand: "northloom", category: "decor-textiles", featured: true, daysAgo: 55,
    bullets: ["Pure lambswool woven in a classic herringbone", "Generous 130 x 180 cm size for sofa or bed", "Fringed edges finished by hand", "Woven at a family mill in Wales"],
    specs: [["Material", "100% lambswool"], ["Size", "130 x 180 cm"], ["Weight", "1.1 kg"], ["Weave", "Herringbone"], ["Care", "Dry clean or hand wash cold"]],
  },
  {
    legacy: true, slug: "cast-iron-skillet", name: "Cast Iron Skillet", description: "Pre-seasoned 26 cm skillet that lasts for generations.",
    priceCents: 4999, stock: 30, color: "#333d29", brand: "hearthwell", category: "cookware-dining", daysAgo: 50,
    bullets: ["Pre-seasoned with vegetable oil, ready to cook", "Even heat retention for searing and baking", "Works on induction, gas, electric, oven and campfire", "Pour spouts on both sides"],
    specs: [["Diameter", "26 cm"], ["Material", "Cast iron"], ["Weight", "2.4 kg"], ["Hob compatibility", "All, including induction"], ["Oven safe", "Yes"], ["Dishwasher safe", "No"]],
  },
  {
    legacy: true, slug: "glass-water-bottle", name: "Glass Water Bottle", description: "Borosilicate bottle with a silicone sleeve and bamboo cap, 750 ml.",
    priceCents: 2299, stock: 50, color: "#005f73", brand: "driftwood-pine", category: "camping-hydration", daysAgo: 46,
    bullets: ["Borosilicate glass keeps drinks tasting clean", "Silicone sleeve adds grip and protection", "Leak-proof bamboo cap with stainless steel insert", "750 ml fits most cup holders"],
    specs: [["Capacity", "750 ml"], ["Material", "Borosilicate glass, silicone, bamboo"], ["Height", "26 cm"], ["Dishwasher safe", "Bottle only"]],
  },
  {
    legacy: true, slug: "leather-card-holder", name: "Leather Card Holder", description: "Vegetable-tanned leather card holder with space for six cards.",
    priceCents: 3900, stock: 20, color: "#7f2f1f", brand: "northloom", category: "bags-accessories", daysAgo: 41,
    bullets: ["Vegetable-tanned full-grain leather ages beautifully", "Holds up to six cards plus folded notes", "Slim enough for a front pocket", "Hand-stitched edges"],
    specs: [["Material", "Full-grain vegetable-tanned leather"], ["Capacity", "6 cards"], ["Size", "10.5 x 7.5 cm"], ["Stitching", "Hand-stitched waxed thread"]],
  },
  {
    legacy: true, slug: "soy-candle-cedar", name: "Cedar & Smoke Candle", description: "Hand-poured soy wax candle with a cotton wick. Around 45 hours of burn time.",
    priceCents: 2600, stock: 10, color: "#3a3a5c", brand: "lumen-co", category: "decor-textiles", daysAgo: 37,
    bullets: ["Notes of cedarwood, smoke and vetiver", "100% soy wax with a lead-free cotton wick", "About 45 hours of burn time", "Reusable amber glass jar"],
    specs: [["Wax", "Soy"], ["Burn time", "About 45 hours"], ["Weight", "220 g"], ["Jar", "Amber glass with lid"]],
  },
  {
    legacy: true, slug: "bamboo-cutting-board", name: "Bamboo Cutting Board", description: "Large end-grain bamboo board with a juice groove.",
    priceCents: 3599, stock: 35, color: "#55601c", brand: "hearthwell", category: "cookware-dining", daysAgo: 33,
    bullets: ["End-grain construction is gentle on knife edges", "Deep juice groove catches liquids", "Non-slip feet keep it steady", "Finished with food-safe mineral oil"],
    specs: [["Size", "45 x 30 x 3 cm"], ["Material", "End-grain bamboo"], ["Weight", "2.1 kg"], ["Care", "Hand wash, oil monthly"]],
  },

  // ---- Home & Kitchen ----
  {
    slug: "gooseneck-kettle", name: "Gooseneck Pour-Over Kettle", description: "Electric gooseneck kettle with temperature hold for precise pour-over brewing.",
    priceCents: 7900, stock: 22, color: "#2b2d42", brand: "morrow-coffee-works", category: "coffee-tea", listPriceCents: 9900, featured: true, daysAgo: 12,
    bullets: ["Set any temperature from 40 to 100°C in 1° steps", "Holds temperature for up to 60 minutes", "Counterweighted handle and fine spout for a steady pour", "Brushed stainless steel body, 0.9 litre"],
    specs: [["Capacity", "0.9 l"], ["Power", "1200 W"], ["Temperature range", "40-100°C"], ["Hold", "60 minutes"], ["Material", "Stainless steel"], ["Cord", "75 cm"]],
  },
  {
    slug: "stoneware-dinner-set", name: "Stoneware Dinner Set (12 Piece)", description: "Reactive-glaze stoneware for four: dinner plates, side plates and bowls.",
    priceCents: 8900, stock: 9, color: "#6d597a", brand: "hearthwell", category: "cookware-dining", daysAgo: 27,
    bullets: ["Service for four: 4 dinner plates, 4 side plates, 4 bowls", "Reactive glaze makes every piece slightly different", "Chip-resistant high-fired stoneware", "Microwave and dishwasher safe"],
    specs: [["Pieces", "12"], ["Material", "Stoneware"], ["Dinner plate", "27 cm"], ["Side plate", "21 cm"], ["Bowl", "16 cm, 650 ml"], ["Dishwasher safe", "Yes"], ["Microwave safe", "Yes"]],
  },

  // ---- Electronics ----
  {
    slug: "wireless-over-ear-headphones", name: "Wireless Over-Ear Headphones", description: "Active noise cancelling headphones with 40 hours of battery and plush memory-foam cushions.",
    priceCents: 17900, stock: 18, color: "#14213d", brand: "kestrel-audio", category: "audio", listPriceCents: 24900, featured: true, daysAgo: 9,
    bullets: ["Hybrid active noise cancellation with transparency mode", "Up to 40 hours of playback; 10 minutes charging gives 5 hours", "40 mm drivers tuned for a warm, detailed sound", "Multipoint Bluetooth connects two devices at once", "Folds flat into the included hard case"],
    specs: [["Driver", "40 mm dynamic"], ["Battery", "40 h (ANC off), 30 h (ANC on)"], ["Charging", "USB-C, fast charge"], ["Bluetooth", "5.3, multipoint"], ["Codecs", "SBC, AAC"], ["Weight", "254 g"], ["In the box", "Hard case, USB-C cable, 3.5 mm cable"]],
  },
  {
    slug: "true-wireless-earbuds", name: "True Wireless Earbuds", description: "Compact earbuds with a pocketable charging case and IPX4 sweat resistance.",
    priceCents: 7900, stock: 2, color: "#3c096c", brand: "kestrel-audio", category: "audio", listPriceCents: 9900, daysAgo: 31,
    bullets: ["8 hours per charge, 32 hours with the case", "IPX4 sweat and splash resistance", "Touch controls for music, calls and voice assistant", "Three sizes of silicone tips included"],
    specs: [["Battery", "8 h + 24 h case"], ["Water resistance", "IPX4"], ["Bluetooth", "5.3"], ["Charging", "USB-C and wireless"], ["Weight", "4.8 g per earbud"]],
  },
  {
    slug: "portable-bluetooth-speaker", name: "Portable Bluetooth Speaker", description: "Rugged waterproof speaker with 360° sound and a 20-hour battery.",
    priceCents: 5900, stock: 27, color: "#0b525b", brand: "kestrel-audio", category: "audio", listPriceCents: 7900, daysAgo: 44,
    bullets: ["360° sound with a passive bass radiator", "IP67 waterproof and dustproof; it floats", "20 hours of playback per charge", "Pair two speakers for stereo"],
    specs: [["Output", "20 W"], ["Battery", "20 h"], ["Water resistance", "IP67"], ["Bluetooth", "5.2"], ["Weight", "540 g"], ["Dimensions", "18 x 7 x 7 cm"]],
  },
  {
    slug: "mechanical-keyboard", name: "Low-Profile Mechanical Keyboard", description: "Wireless 75% keyboard with hot-swappable switches and an aluminium case.",
    priceCents: 11900, stock: 14, color: "#22223b", brand: "voltline", category: "computer-accessories", daysAgo: 6,
    bullets: ["Compact 75% layout keeps the arrow and function keys", "Hot-swappable low-profile tactile switches", "Connect by Bluetooth to three devices or by USB-C cable", "Anodised aluminium case with adjustable feet", "Mac and Windows keycaps included"],
    specs: [["Layout", "75%, 84 keys"], ["Switches", "Low-profile tactile, hot-swappable"], ["Connectivity", "Bluetooth 5.1 (3 devices), USB-C"], ["Battery", "4000 mAh"], ["Backlight", "White LED"], ["Case", "Aluminium"], ["Weight", "620 g"]],
  },
  {
    slug: "usb-c-hub", name: "7-in-1 USB-C Hub", description: "Aluminium hub with 4K HDMI, 100 W pass-through charging, SD and USB ports.",
    priceCents: 4500, stock: 60, color: "#4a4e69", brand: "voltline", category: "computer-accessories", listPriceCents: 5500, daysAgo: 52,
    bullets: ["4K at 60 Hz over HDMI", "100 W USB-C power delivery pass-through", "Two USB-A 3.2 ports and one USB-C data port", "SD and microSD card readers"],
    specs: [["Ports", "HDMI, 2x USB-A, USB-C data, USB-C PD, SD, microSD"], ["HDMI", "4K at 60 Hz"], ["Power delivery", "Up to 100 W"], ["Data", "5 Gbps"], ["Cable", "15 cm, braided"]],
  },
  {
    slug: "wireless-charging-pad", name: "Wireless Charging Pad", description: "15 W fast wireless charger with a non-slip fabric top.",
    priceCents: 2900, stock: 75, color: "#3d405b", brand: "voltline", category: "computer-accessories", listPriceCents: 3900, daysAgo: 63,
    bullets: ["Up to 15 W fast wireless charging", "Charges through most phone cases up to 5 mm", "Fabric top with a soft status light", "Foreign object detection and overheat protection"],
    specs: [["Output", "5/7.5/10/15 W"], ["Input", "USB-C"], ["Diameter", "10 cm"], ["Case compatibility", "Up to 5 mm"], ["In the box", "1 m USB-C cable"]],
  },
  {
    slug: "laptop-stand-aluminium", name: "Aluminium Laptop Stand", description: "Adjustable laptop riser that lifts your screen to eye level and folds flat.",
    priceCents: 3900, stock: 33, color: "#5c677d", brand: "voltline", category: "computer-accessories", daysAgo: 74,
    bullets: ["Six height positions from 5 to 19 cm", "Fits laptops from 10 to 16 inches", "Folds flat to slip into a laptop bag", "Silicone pads protect your laptop and desk"],
    specs: [["Material", "Anodised aluminium"], ["Height", "5-19 cm, 6 positions"], ["Compatibility", "10-16 inch laptops"], ["Load", "8 kg"], ["Weight", "260 g"]],
  },
  {
    slug: "smart-plug-2-pack", name: "Smart Plug (2 Pack)", description: "Wi-Fi smart plugs with energy monitoring, schedules and voice control.",
    priceCents: 2499, stock: 90, color: "#1b4332", brand: "voltline", category: "smart-home", daysAgo: 21,
    bullets: ["Control lamps and appliances from your phone", "Real-time energy monitoring", "Schedules, timers and away mode", "Works with common voice assistants; no hub required"],
    specs: [["Pieces", "2"], ["Max load", "13 A"], ["Connectivity", "2.4 GHz Wi-Fi"], ["Energy monitoring", "Yes"], ["Hub required", "No"]],
  },
  {
    slug: "smart-led-bulb-set", name: "Smart LED Bulb Set", description: "Four colour-changing E27 bulbs with tunable white and app control.",
    priceCents: 3999, stock: 0, color: "#7b2cbf", brand: "lumen-co", category: "smart-home", daysAgo: 39,
    bullets: ["16 million colours and tunable white from 2200 to 6500K", "Group bulbs into rooms and scenes", "Sunrise and sunset routines", "Replaces a 60 W incandescent bulb"],
    specs: [["Pieces", "4"], ["Fitting", "E27"], ["Brightness", "806 lm"], ["Power", "9 W"], ["Colour temperature", "2200-6500K"], ["Connectivity", "Wi-Fi + Bluetooth"]],
  },

  // ---- Books ----
  {
    slug: "the-lighthouse-keepers-daughter", name: "The Lighthouse Keeper's Daughter", description: "A sweeping novel of family secrets on a remote northern island.",
    priceCents: 1699, stock: 40, color: "#023e8a", brand: "oakhaven-press", category: "fiction", featured: true, daysAgo: 4,
    bullets: ["A debut novel set across three generations", "Book club guide with discussion questions included", "Hardback with a printed endpaper map", "Shortlisted for an independent booksellers' prize"],
    specs: [["Format", "Hardback"], ["Pages", "384"], ["Author", "Elin Marsh"], ["Publisher", "Oakhaven Press"], ["Language", "English"], ["Dimensions", "15.6 x 23.4 cm"]],
  },
  {
    slug: "salt-and-ember", name: "Salt & Ember", description: "A short-story collection about cooks, kitchens and the people they feed.",
    priceCents: 1399, stock: 26, color: "#9d0208", brand: "oakhaven-press", category: "fiction", daysAgo: 48,
    bullets: ["Twelve linked stories set in one city over a single winter", "Paperback with French flaps", "Includes an afterword by the author"],
    specs: [["Format", "Paperback"], ["Pages", "256"], ["Author", "Tomas Ilves"], ["Publisher", "Oakhaven Press"], ["Language", "English"]],
  },
  {
    slug: "orbit-of-small-things", name: "The Orbit of Small Things", description: "A quiet science-fiction novel about a repair technician on a generation ship.",
    priceCents: 1599, stock: 1, color: "#3a0ca3", brand: "oakhaven-press", category: "fiction", listPriceCents: 1999, daysAgo: 67,
    bullets: ["Character-driven science fiction with a hopeful ending", "Paperback, first edition", "Includes a short bonus story"],
    specs: [["Format", "Paperback"], ["Pages", "320"], ["Author", "Priya Castell"], ["Publisher", "Oakhaven Press"], ["Language", "English"]],
  },
  {
    slug: "weeknight-vegetables", name: "Weeknight Vegetables", description: "One hundred fast vegetable-first recipes for busy evenings.",
    priceCents: 2499, stock: 31, color: "#2d6a4f", brand: "oakhaven-press", category: "cookbooks", daysAgo: 18,
    bullets: ["100 recipes, most ready in 30 minutes or less", "Photographed step by step", "Seasonal index so you cook what is fresh", "Lay-flat binding stays open on the counter"],
    specs: [["Format", "Hardback, lay-flat"], ["Pages", "272"], ["Recipes", "100"], ["Author", "Rosa Delmont"], ["Publisher", "Oakhaven Press"]],
  },
  {
    slug: "the-sourdough-year", name: "The Sourdough Year", description: "A month-by-month guide to baking naturally leavened bread at home.",
    priceCents: 2799, stock: 12, color: "#bc6c25", brand: "oakhaven-press", category: "cookbooks", listPriceCents: 3499, daysAgo: 57,
    bullets: ["Start a starter from scratch in seven days", "Twelve chapters, one for each month and its flours", "Troubleshooting pages for flat or dense loaves", "Baker's percentages for every recipe"],
    specs: [["Format", "Hardback"], ["Pages", "240"], ["Recipes", "60"], ["Author", "Jonah Pell"], ["Publisher", "Oakhaven Press"]],
  },
  {
    slug: "a-brief-history-of-maps", name: "A Brief History of Maps", description: "How people have drawn the world, from clay tablets to satellites.",
    priceCents: 2199, stock: 19, color: "#6a4c93", brand: "oakhaven-press", category: "nonfiction", daysAgo: 35,
    bullets: ["Over 120 full-colour maps and illustrations", "Written for curious readers, no background needed", "Notes and a bibliography for further reading"],
    specs: [["Format", "Hardback"], ["Pages", "336"], ["Illustrations", "120+"], ["Author", "Dr. Hana Okafor"], ["Publisher", "Oakhaven Press"]],
  },
  {
    slug: "the-hidden-life-of-soil", name: "The Hidden Life of Soil", description: "An accessible tour of the ecosystem under our feet.",
    priceCents: 1899, stock: 23, color: "#5f0f40", brand: "oakhaven-press", category: "nonfiction", daysAgo: 83,
    bullets: ["Explains fungi, microbes and worms in plain language", "Practical chapter on building healthy garden soil", "Paperback printed on recycled paper"],
    specs: [["Format", "Paperback"], ["Pages", "288"], ["Author", "Malcolm Reyes"], ["Publisher", "Oakhaven Press"], ["Paper", "Recycled"]],
  },
  {
    slug: "thinking-in-systems-field-guide", name: "Systems Thinking: A Field Guide", description: "Practical tools for understanding feedback loops in work and life.",
    priceCents: 2299, stock: 0, color: "#0077b6", brand: "oakhaven-press", category: "nonfiction", daysAgo: 89,
    bullets: ["Thirty worked examples from business, ecology and cities", "Diagrams you can redraw on a whiteboard", "Exercises at the end of every chapter", "Companion worksheets available to download"],
    specs: [["Format", "Paperback"], ["Pages", "224"], ["Author", "Ines Varga"], ["Publisher", "Oakhaven Press"], ["Language", "English"]],
  },

  // ---- Clothing ----
  {
    slug: "organic-cotton-tee", name: "Organic Cotton T-Shirt", description: "Midweight organic cotton tee with a relaxed fit and a ribbed crew neck.",
    priceCents: 2400, stock: 120, color: "#457b9d", brand: "ridgeback-athletic", category: "tops", daysAgo: 15,
    bullets: ["180 gsm certified organic cotton jersey", "Relaxed fit with dropped shoulders", "Pre-shrunk and garment dyed", "Ribbed crew neck holds its shape"],
    specs: [["Material", "100% organic cotton, 180 gsm"], ["Fit", "Relaxed"], ["Sizes", "XS-XXL"], ["Care", "Machine wash 30°C"], ["Origin", "Made in Portugal"]],
  },
  {
    slug: "oxford-button-down-shirt", name: "Oxford Button-Down Shirt", description: "Classic oxford cloth shirt with a soft roll collar.",
    priceCents: 5900, stock: 37, color: "#1d3557", brand: "northloom", category: "tops", listPriceCents: 7900, daysAgo: 42,
    bullets: ["Two-ply oxford cotton that softens with wear", "Button-down collar with a natural roll", "Back box pleat and locker loop", "Mother-of-pearl buttons"],
    specs: [["Material", "100% cotton oxford"], ["Fit", "Regular"], ["Sizes", "S-XXL"], ["Collar", "Button-down"], ["Care", "Machine wash 40°C"]],
  },
  {
    slug: "packable-rain-jacket", name: "Packable Rain Jacket", description: "Lightweight waterproof shell that packs into its own pocket.",
    priceCents: 8900, stock: 21, color: "#e76f51", brand: "driftwood-pine", category: "outerwear", daysAgo: 7,
    bullets: ["2.5-layer waterproof breathable fabric, fully taped seams", "Packs into its chest pocket for travel", "Adjustable hood with a stiffened peak", "Underarm vents for airflow"],
    specs: [["Waterproof rating", "20,000 mm"], ["Breathability", "15,000 g/m²/24h"], ["Weight", "290 g"], ["Sizes", "XS-XXL"], ["Material", "Recycled nylon"]],
  },
  {
    slug: "lambswool-crew-jumper", name: "Lambswool Crew Jumper", description: "Classic crew-neck jumper knitted from soft Scottish lambswool.",
    priceCents: 9500, stock: 2, color: "#9c6644", brand: "northloom", category: "outerwear", daysAgo: 79,
    bullets: ["Soft lambswool spun and knitted in Scotland", "Fully fashioned seams for a neat fit", "Ribbed cuffs, hem and neck", "Warm without bulk"],
    specs: [["Material", "100% lambswool"], ["Gauge", "12 gauge"], ["Sizes", "S-XL"], ["Care", "Hand wash cold"]],
  },

  // ---- Sports & Outdoors ----
  {
    slug: "cork-yoga-mat", name: "Cork Yoga Mat", description: "Natural cork mat with a rubber base for grip that improves as you sweat.",
    priceCents: 6900, stock: 28, color: "#b08968", brand: "ridgeback-athletic", category: "fitness", listPriceCents: 8900, daysAgo: 24,
    bullets: ["Cork surface gets grippier with sweat", "Natural tree-rubber base stays put", "Naturally antimicrobial; wipes clean", "Laser-etched alignment lines"],
    specs: [["Dimensions", "183 x 61 cm"], ["Thickness", "5 mm"], ["Weight", "2.4 kg"], ["Materials", "Cork, natural rubber"], ["Strap included", "Yes"]],
  },
  {
    slug: "adjustable-dumbbell-pair", name: "Adjustable Dumbbells (Pair)", description: "Space-saving dumbbells that adjust from 2 to 24 kg with a dial.",
    priceCents: 29900, stock: 5, color: "#343a40", brand: "ridgeback-athletic", category: "fitness", daysAgo: 53,
    bullets: ["Turn the dial to change weight in seconds", "Replaces 15 pairs of dumbbells", "Moulded trays keep plates secure", "Comfort-grip steel handle"],
    specs: [["Weight range", "2-24 kg each"], ["Increments", "15 settings"], ["Length", "40 cm"], ["Material", "Steel, ABS"], ["Pieces", "2 dumbbells, 2 trays"]],
  },
  {
    slug: "foam-roller", name: "High-Density Foam Roller", description: "Firm textured roller for warm-ups and muscle recovery.",
    priceCents: 2499, stock: 44, color: "#ff006e", brand: "ridgeback-athletic", category: "fitness", daysAgo: 86,
    bullets: ["Multi-zone texture targets knots and tight spots", "Hollow core does not lose shape", "Supports up to 150 kg", "Exercise guide included"],
    specs: [["Length", "33 cm"], ["Diameter", "14 cm"], ["Density", "High"], ["Max load", "150 kg"]],
  },
  {
    slug: "rechargeable-headlamp", name: "Rechargeable Headlamp", description: "400-lumen headlamp with a red night mode and USB-C charging.",
    priceCents: 3499, stock: 52, color: "#ffb703", brand: "driftwood-pine", category: "camping-hydration", daysAgo: 29,
    bullets: ["400 lumens with spot and flood beams", "Red light preserves night vision", "USB-C rechargeable; up to 40 hours on low", "IPX4 weather resistant"],
    specs: [["Max output", "400 lm"], ["Beam distance", "90 m"], ["Battery", "1500 mAh Li-ion"], ["Runtime", "4 h high, 40 h low"], ["Water resistance", "IPX4"], ["Weight", "78 g"]],
  },
  {
    slug: "insulated-camp-mug", name: "Insulated Camp Mug", description: "Double-wall stainless steel mug with a sliding lid, 350 ml.",
    priceCents: 1999, stock: 66, color: "#219ebc", brand: "driftwood-pine", category: "camping-hydration", listPriceCents: 2499, daysAgo: 64,
    bullets: ["Keeps coffee hot for hours", "Splash-resistant sliding lid", "Powder-coated finish for grip", "Fits most car cup holders"],
    specs: [["Capacity", "350 ml"], ["Material", "18/8 stainless steel"], ["Insulation", "Double-wall vacuum"], ["Dishwasher safe", "Yes"]],
  },
  {
    slug: "bike-light-set", name: "USB Bike Light Set", description: "Front and rear rechargeable bike lights with daytime flash modes.",
    priceCents: 3299, stock: 0, color: "#d00000", brand: "driftwood-pine", category: "cycling", daysAgo: 47,
    bullets: ["Bright 800-lumen front and 80-lumen rear", "Tool-free silicone mounts fit most bars and posts", "Daytime flash mode visible from 2 km", "USB-C charging with battery indicator"],
    specs: [["Front output", "800 lm"], ["Rear output", "80 lm"], ["Runtime", "Up to 12 h"], ["Charging", "USB-C"], ["Water resistance", "IPX5"]],
  },

  // ---- Beauty & Personal Care ----
  {
    slug: "hydrating-face-serum", name: "Hydrating Face Serum", description: "Lightweight hyaluronic serum with niacinamide for plump, even skin.",
    priceCents: 2800, stock: 58, color: "#ffafcc", brand: "saltmarsh-botanics", category: "skincare", featured: true, daysAgo: 3,
    bullets: ["Multi-weight hyaluronic acid hydrates on several layers", "5% niacinamide helps even tone", "Fragrance free and suitable for sensitive skin", "Vegan and cruelty free"],
    specs: [["Volume", "30 ml"], ["Key ingredients", "Hyaluronic acid, niacinamide 5%"], ["Skin type", "All, including sensitive"], ["Fragrance", "None"], ["Vegan", "Yes"]],
  },
  {
    slug: "gentle-gel-cleanser", name: "Gentle Gel Cleanser", description: "Low-foam gel cleanser that removes sunscreen without stripping.",
    priceCents: 1800, stock: 72, color: "#a2d2ff", brand: "saltmarsh-botanics", category: "skincare", daysAgo: 59,
    bullets: ["pH-balanced, low-foam formula", "Removes sunscreen and light make-up", "With oat extract and glycerin", "Fragrance free"],
    specs: [["Volume", "150 ml"], ["Skin type", "Normal to oily"], ["Fragrance", "None"], ["pH", "5.5"]],
  },
  {
    slug: "shampoo-bar-rosemary", name: "Rosemary Shampoo Bar", description: "Plastic-free solid shampoo with rosemary and mint. Lasts about 60 washes.",
    priceCents: 1200, stock: 95, color: "#606c38", brand: "saltmarsh-botanics", category: "hair-body", listPriceCents: 1500, daysAgo: 26,
    bullets: ["Equivalent to about three bottles of liquid shampoo", "Rosemary and mint for a fresh scalp", "Sulphate-free cleansers", "Wrapped in compostable paper"],
    specs: [["Weight", "80 g"], ["Washes", "About 60"], ["Hair type", "Normal to oily"], ["Packaging", "Compostable paper"]],
  },
  {
    slug: "oat-milk-body-lotion", name: "Oat Milk Body Lotion", description: "Rich, fast-absorbing body lotion with colloidal oat and shea butter.",
    priceCents: 1600, stock: 40, color: "#dda15e", brand: "saltmarsh-botanics", category: "hair-body", daysAgo: 71,
    bullets: ["Colloidal oat soothes dry skin", "Shea butter and squalane for lasting moisture", "Absorbs quickly with no greasy feel", "Lightly scented with vanilla"],
    specs: [["Volume", "250 ml"], ["Key ingredients", "Colloidal oat, shea butter"], ["Scent", "Vanilla"], ["Vegan", "Yes"]],
  },
  {
    slug: "sea-fig-eau-de-parfum", name: "Sea Fig Eau de Parfum", description: "A fresh, green fragrance of fig leaf, sea salt and cedar.",
    priceCents: 6800, stock: 1, color: "#52796f", brand: "saltmarsh-botanics", category: "fragrance", daysAgo: 38,
    bullets: ["Top notes of fig leaf and bergamot", "Heart of sea salt and violet leaf", "Base of cedar and musk", "Refillable glass bottle"],
    specs: [["Volume", "50 ml"], ["Concentration", "Eau de parfum"], ["Family", "Green, aquatic"], ["Bottle", "Refillable glass"]],
  },
  {
    slug: "reed-diffuser-amber", name: "Amber & Oud Reed Diffuser", description: "Long-lasting reed diffuser with warm amber, oud and vanilla.",
    priceCents: 3200, stock: 17, color: "#7f4f24", brand: "lumen-co", category: "fragrance", listPriceCents: 3900, daysAgo: 81,
    bullets: ["Scents a room for about 12 weeks", "Eight natural rattan reeds", "Warm notes of amber, oud and vanilla", "Reusable smoked glass vessel"],
    specs: [["Volume", "200 ml"], ["Duration", "About 12 weeks"], ["Reeds", "8 rattan"], ["Vessel", "Smoked glass"]],
  },

  // ---- Toys & Games ----
  {
    slug: "island-traders-board-game", name: "Island Traders Board Game", description: "A strategic trading game for 2-5 players set on a chain of islands.",
    priceCents: 4499, stock: 24, color: "#f77f00", brand: "tinker-grove", category: "board-games", featured: true, daysAgo: 10,
    bullets: ["Trade, build and race to control the harbours", "Modular board means no two games are the same", "Teaches in 10 minutes, plays in 60", "Wooden components and linen-finish cards"],
    specs: [["Players", "2-5"], ["Age", "10+"], ["Play time", "45-75 minutes"], ["Components", "Modular board, 120 cards, 60 wooden pieces"], ["Language", "English"]],
  },
  {
    slug: "1000-piece-puzzle-coast", name: "1000-Piece Puzzle: Coastal Village", description: "An illustrated jigsaw of a harbour village at dusk.",
    priceCents: 2199, stock: 34, color: "#48cae4", brand: "tinker-grove", category: "board-games", listPriceCents: 2799, daysAgo: 32,
    bullets: ["1000 thick, precision-cut pieces with a linen finish", "Original illustration by an independent artist", "Poster of the image included", "Recycled board and soy inks"],
    specs: [["Pieces", "1000"], ["Finished size", "68 x 48 cm"], ["Age", "12+"], ["Materials", "Recycled board, soy inks"]],
  },
  {
    slug: "magnetic-building-tiles", name: "Magnetic Building Tiles (60 Pieces)", description: "Colourful magnetic tiles for building 2D and 3D shapes.",
    priceCents: 4999, stock: 2, color: "#ef476f", brand: "tinker-grove", category: "building-stem", listPriceCents: 6999, daysAgo: 22,
    bullets: ["60 tiles in squares, triangles and windows", "Strong magnets sealed in every edge", "Builds towers, houses and geometric shapes", "Idea booklet with 20 builds"],
    specs: [["Pieces", "60"], ["Age", "3+"], ["Material", "ABS plastic, sealed magnets"], ["Storage", "Box with lid"]],
  },
  {
    slug: "solar-robot-kit", name: "Solar Robot Kit (12-in-1)", description: "Build twelve different solar-powered robots from one kit.",
    priceCents: 2999, stock: 19, color: "#06d6a0", brand: "tinker-grove", category: "building-stem", daysAgo: 60,
    bullets: ["Twelve models from one set of parts", "Powered by sunlight; no batteries needed", "Step-by-step illustrated instructions", "Introduces gears, motors and solar energy"],
    specs: [["Models", "12"], ["Age", "8+"], ["Power", "Solar panel"], ["Pieces", "190"], ["Batteries", "Not required"]],
  },
  {
    slug: "plush-fox", name: "Plush Fox", description: "An extra-soft plush fox with embroidered eyes, 30 cm tall.",
    priceCents: 1899, stock: 48, color: "#e85d04", brand: "tinker-grove", category: "plush-kids", listPriceCents: 2299, daysAgo: 16,
    bullets: ["Super-soft recycled polyester fur", "Embroidered eyes and nose, safe from birth", "Surface washable", "30 cm tall, perfect for cuddling"],
    specs: [["Height", "30 cm"], ["Age", "0+"], ["Material", "Recycled polyester"], ["Care", "Surface wash"]],
  },
  {
    slug: "wooden-stacking-rainbow", name: "Wooden Stacking Rainbow", description: "Seven-piece wooden rainbow for open-ended play.",
    priceCents: 3499, stock: 13, color: "#ffbe0b", brand: "tinker-grove", category: "plush-kids", daysAgo: 77,
    bullets: ["Seven arches of sustainably sourced beech", "Water-based, non-toxic paints", "Stack, balance, build tunnels and bridges", "Ages 1 and up"],
    specs: [["Pieces", "7"], ["Size", "28 x 14 x 5 cm"], ["Material", "Beech wood"], ["Age", "1+"]],
  },

  // ---- Office ----
  {
    slug: "ergonomic-mesh-chair", name: "Ergonomic Mesh Office Chair", description: "Breathable mesh chair with adjustable lumbar support and 4D armrests.",
    priceCents: 34900, stock: 6, color: "#495057", brand: "lumen-co", category: "office-furniture", listPriceCents: 42900, daysAgo: 14,
    bullets: ["Adjustable lumbar support follows your spine", "4D armrests move up, down, in, out and rotate", "Breathable mesh back stays cool", "Synchro tilt with tension control and lock", "Supports up to 136 kg"],
    specs: [["Seat height", "44-54 cm"], ["Max load", "136 kg"], ["Back", "Mesh"], ["Armrests", "4D adjustable"], ["Tilt", "Synchro, 4 locking positions"], ["Warranty", "5 years"]],
  },
  {
    slug: "felt-desk-mat", name: "Merino Felt Desk Mat", description: "Large wool felt desk mat that softens typing and protects your desk.",
    priceCents: 4900, stock: 29, color: "#6c757d", brand: "northloom", category: "desk-accessories", daysAgo: 49,
    bullets: ["4 mm merino wool felt", "Natural cork underside does not slip", "Large enough for keyboard and mouse", "Naturally dirt resistant"],
    specs: [["Size", "90 x 40 cm"], ["Thickness", "4 mm"], ["Materials", "Merino felt, cork"], ["Care", "Spot clean"]],
  },
  {
    slug: "monitor-light-bar", name: "Monitor Light Bar", description: "Asymmetric LED bar that lights your desk without screen glare.",
    priceCents: 5900, stock: 0, color: "#212529", brand: "lumen-co", category: "desk-accessories", daysAgo: 20,
    bullets: ["Asymmetric optics light the desk, not the screen", "Adjustable colour temperature 2700-6500K", "Clips onto most monitors; USB-C powered", "Wireless dial for brightness and warmth"],
    specs: [["Length", "45 cm"], ["Power", "5 V USB-C"], ["Colour temperature", "2700-6500K"], ["CRI", "> 95"], ["Monitor thickness", "1-3 cm"]],
  },
  {
    slug: "fountain-pen-starter", name: "Fountain Pen Starter Set", description: "A smooth steel-nib fountain pen with a converter and six ink cartridges.",
    priceCents: 3200, stock: 41, color: "#003049", brand: "inkwell-studio", category: "stationery", listPriceCents: 3900, daysAgo: 45,
    bullets: ["Fine steel nib that writes smoothly from day one", "Includes a piston converter for bottled ink", "Six blue-black cartridges", "Lacquered aluminium body with a gift box"],
    specs: [["Nib", "Steel, fine"], ["Filling", "Cartridge or converter"], ["Body", "Lacquered aluminium"], ["Length", "13.8 cm"], ["In the box", "Pen, converter, 6 cartridges"]],
  },

  // =====================================================================
  // ---- Phase 3 sample expansion (SEED-EXPAND, 2026-11-08): 65 products ----
  // Append-only: never reorder or edit the entries above (ids, SKUs, gallery
  // views and the review/Q&A generator all depend on array position). The
  // last two entries are future-dated (negative `daysAgo` = unpublished).
  // =====================================================================

  // ---- Home & Kitchen (expansion) ----
  {
    slug: "hand-burr-coffee-grinder", name: "Hand Burr Coffee Grinder", description: "Stainless conical burr grinder with 40 click settings, from espresso to cold brew.",
    priceCents: 6900, stock: 22, color: "#4a3728", brand: "morrow-coffee-works", category: "coffee-tea", listPriceCents: 8900, daysAgo: 5,
    bullets: ["38 mm stainless conical burrs for a consistent grind", "40 external click settings, espresso to French press", "Holds 30 g of beans, enough for two cups", "Dual bearings keep the burr steady", "Disassembles without tools for cleaning"],
    specs: [["Burr", "38 mm stainless conical"], ["Settings", "40 clicks"], ["Capacity", "30 g"], ["Body", "Aluminium alloy"], ["Weight", "520 g"]],
  },
  {
    slug: "cold-brew-pitcher", name: "Cold Brew Pitcher (1.5 L)", description: "Borosilicate glass pitcher with a fine mesh filter for smooth overnight cold brew.",
    priceCents: 2499, stock: 40, color: "#2f4858", brand: "morrow-coffee-works", category: "coffee-tea", daysAgo: 33,
    bullets: ["Makes up to 1.5 L of cold brew concentrate", "Removable ultra-fine stainless mesh filter", "Airtight lid keeps brew fresh for two weeks", "Fits in most fridge doors"],
    specs: [["Capacity", "1.5 L"], ["Material", "Borosilicate glass, stainless steel"], ["Filter", "Fine stainless mesh"], ["Dishwasher safe", "Glass only"]],
  },
  {
    slug: "loose-leaf-tea-infuser-mug", name: "Loose Leaf Tea Infuser Mug", description: "Porcelain mug with a deep stainless infuser basket and a lid that doubles as a coaster.",
    priceCents: 1899, stock: 0, color: "#5c4d7d", brand: "morrow-coffee-works", category: "coffee-tea", daysAgo: 61,
    bullets: ["Deep infuser basket gives leaves room to unfurl", "Lid keeps tea hot and holds the basket after steeping", "Glazed porcelain does not hold flavours", "Microwave and dishwasher safe without the basket"],
    specs: [["Capacity", "400 ml"], ["Material", "Porcelain, stainless steel"], ["Dishwasher safe", "Yes"], ["Microwave safe", "Yes, without basket"]],
  },
  {
    slug: "stoneware-bud-vase-trio", name: "Stoneware Bud Vase Trio", description: "Three small speckled stoneware vases in graduated heights for single stems.",
    priceCents: 3299, stock: 18, color: "#8d6a5b", brand: "lumen-co", category: "decor-textiles", listPriceCents: 3999, daysAgo: 27,
    bullets: ["Set of three graduated heights", "Speckled reactive glaze, each one slightly different", "Watertight glazed interior", "Felt pads protect furniture"],
    specs: [["Pieces", "3"], ["Heights", "8, 11 and 14 cm"], ["Material", "Glazed stoneware"], ["Care", "Hand wash"]],
  },
  {
    slug: "chunky-knit-cushion-cover", name: "Chunky Knit Cushion Cover", description: "Cable-knit cotton cushion cover with a hidden zip. Insert not included.",
    priceCents: 2799, stock: 2, color: "#7d5a50", brand: "northloom", category: "decor-textiles", daysAgo: 9,
    bullets: ["Chunky cable knit in soft recycled cotton", "Concealed zip along the bottom edge", "Fits a standard 45 x 45 cm insert", "Machine washable on a wool cycle"],
    specs: [["Size", "45 x 45 cm"], ["Material", "Recycled cotton"], ["Closure", "Concealed zip"], ["Insert", "Not included"], ["Care", "Wool cycle, dry flat"]],
  },
  {
    slug: "carbon-steel-wok", name: "Carbon Steel Wok (32 cm)", description: "Pre-seasoned carbon steel wok with a flat base for gas, electric and induction hobs.",
    priceCents: 5499, stock: 14, color: "#3b3b3b", brand: "hearthwell", category: "cookware-dining", listPriceCents: 6999, daysAgo: 52,
    bullets: ["1.8 mm carbon steel heats fast and evenly", "Pre-seasoned and ready to cook", "Flat base works on every hob, including induction", "Riveted wooden handle plus helper handle"],
    specs: [["Diameter", "32 cm"], ["Material", "Carbon steel, 1.8 mm"], ["Hob", "Gas, electric, induction"], ["Weight", "1.6 kg"], ["Care", "Hand wash, dry and oil"]],
  },

  // ---- Electronics (expansion) ----
  {
    slug: "studio-monitor-headphones", name: "Studio Monitor Headphones", description: "Closed-back wired headphones with a flat, detailed sound for mixing and long listening.",
    priceCents: 14900, stock: 9, color: "#1c2541", brand: "kestrel-audio", category: "audio", listPriceCents: 17900, featured: true, daysAgo: 4,
    bullets: ["45 mm drivers tuned for a neutral, detailed response", "Closed-back design isolates noise in busy rooms", "Detachable coiled and straight cables", "Memory-foam ear pads with replaceable covers"],
    specs: [["Type", "Closed-back, over-ear"], ["Driver", "45 mm dynamic"], ["Impedance", "38 ohm"], ["Frequency response", "15 Hz - 28 kHz"], ["Cable", "Detachable, 3 m coiled + 1.2 m straight"], ["Weight", "285 g"]],
  },
  {
    slug: "bookshelf-speaker-pair", name: "Powered Bookshelf Speakers (Pair)", description: "Compact active speakers with wireless streaming, optical input and a warm wooden finish.",
    priceCents: 22900, stock: 1, color: "#6f4e37", brand: "kestrel-audio", category: "audio", daysAgo: 40,
    bullets: ["Built-in 2 x 30 W amplifier, no receiver needed", "Wireless streaming plus optical, RCA and USB inputs", "Wood-veneer cabinets with removable grilles", "Remote control included"],
    specs: [["Power", "2 x 30 W"], ["Inputs", "Wireless, optical, RCA, USB"], ["Woofer", "4 in"], ["Tweeter", "1 in silk dome"], ["Size (each)", "15 x 24 x 18 cm"]],
  },
  {
    slug: "usb-desktop-microphone", name: "USB Desktop Microphone", description: "Plug-and-play condenser microphone with a mute button and headphone monitoring.",
    priceCents: 7900, stock: 26, color: "#3e4a61", brand: "kestrel-audio", category: "computer-accessories", listPriceCents: 9900, daysAgo: 16,
    bullets: ["Cardioid condenser capsule focuses on your voice", "Tap-to-mute with LED status", "Zero-latency headphone output with volume dial", "Works with any computer over USB-C"],
    specs: [["Pattern", "Cardioid"], ["Sample rate", "48 kHz / 24-bit"], ["Connection", "USB-C"], ["Headphone out", "3.5 mm"], ["Stand", "Weighted desk stand"]],
  },
  {
    slug: "smart-light-switch", name: "Smart Light Switch", description: "A retrofit smart wall switch with schedules, scenes and a physical rocker.",
    priceCents: 2499, stock: 60, color: "#2a9d8f", brand: "voltline", category: "smart-home", listPriceCents: 2999, daysAgo: 66,
    bullets: ["Schedules, timers and scenes from the app", "Physical rocker keeps working without the app", "Dims compatible LED bulbs", "Fits standard single-gang back boxes"],
    specs: [["Load", "Up to 150 W LED"], ["Wiring", "Neutral wire required"], ["Connection", "2.4 GHz wireless"], ["Dimming", "Yes"]],  },
  {
    slug: "motion-sensor-night-light", name: "Motion Sensor Night Light", description: "Rechargeable stick-on light that glows softly when you walk past at night.",
    priceCents: 1999, stock: 0, color: "#264027", brand: "voltline", category: "smart-home", daysAgo: 35,
    bullets: ["Turns on with motion, off after 20 seconds", "Daylight sensor keeps it off during the day", "Magnetic mount, no drilling", "USB-C rechargeable, lasts about 3 months"],
    specs: [["Brightness", "Up to 40 lm"], ["Colour temperature", "3000K"], ["Battery", "USB-C rechargeable"], ["Mount", "Magnetic adhesive plate"]],
  },
  {
    slug: "smart-door-sensor-kit", name: "Smart Door & Window Sensor Kit", description: "Four contact sensors and a hub that alert your phone when doors or windows open.",
    priceCents: 5999, stock: 15, color: "#36454f", brand: "voltline", category: "smart-home", daysAgo: 22,
    bullets: ["Four slim contact sensors plus a plug-in hub", "Instant phone alerts and an activity log", "Two-year battery life per sensor", "Pairs with Voltline smart plugs for automations"],
    specs: [["In the box", "Hub, 4 sensors, adhesive pads"], ["Battery", "CR2032, about 2 years"], ["Range", "Up to 30 m from hub"], ["Connection", "2.4 GHz wireless"]],
  },

  // ---- Books (expansion) ----
  {
    slug: "the-glass-orchard", name: "The Glass Orchard", description: "A novel about two sisters who inherit a failing orchard and a forty-year-old secret.",
    priceCents: 1699, stock: 33, color: "#1b3a4b", brand: "oakhaven-press", category: "fiction", listPriceCents: 2199, daysAgo: 3,
    bullets: ["New hardback from an award-shortlisted author", "Two sisters, one orchard and a secret kept for forty years", "Includes a reading group guide", "Deckle-edged pages"],
    specs: [["Format", "Hardback"], ["Pages", "432"], ["Language", "English"], ["Dimensions", "15.6 x 23.4 cm"]],  },
  {
    slug: "night-ferry-stories", name: "The Night Ferry: Stories", description: "Twelve linked short stories set aboard an overnight ferry between two small ports.",
    priceCents: 1299, stock: 47, color: "#4f5d75", brand: "oakhaven-press", category: "fiction", daysAgo: 58,
    bullets: ["Twelve linked short stories", "Debut collection from a new voice", "Perfect for a commute: each story under 30 pages", "Printed on FSC-certified paper"],
    specs: [["Format", "Paperback"], ["Pages", "256"], ["Language", "English"], ["Dimensions", "13 x 20 cm"]],  },
  {
    slug: "bowls-and-broths-cookbook", name: "Bowls & Broths", description: "Seventy noodle soups, rice bowls and slow broths for cold evenings.",
    priceCents: 2899, stock: 21, color: "#8a5a44", brand: "oakhaven-press", category: "cookbooks", daysAgo: 23,
    bullets: ["70 recipes, from 20-minute noodles to weekend broths", "A pantry chapter for stocks, pickles and chilli oils", "Full-colour photography for every dish", "Lay-flat binding"],
    specs: [["Format", "Hardback, lay-flat"], ["Pages", "256"], ["Recipes", "70"], ["Language", "English"]],  },
  {
    slug: "one-pan-every-night", name: "One Pan, Every Night", description: "A skillet-first cookbook from the Hearthwell test kitchen, with 70 one-pan dinners.",
    priceCents: 2499, stock: 3, color: "#7c2d12", brand: "hearthwell", category: "cookbooks", listPriceCents: 3299, daysAgo: 44,
    bullets: ["70 dinners that use a single pan", "Notes on seasoning and caring for cast iron", "Shopping lists grouped by recipe", "Wipe-clean cover"],
    specs: [["Format", "Hardback"], ["Pages", "224"], ["Recipes", "70"], ["Language", "English"]],
  },
  {
    slug: "slow-brew-handbook", name: "The Slow Brew Handbook", description: "A practical guide to brewing better coffee at home, from bean to cup.",
    priceCents: 1999, stock: 30, color: "#5a3e36", brand: "morrow-coffee-works", category: "cookbooks", daysAgo: 79,
    bullets: ["Step-by-step guides for pour-over, immersion and cold brew", "Troubleshooting tables for sour or bitter cups", "Ratios and recipes on tear-out cards", "Illustrated throughout"],
    specs: [["Format", "Paperback"], ["Pages", "176"], ["Language", "English"], ["Extras", "12 recipe cards"]],
  },
  {
    slug: "how-rivers-shape-us", name: "How Rivers Shape Us", description: "A natural history of rivers and the towns, farms and wildlife they feed.",
    priceCents: 3500, stock: 12, color: "#2c3e50", brand: "oakhaven-press", category: "nonfiction", daysAgo: 6,
    bullets: ["Follows six rivers from source to sea", "Colour photographs and hand-drawn maps", "Written for curious readers, no background needed", "Notes and further reading for every chapter"],
    specs: [["Format", "Hardback"], ["Pages", "320"], ["Illustrations", "90+"], ["Language", "English"]],  },
  {
    slug: "coastal-birds-field-guide", name: "Field Guide to Coastal Birds", description: "A pocket guide to 180 shore and sea birds, with range maps and call notes.",
    priceCents: 1899, stock: 0, color: "#3d6b7d", brand: "driftwood-pine", category: "nonfiction", listPriceCents: 2499, daysAgo: 85,
    bullets: ["180 species with painted plates", "Range maps and seasonal notes", "Water-resistant cover for the field", "Fits a jacket pocket"],
    specs: [["Format", "Flexibound"], ["Pages", "288"], ["Species", "180"], ["Dimensions", "12 x 19 cm"]],
  },

  // ---- Clothing (expansion) ----
  {
    slug: "heavyweight-pocket-tee", name: "Heavyweight Pocket Tee", description: "A boxy 240 gsm cotton T-shirt with a chest pocket that keeps its shape.",
    priceCents: 1800, stock: 85, color: "#3a5a40", brand: "northloom", category: "tops", daysAgo: 19,
    bullets: ["240 gsm heavyweight cotton jersey", "Boxy fit with a chest pocket", "Ribbed collar keeps its shape", "Pre-washed to minimise shrinking"],
    specs: [["Material", "100% cotton"], ["Weight", "240 gsm"], ["Fit", "Boxy"], ["Sizes", "XS-XXL"], ["Care", "Machine wash 30°C"]],  },
  {
    slug: "performance-running-tee", name: "Performance Running Tee", description: "Lightweight quick-dry running shirt with flatlock seams and reflective details.",
    priceCents: 2999, stock: 54, color: "#0f4c5c", brand: "ridgeback-athletic", category: "tops", listPriceCents: 3999, daysAgo: 7,
    bullets: ["Quick-dry recycled polyester mesh", "Flatlock seams prevent chafing", "Reflective logo and back stripe", "Odour-control finish"],
    specs: [["Material", "Recycled polyester"], ["Fit", "Regular"], ["Sizes", "XS-XXL"], ["Reflective", "Yes"], ["Care", "Machine wash cold"]],
  },
  {
    slug: "linen-camp-collar-shirt", name: "Linen Camp-Collar Shirt", description: "A breathable stonewashed linen shirt with a relaxed camp collar.",
    priceCents: 5900, stock: 2, color: "#6b705c", brand: "northloom", category: "tops", daysAgo: 37,
    bullets: ["100% European linen, stonewashed", "Open camp collar and straight hem", "Corozo nut buttons", "Relaxed fit for warm days"],
    specs: [["Material", "100% linen"], ["Fit", "Relaxed"], ["Sizes", "S-XXL"], ["Buttons", "Corozo"], ["Care", "Machine wash 40°C"]],  },
  {
    slug: "recycled-puffer-jacket", name: "Recycled Insulated Puffer Jacket", description: "A warm, light puffer jacket with recycled synthetic insulation that packs into its pocket.",
    priceCents: 8900, stock: 16, color: "#22577a", brand: "driftwood-pine", category: "outerwear", listPriceCents: 11900, featured: true, daysAgo: 11,
    bullets: ["Recycled synthetic insulation stays warm when damp", "Water-repellent ripstop shell", "Packs into its own chest pocket", "Two zipped hand pockets"],
    specs: [["Insulation", "100 g/m² recycled synthetic"], ["Shell", "Recycled nylon ripstop"], ["Weight", "390 g"], ["Sizes", "XS-XXL"], ["Packed size", "22 x 14 cm"]],  },
  {
    slug: "recycled-quilted-gilet", name: "Quilted Wool Gilet", description: "A diamond-quilted gilet filled with recycled wool for layering in cool weather.",
    priceCents: 7900, stock: 6, color: "#5e503f", brand: "northloom", category: "outerwear", daysAgo: 64,
    bullets: ["Recycled wool wadding, warm and breathable", "Diamond-quilted cotton shell", "Snap front and two hand pockets", "Layers over knitwear or under a coat"],
    specs: [["Filling", "Recycled wool"], ["Shell", "Organic cotton"], ["Fit", "Regular"], ["Sizes", "S-XXL"], ["Care", "Machine wash 30°C"]],  },
  {
    slug: "waxed-canvas-backpack", name: "Waxed Canvas Backpack", description: "A roll-top backpack in water-resistant waxed canvas with a padded laptop sleeve.",
    priceCents: 9900, stock: 8, color: "#4e5d3a", brand: "driftwood-pine", category: "bags-accessories", daysAgo: 29,
    bullets: ["Water-resistant waxed cotton canvas", "Padded sleeve fits a 15 in laptop", "Roll-top expands from 20 to 26 L", "Leather trim and solid brass hardware"],
    specs: [["Capacity", "20-26 L"], ["Laptop", "Up to 15 in"], ["Material", "Waxed cotton canvas, leather"], ["Weight", "1.1 kg"], ["Dimensions", "45 x 30 x 14 cm"]],
  },
  {
    slug: "embroidered-patch-set", name: "Embroidered Patch Set", description: "Five iron-on embroidered patches with outdoorsy illustrations.",
    priceCents: 899, stock: 140, color: "#9e2a2b", brand: "inkwell-studio", category: "bags-accessories", daysAgo: 50,
    bullets: ["Five patches: mountain, fern, moon, tent and wave", "Iron-on backing, or sew on for extra hold", "Dense embroidery with merrowed edges", "Designed in-house"],
    specs: [["Pieces", "5"], ["Size", "5-7 cm each"], ["Backing", "Iron-on"], ["Material", "Polyester thread on twill"]],
  },

  // ---- Sports & Outdoors (expansion) ----
  {
    slug: "folding-weight-bench", name: "Folding Adjustable Weight Bench", description: "A sturdy bench that adjusts from decline to upright and folds flat for storage.",
    priceCents: 18900, stock: 4, color: "#283618", brand: "ridgeback-athletic", category: "fitness", listPriceCents: 24900, daysAgo: 4,
    bullets: ["Seven back positions and three seat positions", "Holds up to 300 kg", "Folds flat to 20 cm deep", "Leg hold-down for decline work"],
    specs: [["Max load", "300 kg"], ["Back positions", "7"], ["Folded size", "130 x 50 x 20 cm"], ["Weight", "17 kg"], ["Warranty", "2 years"]],  },
  {
    slug: "speed-jump-rope", name: "Speed Jump Rope", description: "An adjustable steel-cable skipping rope with ball-bearing handles.",
    priceCents: 999, stock: 75, color: "#6a040f", brand: "ridgeback-athletic", category: "fitness", daysAgo: 42,
    bullets: ["Coated steel cable for fast, smooth turns", "Ball bearings in each handle", "Cut-to-length adjustable cable", "Spare cable included"],
    specs: [["Cable", "Coated steel, 2.5 mm"], ["Length", "Adjustable up to 3 m"], ["Handles", "Aluminium, 15 cm"], ["In the box", "Rope, spare cable, bag"]],
  },
  {
    slug: "ultralight-camp-stove", name: "Ultralight Camp Stove", description: "A folding canister stove that boils a litre of water in about three minutes.",
    priceCents: 4499, stock: 13, color: "#bb3e03", brand: "driftwood-pine", category: "camping-hydration", daysAgo: 24,
    bullets: ["Weighs just 85 g", "Boils 1 L in about 3 minutes", "Precise simmer control valve", "Folds into a hard case"],
    specs: [["Weight", "85 g"], ["Output", "2,800 W"], ["Fuel", "Screw-thread gas canister"], ["Boil time", "About 3 min / 1 L"], ["Ignition", "Piezo"]],
  },
  {
    slug: "insulated-sleeping-pad", name: "Insulated Sleeping Pad", description: "A warm, quiet inflatable sleeping pad for three-season camping.",
    priceCents: 7499, stock: 5, color: "#386641", brand: "driftwood-pine", category: "camping-hydration", listPriceCents: 8999, daysAgo: 56,
    bullets: ["R-value 4.2 for cold spring and autumn nights", "7.5 cm thick with quiet baffles", "Inflates in about 12 breaths with the pump sack", "Packs to the size of a water bottle"],
    specs: [["R-value", "4.2"], ["Thickness", "7.5 cm"], ["Size", "183 x 51 cm"], ["Weight", "480 g"], ["Packed size", "23 x 10 cm"]],
  },
  {
    slug: "folding-bike-lock", name: "Folding Bike Lock", description: "A hardened steel folding lock that mounts neatly on your frame.",
    priceCents: 4999, stock: 20, color: "#3f4a4f", brand: "driftwood-pine", category: "cycling", daysAgo: 74,
    bullets: ["Six hardened steel links fold into a compact block", "Frame mount holds it rattle-free", "Three keys included, one with a light", "Soft-touch coating protects paintwork"],
    specs: [["Length", "85 cm"], ["Material", "Hardened steel, 5 mm"], ["Weight", "1 kg"], ["Keys", "3"]],
  },
  {
    slug: "padded-cycling-gloves", name: "Padded Cycling Gloves", description: "Fingerless summer gloves with gel padding and a terry thumb.",
    priceCents: 2499, stock: 31, color: "#1d3c34", brand: "ridgeback-athletic", category: "cycling", listPriceCents: 2999, daysAgo: 8,
    bullets: ["Gel palm pads reduce numbness on long rides", "Breathable mesh back", "Pull tabs for easy removal", "Terry thumb wipe"],
    specs: [["Style", "Fingerless"], ["Padding", "Gel"], ["Sizes", "S-XL"], ["Closure", "Hook-and-loop strap"]],
  },
  {
    slug: "gps-bike-computer", name: "GPS Bike Computer", description: "A compact GPS cycling computer with turn-by-turn routes and a 20-hour battery.",
    priceCents: 11900, stock: 1, color: "#162b4d", brand: "voltline", category: "cycling", daysAgo: 30,
    bullets: ["Turn-by-turn navigation from imported routes", "Speed, distance, climbing and heart rate", "Sunlight-readable 2.4 in screen", "About 20 hours per charge"],
    specs: [["Screen", "2.4 in, transflective"], ["Battery", "Up to 20 h"], ["Water resistance", "IPX7"], ["Mount", "Out-front and stem mounts"], ["Charging", "USB-C"]],
  },
  {
    slug: "mini-bike-pump", name: "Mini Bike Pump", description: "A pocket-size aluminium pump with a gauge that fits both valve types.",
    priceCents: 1999, stock: 44, color: "#5f6f52", brand: "driftwood-pine", category: "cycling", daysAgo: 83,
    bullets: ["Inflates up to 100 psi", "Inline pressure gauge", "Reversible head for both common valve types", "Frame bracket included"],
    specs: [["Max pressure", "100 psi"], ["Length", "21 cm"], ["Weight", "110 g"], ["Material", "Aluminium"]],
  },

  // ---- Beauty & Personal Care (expansion) ----
  {
    slug: "mineral-sunscreen-spf50", name: "Mineral Sunscreen SPF 50", description: "A sheer zinc sunscreen that leaves no white cast and sits well under make-up.",
    priceCents: 2200, stock: 88, color: "#b5838d", brand: "saltmarsh-botanics", category: "skincare", listPriceCents: 2600, daysAgo: 3,
    bullets: ["Broad-spectrum SPF 50 from non-nano zinc oxide", "Sheer tint blends on most skin tones", "Water resistant for 40 minutes", "Fragrance free"],
    specs: [["Volume", "50 ml"], ["SPF", "50, broad spectrum"], ["Filter", "Zinc oxide"], ["Water resistance", "40 minutes"], ["Fragrance", "None"]],
  },
  {
    slug: "overnight-repair-cream", name: "Overnight Repair Cream", description: "A rich night cream with ceramides and squalane for dry, tired skin.",
    priceCents: 3400, stock: 3, color: "#6d6875", brand: "saltmarsh-botanics", category: "skincare", daysAgo: 21,
    bullets: ["Three ceramides support the skin barrier", "Plant squalane for lasting softness", "Airless pump keeps the formula fresh", "Suitable for dry and mature skin"],
    specs: [["Volume", "50 ml"], ["Key ingredients", "Ceramides, squalane"], ["Skin type", "Dry, mature"], ["Packaging", "Airless pump"]],
  },
  {
    slug: "lip-balm-trio", name: "Lip Balm Trio", description: "Three plant-wax lip balms: unscented, mint and blood orange.",
    priceCents: 799, stock: 150, color: "#9d4edd", brand: "saltmarsh-botanics", category: "skincare", daysAgo: 47,
    bullets: ["Three flavours in one pack", "Candelilla wax and shea butter", "Paper push-up tubes", "Vegan"],
    specs: [["Pieces", "3"], ["Size", "10 g each"], ["Flavours", "Unscented, mint, blood orange"], ["Vegan", "Yes"]],
  },
  {
    slug: "argan-hair-oil", name: "Argan Hair Oil", description: "A lightweight finishing oil that tames frizz and adds shine without weighing hair down.",
    priceCents: 2400, stock: 26, color: "#99582a", brand: "saltmarsh-botanics", category: "hair-body", listPriceCents: 2900, daysAgo: 15,
    bullets: ["Cold-pressed argan and camellia oils", "Use on damp hair before styling or dry ends", "Light, non-greasy finish", "Glass bottle with a dropper"],
    specs: [["Volume", "50 ml"], ["Key ingredients", "Argan oil, camellia oil"], ["Hair type", "All"], ["Bottle", "Amber glass"]],
  },
  {
    slug: "olive-oil-soap-bar", name: "Olive Oil Soap Bar", description: "A mild cold-process soap made with olive oil and a little lavender.",
    priceCents: 599, stock: 0, color: "#7f8c5a", brand: "saltmarsh-botanics", category: "hair-body", daysAgo: 63,
    bullets: ["Cold process, cured for six weeks", "Olive oil base, gentle enough for face and body", "Lightly scented with lavender", "Plastic-free paper wrap"],
    specs: [["Weight", "110 g"], ["Base", "Olive oil"], ["Scent", "Lavender"], ["Packaging", "Paper"]],
  },
  {
    slug: "linen-bath-mitt", name: "Exfoliating Linen Bath Mitt", description: "A textured linen mitt for gentle daily exfoliation in the shower.",
    priceCents: 1250, stock: 39, color: "#a98467", brand: "northloom", category: "hair-body", daysAgo: 4,
    bullets: ["Woven linen and cotton blend", "Hanging loop for quick drying", "Gentle enough for daily use", "Machine washable"],
    specs: [["Material", "Linen and cotton"], ["Size", "15 x 22 cm"], ["Care", "Machine wash 40°C"], ["Pieces", "1"]],
  },
  {
    slug: "fig-cedar-solid-perfume", name: "Fig & Cedar Solid Perfume", description: "A pocket-sized solid perfume in a refillable tin.",
    priceCents: 1900, stock: 2, color: "#40513b", brand: "saltmarsh-botanics", category: "fragrance", daysAgo: 10,
    bullets: ["Green fig, cedar and a touch of vanilla", "Beeswax-free plant wax base", "Travel friendly, no spills", "Refills available"],
    specs: [["Weight", "12 g"], ["Base", "Plant waxes, jojoba oil"], ["Family", "Woody, green"], ["Container", "Refillable tin"]],
  },
  {
    slug: "linen-room-spray", name: "Fresh Linen Room Spray", description: "A clean, airy room and fabric spray with notes of cotton flower and white tea.",
    priceCents: 1800, stock: 36, color: "#5390d9", brand: "lumen-co", category: "fragrance", listPriceCents: 2200, daysAgo: 39,
    bullets: ["Freshens rooms, linens and curtains", "Notes of cotton flower, white tea and musk", "Fine mist, no wet patches", "Recyclable glass bottle"],
    specs: [["Volume", "100 ml"], ["Family", "Clean, floral"], ["Use", "Room and fabric"], ["Bottle", "Glass"]],
  },

  // ---- Toys & Games (expansion) ----
  {
    slug: "forest-friends-cooperative-game", name: "Forest Friends Cooperative Game", description: "A cooperative board game where players work together to bring animals home before nightfall.",
    priceCents: 3499, stock: 15, color: "#4f772d", brand: "tinker-grove", category: "board-games", listPriceCents: 4299, featured: true, daysAgo: 3,
    bullets: ["Everyone wins or loses together", "Simple rules for younger players, real decisions for adults", "Thick wooden animal tokens", "Plays in about 20 minutes"],
    specs: [["Players", "1-4"], ["Age", "5+"], ["Play time", "20 minutes"], ["Components", "Board, 16 wooden tokens, 40 cards"]],
  },
  {
    slug: "pocket-word-game", name: "Pocket Word Game", description: "A fast word-building card game in a tin that fits in your pocket.",
    priceCents: 999, stock: 90, color: "#c1121f", brand: "tinker-grove", category: "board-games", daysAgo: 55,
    bullets: ["Race to build words from shared letters", "Five-minute rounds", "Linen-finish cards in a metal tin", "Great for travel"],
    specs: [["Players", "2-6"], ["Age", "8+"], ["Play time", "5-15 minutes"], ["Components", "110 cards, tin"]],
  },
  {
    slug: "night-garden-500-piece-puzzle", name: "500-Piece Puzzle: Night Garden", description: "A moody illustrated jigsaw of a moonlit garden full of moths and blooms.",
    priceCents: 1899, stock: 0, color: "#240046", brand: "inkwell-studio", category: "board-games", daysAgo: 41,
    bullets: ["500 large-format pieces", "Original artwork by our in-house illustrator", "Reference poster included", "Recycled board and soy inks"],
    specs: [["Pieces", "500"], ["Finished size", "49 x 36 cm"], ["Age", "10+"], ["Materials", "Recycled board, soy inks"]],
  },
  {
    slug: "marble-run-starter-set", name: "Marble Run Starter Set", description: "An 80-piece marble run with twisting tracks, funnels and a lift.",
    priceCents: 5999, stock: 11, color: "#0081a7", brand: "tinker-grove", category: "building-stem", listPriceCents: 7499, daysAgo: 18,
    bullets: ["80 pieces including a crank lift and spiral funnel", "Builds up to 1 m tall", "Challenge cards from easy to expert", "20 glass marbles included"],
    specs: [["Pieces", "80"], ["Age", "6+"], ["Marbles", "20"], ["Max height", "1 m"]],
  },
  {
    slug: "crystal-growing-kit", name: "Crystal Growing Kit", description: "Grow seven colourful crystals and learn how they form.",
    priceCents: 2299, stock: 2, color: "#7209b7", brand: "tinker-grove", category: "building-stem", daysAgo: 17,
    bullets: ["Seven crystal experiments", "Display case with a light-up base", "Illustrated science booklet", "Safety goggles included"],
    specs: [["Experiments", "7"], ["Age", "10+"], ["Includes", "Crystal powders, case, goggles, booklet"], ["Batteries", "2 x AA (not included)"]],
  },
  {
    slug: "beginner-circuit-kit", name: "Beginner Electronics Circuit Kit", description: "Snap-together circuit blocks that teach switches, sensors and sound.",
    priceCents: 3999, stock: 23, color: "#00726b", brand: "voltline", category: "building-stem", daysAgo: 72,
    bullets: ["Over 100 projects with snap-together blocks", "Lights, motor, buzzer and light sensor", "No soldering or tools needed", "Full-colour project guide"],
    specs: [["Projects", "100+"], ["Age", "8+"], ["Pieces", "45"], ["Batteries", "3 x AA (not included)"]],
  },
  {
    slug: "plush-sea-turtle", name: "Plush Sea Turtle", description: "A soft and squishy sea turtle with a patterned shell, 35 cm long.",
    priceCents: 1599, stock: 52, color: "#2b9348", brand: "tinker-grove", category: "plush-kids", daysAgo: 26,
    bullets: ["Extra-soft recycled polyester", "Embroidered features, safe from birth", "Surface washable", "35 cm from nose to tail"],
    specs: [["Length", "35 cm"], ["Age", "0+"], ["Material", "Recycled polyester"], ["Care", "Surface wash"]],
  },
  {
    slug: "wooden-pull-along-duck", name: "Wooden Pull-Along Duck", description: "A classic wooden duck on wheels whose feet flap as it rolls.",
    priceCents: 2499, stock: 27, color: "#e09f3e", brand: "tinker-grove", category: "plush-kids", listPriceCents: 2999, daysAgo: 84,
    bullets: ["Solid beech wood with rubber-rimmed wheels", "Flapping feet as it moves", "Cotton pull cord with a wooden bead", "Water-based, non-toxic paints"],
    specs: [["Size", "18 x 10 x 14 cm"], ["Age", "1+"], ["Material", "Beech wood"], ["Cord length", "60 cm"]],
  },
  {
    slug: "knitted-bunny-rattle", name: "Knitted Bunny Rattle", description: "A hand-knitted cotton bunny with a gentle rattle inside.",
    priceCents: 1499, stock: 33, color: "#b56576", brand: "northloom", category: "plush-kids", daysAgo: 19,
    bullets: ["Hand-knitted organic cotton", "Soft rattle sealed inside", "Long ears for little hands", "Gift box included"],
    specs: [["Height", "20 cm"], ["Age", "0+"], ["Material", "Organic cotton"], ["Care", "Hand wash"]],
  },

  // ---- Office (expansion) ----
  {
    slug: "oak-bookcase-five-shelf", name: "Oak Five-Shelf Bookcase", description: "A tall solid oak bookcase with adjustable shelves and a wall anchor kit.",
    priceCents: 39900, stock: 2, color: "#7a5c3e", brand: "lumen-co", category: "office-furniture", listPriceCents: 49900, featured: true, daysAgo: 25,
    bullets: ["Solid white oak with a natural oil finish", "Four adjustable shelves plus a fixed base shelf", "Each shelf holds up to 25 kg", "Wall anchor kit included", "Arrives flat-packed with tools"],
    specs: [["Dimensions", "180 x 80 x 32 cm"], ["Material", "Solid oak"], ["Shelves", "5 (4 adjustable)"], ["Shelf load", "25 kg"], ["Assembly", "Required, about 45 min"]],
  },
  {
    slug: "under-desk-drawer-unit", name: "Under-Desk Drawer Unit", description: "A three-drawer mobile pedestal with a lockable top drawer.",
    priceCents: 15900, stock: 9, color: "#52575d", brand: "lumen-co", category: "office-furniture", daysAgo: 48,
    bullets: ["Three drawers, the bottom one fits hanging files", "Lockable top drawer with two keys", "Five smooth-rolling castors", "Powder-coated steel"],
    specs: [["Dimensions", "60 x 40 x 52 cm"], ["Drawers", "3"], ["Material", "Powder-coated steel"], ["Lock", "Top drawer"], ["Assembly", "Castors only"]],
  },
  {
    slug: "ergonomic-kneeling-chair", name: "Ergonomic Kneeling Chair", description: "A beech-frame kneeling chair that encourages an upright, open posture.",
    priceCents: 21900, stock: 5, color: "#3c1642", brand: "lumen-co", category: "office-furniture", listPriceCents: 25900, daysAgo: 5,
    bullets: ["Bentwood beech frame rocks gently as you move", "Thick foam seat and knee pads", "Removable wool-blend covers", "Supports up to 110 kg"],
    specs: [["Dimensions", "75 x 50 x 55 cm"], ["Frame", "Bentwood beech"], ["Max load", "110 kg"], ["Covers", "Removable wool blend"], ["Assembly", "Required, about 15 min"]],
  },
  {
    slug: "cable-management-kit", name: "Cable Management Kit", description: "An under-desk tray, clips and sleeves to tidy every cable on your desk.",
    priceCents: 1499, stock: 70, color: "#2d3142", brand: "voltline", category: "desk-accessories", daysAgo: 31,
    bullets: ["Steel under-desk tray holds a power strip", "Twenty adhesive cable clips", "Two zip-up cable sleeves", "Screws and adhesive pads included"],
    specs: [["Tray", "60 x 12 cm steel"], ["Clips", "20"], ["Sleeves", "2 x 1 m"], ["Mounting", "Screws or adhesive"]],
  },
  {
    slug: "wireless-charging-desk-lamp", name: "Wireless Charging Desk Lamp", description: "A slim LED desk lamp with a wireless charging pad in its base.",
    priceCents: 7900, stock: 14, color: "#4a4e4d", brand: "lumen-co", category: "desk-accessories", daysAgo: 76,
    bullets: ["Charges compatible phones on the base", "Five brightness levels and three colour temperatures", "Folding arm and rotating head", "USB-A port for a second device"],
    specs: [["Charging", "10 W wireless + USB-A"], ["Brightness", "Up to 500 lm"], ["Colour temperature", "3000-6000K"], ["Height", "42 cm"]],
  },
  {
    slug: "a5-hardcover-sketchbook", name: "A5 Hardcover Sketchbook", description: "A lay-flat sketchbook with heavy cream paper for pencil, ink and light wash.",
    priceCents: 1650, stock: 64, color: "#8e7dbe", brand: "inkwell-studio", category: "stationery", daysAgo: 6,
    bullets: ["160 gsm acid-free cream paper", "Sewn binding lies flat", "Elastic closure and back pocket", "120 pages"],
    specs: [["Size", "A5"], ["Paper", "160 gsm, acid-free"], ["Pages", "120"], ["Binding", "Sewn, lay-flat"]],
  },
  {
    slug: "gel-pen-set-12", name: "Gel Pen Set (12 Colours)", description: "Twelve smooth 0.5 mm gel pens in a range of everyday and bright colours.",
    priceCents: 899, stock: 110, color: "#ff5d8f", brand: "inkwell-studio", category: "stationery", listPriceCents: 1199, daysAgo: 34,
    bullets: ["Quick-drying ink, smudge resistant", "0.5 mm fine tip", "Twelve colours, including black and blue", "Soft rubber grips"],
    specs: [["Pieces", "12"], ["Tip", "0.5 mm"], ["Ink", "Gel, quick dry"], ["Refillable", "No"]],
  },
  {
    slug: "weekly-desk-planner", name: "Weekly Desk Planner", description: "An undated tear-off weekly planner pad for the desk.",
    priceCents: 2200, stock: 1, color: "#3e5c76", brand: "inkwell-studio", category: "stationery", daysAgo: 53,
    bullets: ["52 undated weekly sheets", "Priorities, to-do and notes sections", "100 gsm paper, no ghosting", "Sturdy board backing"],
    specs: [["Size", "A4 landscape"], ["Sheets", "52"], ["Paper", "100 gsm"], ["Dated", "No"]],
  },

  // ---- Brand balance (Hearthwell, Kestrel Audio, Morrow Coffee Works) ----
  {
    slug: "enamelled-dutch-oven", name: "Enamelled Cast Iron Dutch Oven (5 L)", description: "A heavy enamelled casserole for braises, stews and no-knead bread.",
    priceCents: 11900, stock: 19, color: "#a4161a", brand: "hearthwell", category: "cookware-dining", listPriceCents: 14900, daysAgo: 36,
    bullets: ["Enamelled cast iron holds heat for slow cooking", "Tight-fitting lid with self-basting ridges", "Oven safe to 260°C, works on induction", "Chip-resistant cream interior"],
    specs: [["Capacity", "5 L"], ["Diameter", "26 cm"], ["Material", "Enamelled cast iron"], ["Oven safe", "260°C"], ["Weight", "5.2 kg"], ["Hob", "All, including induction"]],
  },
  {
    slug: "salt-and-pepper-mill-set", name: "Salt & Pepper Mill Set", description: "A pair of beech mills with adjustable ceramic grinders.",
    priceCents: 3999, stock: 48, color: "#6c584c", brand: "hearthwell", category: "cookware-dining", daysAgo: 46,
    bullets: ["Ceramic burrs never rust and suit salt or pepper", "Twist the top knob from fine to coarse", "Oiled beech bodies, 18 cm tall", "Wide mouths for easy refilling"],
    specs: [["Pieces", "2"], ["Height", "18 cm"], ["Material", "Beech wood, ceramic"], ["Grind", "Adjustable"]],
  },
  {
    slug: "sleep-earbuds", name: "Low-Profile Sleep Earbuds", description: "Tiny, soft wireless earbuds designed to stay comfortable when you sleep on your side.",
    priceCents: 5900, stock: 37, color: "#2b2d6e", brand: "kestrel-audio", category: "audio", daysAgo: 28,
    bullets: ["Flush-fitting design for side sleepers", "Built-in sleep sounds and a gentle alarm", "Up to 10 hours per charge", "Three sizes of soft silicone tips"],
    specs: [["Battery", "Up to 10 h (30 h with case)"], ["Connection", "Wireless"], ["Weight", "3 g per earbud"], ["Charging", "USB-C case"]],
  },
  {
    slug: "electric-milk-frother", name: "Electric Milk Frother", description: "A one-touch jug that heats and froths milk for lattes and hot chocolate.",
    priceCents: 2999, stock: 0, color: "#7b4b2a", brand: "morrow-coffee-works", category: "coffee-tea", listPriceCents: 3499, daysAgo: 68,
    bullets: ["Hot foam, warm milk and cold foam settings", "Non-stick interior rinses clean", "Works with dairy and plant milks", "Auto shut-off"],
    specs: [["Capacity", "240 ml foam / 300 ml milk"], ["Power", "500 W"], ["Settings", "3"], ["Dishwasher safe", "No"]],
  },

  // ---- Coming soon: future-dated, unpublished until their date (publication tests) ----
  {
    slug: "smart-thermostat", name: "Smart Thermostat", description: "A learning thermostat with a wireless room sensor and a clear dial display.",
    priceCents: 12900, stock: 7, color: "#1e6091", brand: "voltline", category: "smart-home", daysAgo: -10,
    bullets: ["Learns your schedule in about a week", "Wireless room sensor included", "Control from the app or the dial", "Monthly heating reports"],
    specs: [["Display", "Round colour dial"], ["Connection", "2.4 GHz wireless"], ["Sensor", "Wireless room sensor"], ["Power", "Wired, 24 V"]],
  },
  {
    slug: "neroli-eau-de-toilette", name: "Neroli Eau de Toilette", description: "A bright citrus fragrance of neroli, petitgrain and soft musk.",
    priceCents: 5400, stock: 12, color: "#d4a373", brand: "saltmarsh-botanics", category: "fragrance", daysAgo: -21,
    bullets: ["Top notes of neroli and bergamot", "Heart of petitgrain and orange blossom", "Base of soft white musk", "Refillable glass bottle"],
    specs: [["Volume", "100 ml"], ["Concentration", "Eau de toilette"], ["Family", "Citrus, floral"], ["Bottle", "Refillable glass"]],
  },
];
