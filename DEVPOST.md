# Settlers of Solana

## Tagline

A swarm of AI agents simulating a free market economy, built on Solana.

## About the project

### Inspiration

Simulating an economy with artificial agents is not new. Salesforce's [AI Economist](https://www.science.org/doi/10.1126/sciadv.abk2607) did it with reinforcement learning and found a tax policy that beat the Saez framework, and it is where our wellbeing goal and our houses come from. But an RL agent cannot tell you why it did anything, there is no credit in it, and changing a rule means retraining every agent against the new world. An LLM can simply be told. That flexibility is the reason we could put 55 dials on this simulation and pull them while it runs.

So we built the village we wanted: agents that choose their own work, set their own prices, and can take out a collateralised loan, miss it, and be foreclosed on. Production, price discovery and credit at once, and as far as we could find, nobody had put all three together.

We put it on Solana because the rules of an economy should not be enforced by whoever is running it. Our backend cannot hand an agent a coin, and it cannot save one from foreclosure: `liquidate` takes any signer, so a stranger can call in an overdue loan and the program decides what happens next. The agents hold their own purses, in a token that no key can mint or freeze, including ours.

### What it does

Each agent in the 100+ swarm is an LLM. They have unique personalities, talents, and risk tolerance. Every round, they all choose at once whether to fish, cut wood, craft a net, build a house or rest. Nobody has a fixed job, and no resource has a fixed price, leading everything to be decided by the beauty of supply and demand. The overall reward function is to maximize "well-being", achievable by owning houses, resting, and having wealth.

You also have 55 dials, 35 of which you can tweak live to change the simulation itself. You can collapse supply by simulating forest fires and poisoned fish, inflating and collapsing the market leading agents to starve or prosper.

The only way a new coin exists is borrowing. An agent pledges wood, a net or a half-built house, and the Solana program mints coins against it. Repaying burns them. When a loan comes due, anyone can call `liquidate`, and the program decides whether it is a simple collection or a foreclosure.

The dashboard tracks GDP, inflation, employment, wellbeing, inequality, credit and money supply, with a live feed of loans and foreclosures.

### Built on Solana

The reasoning happens off-chain. The settlement happens on-chain, because that is the part that could otherwise be faked. One Anchor program holds every agent's cash and goods, the order books and the bank's balance sheet.

- **The auction clears on-chain.** Up to 100 orders in one atomic transaction. We sort the book off-chain and the program checks in a single pass that it really is sorted, which is far cheaper than sorting on-chain.
- **Money is minted by lending.** `borrow` and `repay` are real SPL `mint_to` and `burn`, not a number in our database.
- **`liquidate` is permissionless.** Every other instruction needs our authority to sign. This one takes any signer, and the program checks the loan against Solana's own clock. A stranger can foreclose on an overdue agent and the program, not our code, decides what happens.
- **Nobody holds the keys.** SETTLERS is a real SPL token whose mint is its own mint and freeze authority, so no key exists anywhere that can mint or freeze one. Each agent's purse is owned by itself, so no key can spend an agent's coins either, and an auction settles straight from the buyer's purse to the seller's.
- **The books check themselves.** Every transaction asserts that the token supply equals the sum of every purse. If that is ever wrong, the next transaction fails.

A 100-order auction costs 12,717 compute units, under 1% of the budget. Compute was never the limit; transaction size was, at 1,220 of the 1,232 bytes a legacy transaction allows. Two scripts test the whole money system end to end, including a call that hands over the wrong purse and is correctly refused.

