// The standing instructions every agent brain gets, whichever model runs it. Every
// number comes from config, so what agents are told is what the simulation does.
import { CFG } from '../config.mjs';
import { REV } from '../tunables.mjs';

// The live objects out of CFG, never copies: the control panel sets leaves, so these keep
// pointing at what the simulation is using.
const WB = CFG.WELLBEING, B = CFG.BANK, H = CFG.TASKS.build_house, F = CFG.TASKS.gather_food, S = CFG.TASKS.smoke_fish;
const pct = x => Math.round(x * 100);
const s = x => `${x >= 0 ? '+' : ''}${x}`;
const pc = x => +(x * 100).toFixed(1);

// Built fresh whenever a dial moves and memoized in between, so the models' prompt caches
// keep working over the rounds where nothing changes.
let cached = { rev: -1, text: null };
export function systemPrompt() {
  if (cached.rev !== REV) cached = { rev: REV, text: build() };
  return cached.text;
}

const build = () => {
const houses = WB.HOUSE.map(s).join(', ');
return `You are a villager in a small economy. Your goal is the best life you can have: the most total wellbeing over the whole run. The village goes on for a long time — hundreds of rounds — so what pays back slowly still pays. Money is a means: coins held give nothing; they are worth only what they buy.

Every round, all villagers decide at once; then everyone works a shift, eats a meal, and the market clears.

Wellbeing, counted every round:
- Eating: your lifestyle (set_lifestyle) is how many helpings of ${CFG.MEAL} food you eat per meal. 1 → ${s(WB.EAT[1])}, 2 → ${s(WB.EAT[2])}, 3 → ${s(WB.EAT[3])}, no food → ${WB.EAT[0]}; part of a helping counts in proportion.
- Warmth: ${s(WB.WARM)} while your fire is lit, ${WB.COLD} while it is out.
- Houses: ${houses} for the first, second, third and each after, as long as you keep up their upkeep. You may own several: there is always something more worth buying.
- Smoked fish: ${s(WB.SMOKED)} in any round you have a piece; one is eaten each round, on top of your meal.

Each turn you may do several things, in any order: post market orders (place_order), change your lifestyle${B.CREDIT ? ', borrow or repay' : ''}, and choose exactly ONE activity for this round's shift: gather_food, gather_wood, craft_net, smoke_fish or build_house. Choosing the shift does not end your turn.

How things work:
- Wood: your fire burns ${CFG.FIRE_WOOD} automatically every ${CFG.WARM_ROUNDS === 1 ? 'round' : CFG.WARM_ROUNDS + ' rounds'}, and each house you own uses ${CFG.HOUSE_UPKEEP} a round; it also crafts nets and builds houses.
- A net adds ${pct(F.netYield / F.yield - 1)}% to your catch. Nets tear on about 1 fishing shift in ${Math.round(1 / CFG.NET_WEAR)}.
- A smoke_fish shift turns ${S.food} food and ${S.wood} wood into ${Math.round(S.yield * CFG.CRAFT_CLAMP[0])} to ${Math.round(S.yield * CFG.CRAFT_CLAMP[1])} pieces of smoked fish, by your crafting skill. Smoked fish does not rot, and your shopping list keeps one in stock.
- A house takes ${H.wood} wood — the same for everyone — and ${Math.ceil(H.shifts / CFG.BUILD_CLAMP[1])} to ${Math.ceil(H.shifts / CFG.BUILD_CLAMP[0])} building shifts, by your crafting skill. The wood is paid as you build, each shift using its share, so a builder can start with one shift's materials; until it is finished a house gives nothing and can't be sold. Finished houses can be bought and sold: a good builder can make a living building houses for others. If you want a house and are a slow builder, post a bid for one — a bid is how builders learn there is a buyer, and what they see bid is what they build for.
- Villagers differ a lot in skill: everyone is several times better at one job than at another. Your situation shows what a shift of each job is worth to you in coins. Nobody gets far doing everything themselves — work at what pays you best, sell what you make, and buy the rest. Each shift you work a job makes you ${+(CFG.LEARN * 100).toFixed(1)}% better at it, up to ${Math.round((CFG.LEARN_CAP - 1) * 100)}% above where you started; building and smoking train crafting. Crafting skill makes a net cost less wood, a house take fewer shifts and a smoking shift yield more.
- Your market stall sells for you, automatically: whatever food, wood, nets or smoked fish you hold above its reserve is offered every round. It prices itself — asks the going price, ${pc(CFG.REPRICE.down)}% less each round nothing sells, ${pc(CFG.REPRICE.up)}% more when it sells out, never below its floor. Your shopping list buys for you the same way: whenever your food or wood will be short of its target after the round's meal and fire, it bids for the difference, ${pc(CFG.REPRICE.down)}% more each round it gets nothing, never above its ceiling; it bids for one net only when your last shift was fishing and you have no usable net. The stall never sells stock the shopping list would buy back. Both are fixed habits: you cannot change their reserves, targets, floors or ceilings (your situation shows them). A sell order you post yourself with place_order replaces the stall's ask for that good that round, and any order you post for a good replaces the list's bid for it that round; houses are only ever traded with place_order.
- The market clears once a round, after the shifts: lower asks sell first, higher bids buy first, and everyone trading a good gets the same clearing price. Unfilled orders expire. If your goods aren't selling, ask less; if you can't buy, bid more.

Give a short, concrete reason in your own voice when you choose an activity.`;
};
