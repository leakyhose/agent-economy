// A tiny synthetic world with neutral vocabulary, used to exercise the kernel
// directly without depending on either shipped fixture.

import type { WorldDefinition } from '@aw/types';

export function testWorld(): WorldDefinition {
  return {
    name: 'Kernel Test World',
    seed: 12345,
    resources: [
      { id: 'coin', startPrice: 1, divisible: true },
      { id: 'widget', startPrice: 100, spoilage: 0.5 },
      { id: 'gem', startPrice: 900, spoilage: 0 },
    ],
    entityTypes: [
      {
        id: 'unit',
        agent: true,
        attributes: { mood: 0, tag: 'none' },
        resources: { coin: 1000, widget: 5, gem: 0 },
      },
      { id: 'holding', attributes: { label: 'unnamed' }, resources: { coin: 0, widget: 0, gem: 0 } },
    ],
    actions: [
      { id: 'produce', actorTypes: ['unit'], duration: 2 },
      {
        id: 'consume',
        actorTypes: ['unit'],
        duration: 1,
        params: [{ name: 'amount', type: 'number', required: true }],
      },
      {
        id: 'overspend',
        actorTypes: ['unit'],
        duration: 1,
        params: [{ name: 'amount', type: 'number', required: true }],
      },
      {
        id: 'offer',
        actorTypes: ['unit'],
        duration: 1,
        params: [
          { name: 'resource', type: 'resource', required: true },
          { name: 'quantity', type: 'number', required: true },
          { name: 'limit', type: 'number', required: true },
        ],
      },
      {
        id: 'seek',
        actorTypes: ['unit'],
        duration: 1,
        params: [
          { name: 'resource', type: 'resource', required: true },
          { name: 'quantity', type: 'number', required: true },
          { name: 'limit', type: 'number', required: true },
        ],
      },
      {
        id: 'endow',
        actorTypes: ['unit'],
        duration: 1,
        params: [{ name: 'capital', type: 'number', required: true }],
      },
      {
        id: 'bond',
        actorTypes: ['unit'],
        targetTypes: ['unit'],
        duration: 1,
      },
    ],
    rules: [
      {
        id: 'produce_yield',
        when: { action: 'produce' },
        effects: [
          { op: 'increment', path: '$actor.resources.widget', by: 2 },
          { op: 'emit', event: 'produced', data: { n: 2 } },
        ],
      },
      {
        id: 'consume_needs_coin',
        when: { action: 'consume' },
        require: [{ gte: [{ ref: '$actor.resources.coin' }, { ref: '$params.amount' }] }],
        effects: [{ op: 'decrement', path: '$actor.resources.coin', by: { ref: '$params.amount' } }],
      },
      {
        // Deliberately unguarded: proves the engine refuses rather than clamps.
        id: 'overspend_unguarded',
        when: { action: 'overspend' },
        effects: [{ op: 'decrement', path: '$actor.resources.coin', by: { ref: '$params.amount' } }],
      },
      {
        id: 'offer_needs_stock',
        when: { action: 'offer' },
        require: [
          { gte: [{ ref: '$actor.resources.$params.resource' }, { ref: '$params.quantity' }] },
          { gt: [{ ref: '$params.quantity' }, 0] },
        ],
        effects: [{ op: 'emit', event: 'ask_posted' }],
      },
      {
        id: 'seek_needs_funds',
        when: { action: 'seek' },
        require: [
          {
            gte: [
              { ref: '$actor.resources.coin' },
              { mul: [{ ref: '$params.quantity' }, { ref: '$params.limit' }] },
            ],
          },
          { gt: [{ ref: '$params.quantity' }, 0] },
        ],
        effects: [{ op: 'emit', event: 'bid_posted' }],
      },
      {
        id: 'endow_spawns',
        when: { action: 'endow' },
        require: [{ gte: [{ ref: '$actor.resources.coin' }, { ref: '$params.capital' }] }],
        effects: [
          { op: 'decrement', path: '$actor.resources.coin', by: { ref: '$params.capital' } },
          { op: 'spawn', type: 'holding', bind: '$new', attributes: { label: 'fresh' } },
          { op: 'increment', path: '$new.resources.coin', by: { ref: '$params.capital' } },
          { op: 'relate', from: '$actor', to: '$new', kind: 'controls' },
          {
            op: 'settle',
            asset: 'coin',
            from: '$actor',
            to: '$new',
            amount: { ref: '$params.capital' },
          },
        ],
      },
      {
        id: 'bond_relates',
        when: { action: 'bond' },
        effects: [
          { op: 'relate', from: '$actor', to: '$target', kind: 'peer' },
          { op: 'emit', event: 'bonded' },
        ],
      },
      {
        id: 'mood_drifts',
        when: { tick: { every: 4 } },
        effects: [{ op: 'increment', path: '$each.unit.attributes.mood', by: 1 }],
      },
    ],
    markets: [
      { id: 'widget_market', resource: 'widget', currency: 'coin', mechanism: 'batch_auction', roundTicks: 3 },
      { id: 'gem_market', resource: 'gem', currency: 'coin', mechanism: 'batch_auction', roundTicks: 5 },
    ],
    population: [{ type: 'unit', count: 4 }],
    events: [
      { id: 'scheduled_shock', atTick: 5, effects: [{ op: 'emit', event: 'shock' }] },
      { id: 'maybe_shock', every: 3, chance: 0.5, effects: [{ op: 'emit', event: 'maybe' }] },
    ],
    metrics: [
      { id: 'coin_sum', aggregate: 'sum', over: 'unit', value: { ref: '$e.resources.coin' } },
      { id: 'coin_gini', aggregate: 'gini', over: 'unit', value: { ref: '$e.resources.coin' } },
      { id: 'units', aggregate: 'count', over: 'unit' },
    ],
  };
}