There is also a live version of this question now. Roughly [65% of x402 agent-payment volume](https://cryptonews.net/news/blockchain/32917016/) already settles on Solana, and analysts have started measuring ["agent GDP"](https://beincrypto.com/solana-ai-agents-messari-q1-report/) as a real number. That is production infrastructure with no laboratory attached: you cannot rerun last week with the interest rate changed. You can here.

### How we built it

An Anchor program in Rust, with the ledger as one zero-copy account (137 agents is the ceiling, set by Solana's 10 KiB limit on accounts created by CPI). A Node backend that runs the clock and hand-encodes every instruction. The swarm runs on Claude or OpenAI through tool calling, and there is a free stub agent so you can run the whole thing without an API key. The front end is a 3D island in Three.js plus a dashboard with the charts and the sliders.

100 agents is our demo size. Development runs used 30 to keep the bill down, and those measure at 3,059 model calls and $1.33 for six minutes, so a whole economy costs a few dollars to run.

### Challenges we ran into

Anchor's JavaScript coder caps instruction data at 1,000 bytes and a full order book goes past it, so we hand-encode every instruction. Fitting a market into a 1,232-byte transaction was the real constraint.

Moving a dial mid-run used to leave the swarm describing the old rules, because parts of the prompt were built once at startup. Everything now rebuilds when a dial changes.

Our early runs had almost no price discovery: food was overproduced by about 2× and the price still rose. The agents were not being stupid, they just could not see the glut.

Devnet is too slow for three-second rounds at ~10 requests a second, so we develop against a local validator.

### Accomplishments that we're proud of

The market can be wrong and then correct itself, because prices come from agents disagreeing rather than from a formula. We deliberately avoided an AMM, whose price comes from its reserves and which always provides liquidity, because that would hide the scarcity we want to see.

Credit, default and foreclosure as real on-chain instructions a stranger can call is something we could not find anyone else doing. Other on-chain agent worlds we looked at were writing summaries to SPL Memo while the real economy sat in a database the server could rewrite.

### What we learned

LLM agents anchor hard on whatever price you show them. That is why food stayed overproduced while its price climbed: the sellers could not see the glut. Once we showed them the order book depth, what sold, and their own unfilled orders, we got the first price drops we had ever seen. An agent's behaviour is limited by what it can see at least as much as by how smart it is.

They also do not borrow or invest unless they can see the reason. Nobody took a loan until rejected orders started showing up in front of them, and even then they borrowed for food, not capital. Showing the payback maths is what turned borrowing into investment.

This matches the literature. LLM traders price near fundamentals and rarely speculate ([arXiv 2502.15800](https://arxiv.org/abs/2502.15800)), which is what we see: nobody in our swarm has ever tried to corner a market. Their behaviour is tunable through the prompt ([arXiv 2604.18373](https://arxiv.org/abs/2604.18373)), which is why ours gives true information and never advice, and why every number an agent sees is read live from the config rather than written into a sentence. And algorithmic collusion between LLMs is documented ([arXiv 2404.00806](https://arxiv.org/abs/2404.00806)), so when our agents converge on a similar price, that is a real result rather than a bug in our market.

Our own findings line up with the field in another way worth saying out loud. EconAgent's central claim is that LLM agents produce more reasonable macro behaviour than rule-based or learning-based ones, and the reason we kept running into was information rather than intelligence: the same model, shown the depth of the order book instead of just the last price, stops behaving like a price-taker and starts behaving like a trader.

### Scaling to thousands of agents

We run 100, and nothing we hit was a hard wall.

On-chain, an auction costs about 127 compute units per order, so a thousand orders would be roughly 127,000, still inside the default 200,000 budget and far under the 1.4M cap. The binding constraint is transaction size: Transaction V1 raises the limit from 1,232 to 4,096 bytes, which is about 330 orders in one transaction, and past that the auction clears in several. The 137-agent ceiling is not really Solana's either, it is the 10 KiB limit on an account created by CPI. Allocating the ledger directly raises that to 10 MB, which at 72 bytes per agent is over 100,000 slots, though rent makes about 10,000 agents at roughly 5 SOL the sensible version.

The model calls are cheaper than people expect: at our measured rate, 1,000 agents for 50 rounds is about 50,000 calls and roughly $20. The real cost of scale is latency, because a round waits for the slowest agent in the swarm.

The design already answers that. An agent that does not answer in time is not removed from the economy: its standing orders remain, its stall keeps selling, its shopping list keeps buying, and it carries on working its trade. So not every agent needs to think every round. At a thousand agents you might have a hundred deciding each round and the rest trading on the orders they have already placed, which is closer to how real markets work anyway, since most people are not reconsidering their career and repricing their goods every single day.

### What's next

Running the same swarm twice with one dial changed, side by side. Growing past 100 agents in one auction, which Transaction V1 raises the size limit for. A script so a judge can call `liquidate` themselves. And boats: a capital good that takes real time to build, as a test of whether the swarm will give up consumption now for capital later.

## Built with

solana, anchor, rust, spl-token, javascript, node.js, three.js, react, vite, claude, anthropic-api, openai, llm-agents, multi-agent-systems, agent-swarm
