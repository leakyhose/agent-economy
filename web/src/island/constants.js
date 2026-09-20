// The island's data tables, lifted verbatim from frontend/Moku Island.dc.html.
// These match the real backend: five places (frontend/island3d.js AREAS), plus trading,
// banking and resting all show up at the market, since nobody has a task of their own there.
const LOCS = [
  { id: "docks", x: -70, z: 38, name: "Docks", act: "gather_food", color: "#1f9fb5", glyph: "wave",
    blurb: "Where villagers fish for food.", ground: "linear-gradient(180deg,#f3e2b4 0%,#e8d29a 100%)", sky: "linear-gradient(180deg,#bdeaf7 0%,#e8f6e3 62%,#e8f6e3 100%)" },
  { id: "forest", x: 40, z: -48, name: "Forest", act: "gather_wood", color: "#3f9450", glyph: "tree",
    blurb: "Where villagers chop wood.", ground: "linear-gradient(180deg,#8fd06f 0%,#68b35c 100%)", sky: "linear-gradient(180deg,#cdeeff 0%,#eaf8e0 62%,#eaf8e0 100%)" },
  { id: "workshop", x: 60, z: 8, name: "Workshop", act: "craft_net", color: "#d98c2b", glyph: "grid",
    blurb: "Where wood is crafted into nets.", ground: "linear-gradient(180deg,#e9d8ae 0%,#d6bf8c 100%)", sky: "linear-gradient(180deg,#ffe6c0 0%,#fdf3dd 62%,#fdf3dd 100%)" },
  { id: "site", x: -16, z: -50, name: "Building site", act: "build_house", color: "#cf6046", glyph: "house",
    blurb: "Where villagers build houses.", ground: "linear-gradient(180deg,#e6d6ad 0%,#cdb98b 100%)", sky: "linear-gradient(180deg,#ffd9c2 0%,#fdeede 62%,#fdeede 100%)" },
  { id: "market", x: 18, z: 56, name: "Market", act: "trade", color: "#8a8f98", glyph: "diamond",
    blurb: "Where goods are traded, loans are taken, and villagers rest.", ground: "linear-gradient(180deg,#f0e0b6 0%,#ddc894 100%)", sky: "linear-gradient(180deg,#cdefff 0%,#f3f6dd 62%,#f3f6dd 100%)" }
];
// Any activity without its own place (trade, bank, rest) buckets into the market.
const bucketOf = act => LOCS.find(l => l.act === act) || LOCS.find(l => l.id === "market");

const ACT_LABEL = { gather_food: "Fishing", gather_wood: "Chopping wood", craft_net: "Crafting nets", trade: "At the market", build_house: "Building", bank: "At the bank", rest: "Resting" };
const SHORT = { settle_auction: "auction", post_order: "order", mint_loan: "mint", burn_repay: "burn", transfer_goods: "goods", accrue_interest: "interest" };
const SKIN = ["#f6d3b8", "#efc09b", "#e0a87c", "#c98a5e", "#a9683f", "#8a5232"];
const HAIR = ["#3a2b22", "#5d3b23", "#8a5a2b", "#c98b3a", "#2b2b33", "#7a4a55", "#d9b26a"];
const SHIRT = ["#ef8f6a", "#54b0c4", "#7fbf62", "#e6c34d", "#c07fc0", "#6d8de0", "#e8767f", "#4bbfa0"];
const KINDS = [
  { k: "settle_auction", c: "#14f195" }, { k: "post_order", c: "#7fd4ff" },
  { k: "mint_loan", c: "#ffd166" }, { k: "burn_repay", c: "#ff9f7a" },
  { k: "transfer_goods", c: "#b9a6ff" }, { k: "accrue_interest", c: "#9fe0c4" }
];
const EMPTY_SIM = {
  agents: [], prices: { food: 0, wood: 0, nets: 0, boats: 0, houses: 0 },
  pricePrev: { food: 0, wood: 0, nets: 0, boats: 0, houses: 0 },
  vols: { food: 0, wood: 0, nets: 0, boats: 0, houses: 0 },
  books: {}, feed: [], round: 0, tick: 0, seconds: 0, gdp: 0, gdpPrev: 0, wbRound: 0, wbRoundPrev: 0,
  supply: 0, debt: 0, minted: 0, burned: 0, txTotal: 0, lastRoundTxs: 0,
  roundMs: 0, agentTarget: 0, brain: "Loading…", program: "-", ledger: "-", explorer: "#"
};
export { LOCS, bucketOf, ACT_LABEL, SHORT, SKIN, HAIR, SHIRT, KINDS, EMPTY_SIM };
