// Launch Radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// What the board is. Every protocol the snapshot's watchlist names is on the board (the watchlist is
// the floor, never the ceiling), and so is every other protocol in the snapshot that records no token
// and is not a wrapped, staked or bridged product of one that already trades, a versioned pool of
// another protocol, or an exchange's own listing. Those early rows are the ones a radar exists to
// find: big enough to matter (the snapshot itself starts at $5M of TVL), not yet on any watchlist.
//
// What a token would be worth. A protocol that already trades answers the question itself: across
// this snapshot, a token's market cap stands in a fairly steady ratio to its protocol's TVL, and the
// ratio is a property of the category, not of the whole market — lending tokens clear near a tenth
// of TVL, DEX tokens nearer a third. So the model prices a pre-token protocol the way the market
// already prices its launched peers:
//
//   peerMultiple = the median market-cap / TVL of the category's launched protocols, pulled toward
//                  the market-wide median when the category has few launched peers to learn from.
//                  A peer's own ratio is first held inside [0.01, 2.0]: this index carries tokens
//                  whose market cap has almost nothing to do with the TVL recorded beside them (an
//                  oracle token filed under a curator category at 3x, a prediction token at 400x),
//                  and one such record must not price a whole category.
//   growthMult   = 1 + clamp(change_7d, -50, +100) / 100 x 0.6     (a hot week is evidence, not proof)
//   maturityMult = 0.75 + 0.45 x min(age_days, 1460) / 1460        (four years tokenless is a record)
//   implied      = round(tvl_usd x peerMultiple x growthMult x maturityMult), at least $1
//
// Every input is a figure the snapshot itself carries: TVL, seven-day growth, the day DefiLlama
// began tracking the protocol, and the market caps of its launched peers. No protocol's name is
// special-cased anywhere in this file: one function scores every row, and the dashboard restates
// the arithmetic so a reader can check any row by hand.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's weights, stated in the dashboard; the page's sandbox may move them there. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_base: number;
  maturity_span: number;
  maturity_days: number;
  unknown_age_days: number;
  peer_shrinkage: number;
  ratio_floor: number;
  ratio_cap: number;
  multiple_floor: number;
  multiple_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  maturity_base: 0.75,
  maturity_span: 0.45,
  maturity_days: 1460,
  unknown_age_days: 365,
  peer_shrinkage: 6,
  ratio_floor: 0.01,
  ratio_cap: 2,
  multiple_floor: 0.02,
  multiple_cap: 1.5,
};

/** The model's version label: the dashboard names it and the board's rows carry its inputs. */
export const MODEL_VERSION = 'launch-radar-2';

/** The smallest TVL an early (non-watchlist) row may carry: the snapshot's own inclusion floor. */
export const EARLY_MIN_TVL = 5_000_000;

/** How many launched protocols the dashboard's Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One launched peer the model learned a category's multiple from. */
export interface PeerStat {
  category: string;
  peers: number;
  median_ratio: number;
  multiple: number;
  top: { slug: string; name: string; mcap_usd: number; tvl_usd: number; ratio: number }[];
}

/** One row of board.json: the ranked board's row, with the model's inputs kept beside its answer. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    peer_multiple: number;
    peer_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  peer_multiple: number;
  peer_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A launched protocol: it already trades, so the dashboard shows the market's own value for it. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  ratio: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the peer table and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_median_ratio: number;
  rows: RadarRow[];
  live: LiveRow[];
  peers: PeerStat[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word that marks a wrapped or staked product of a token that already trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Categories that are products of another protocol's token, never a launch of their own. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/**
 * Whether a protocol below the watchlist is one the early radar may rank: it records no token, and
 * nothing in its record marks it as another protocol's product, pool or exchange listing.
 */
export function isEarlyCandidate(p: SnapshotProtocol): boolean {
  return (
    recordsNoToken(p) &&
    !PRODUCT_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name)
  );
}

/**
 * What the market pays for a dollar of TVL, learned from the snapshot itself: for every category,
 * the median market-cap / TVL of its launched protocols, shrunk toward the market-wide median by
 * the number of peers there are to learn from, then held inside sane bounds.
 */
export function peerMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): { byCategory: Map<string, PeerStat>; globalMedian: number } {
  const launched = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const held = (p: SnapshotProtocol): number => Math.min(model.ratio_cap, Math.max(model.ratio_floor, p.mcap_usd! / p.tvl_usd));
  const globalMedian = launched.length > 0 ? median(launched.map(held)) : 0.2;
  const groups = new Map<string, SnapshotProtocol[]>();
  for (const p of launched) {
    const key = p.category ?? 'Uncategorised';
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const byCategory = new Map<string, PeerStat>();
  for (const [category, list] of groups) {
    const ratios = list.map(held);
    const med = median(ratios);
    const shrunk = (list.length * med + model.peer_shrinkage * globalMedian) / (list.length + model.peer_shrinkage);
    const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, shrunk));
    const top = [...list]
      .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
      .slice(0, 5)
      .map((p) => ({ slug: p.slug, name: p.name, mcap_usd: p.mcap_usd!, tvl_usd: p.tvl_usd, ratio: round4(p.mcap_usd! / p.tvl_usd) }));
    byCategory.set(category, { category, peers: list.length, median_ratio: round4(med), multiple: round4(multiple), top });
  }
  return { byCategory, globalMedian };
}

/** The multiple one protocol is priced at: its category's, or the market-wide median when it has none. */
function multipleFor(p: SnapshotProtocol, peers: Map<string, PeerStat>, globalMedian: number, model: ModelConstants): { multiple: number; peerCount: number } {
  const stat = peers.get(p.category ?? 'Uncategorised');
  if (stat !== undefined) return { multiple: stat.multiple, peerCount: stat.peers };
  return { multiple: Math.min(model.multiple_cap, Math.max(model.multiple_floor, globalMedian)), peerCount: 0 };
}

/** The three factors and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  peers: Map<string, PeerStat>,
  globalMedian: number,
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; peerCount: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, peerCount } = multipleFor(protocol, peers, globalMedian, model);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_base + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_span;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, peerCount, growthPct, growthMult, maturityMult, age };
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, scored like any other row.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other protocol the snapshot carries that records no token and is not a
  // product, pool or exchange listing, down to the snapshot's own $5M inclusion floor.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isEarlyCandidate(p) && p.tvl_usd >= EARLY_MIN_TVL) chosen.set(p.slug, p);
  }

  const { byCategory, globalMedian } = peerMultiples(snapshot, model);
  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, byCategory, globalMedian, model) }));
  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    watchlist: watchlist.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      peer_multiple: round4(s.multiple),
      peer_count: s.peerCount,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmPlan(s.p, s.age),
  }));
}

// ---------------------------------------------------------------------------
// Farm plans. A plan is derived from the protocol's own record — its category
// decides the actions, its chains decide where, its TVL decides the capital a
// position needs, its age decides how long the position must be held — and
// every step states what it costs and how long it takes.
// ---------------------------------------------------------------------------

/** The chains a plan can name, in the protocol's own order, or a neutral phrase. */
function chainList(p: SnapshotProtocol, max = 2): string {
  if (p.chains.length === 0) return 'its main chain';
  return p.chains.slice(0, max).join(' and ');
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The two things a farmer actually does with a protocol of this kind: the entry and the follow-through. */
function actionsFor(p: SnapshotProtocol, capital: number): { entry: string; follow: string } {
  const c = (p.category ?? '').toLowerCase();
  const chain = chainList(p);
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return {
      entry: `Supply $${capital} of USDC to ${name} on ${chain}; a plain supply position is the activity a points program counts first.`,
      follow: `Borrow about 30% of the supplied value against the position and re-supply it once, so both sides of the market show your wallet.`,
    };
  }
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual')) {
    return {
      entry: `Trade on ${name} on ${chain}: swap $${capital} of volume in four or five separate trades rather than one, so the activity spans several days.`,
      follow: `Add $${Math.round(capital / 2)} of liquidity to ${name}'s deepest pool and leave it through at least two weekly epochs.`,
    };
  }
  if (c.includes('bridge')) {
    return {
      entry: `Bridge $${capital} of USDC from Ethereum to ${chainList(p, 1)} through ${name}, then use the bridged funds in one app on the far side.`,
      follow: `Bridge a second, smaller amount back a week later; a round trip counts more than a one-way transfer.`,
    };
  }
  if (c.includes('restak') || c.includes('staking')) {
    return {
      entry: `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the same wallet.`,
      follow: `Restake or delegate the receipt once if ${name} offers it, and leave both positions untouched for the holding window.`,
    };
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield')) {
    return {
      entry: `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the vault shares in the farming wallet.`,
      follow: `Split a second $${Math.round(capital / 2)} into a different ${name} vault or market, so the wallet shows breadth, not one deposit.`,
    };
  }
  if (c.includes('rwa')) {
    return {
      entry: `Complete ${name}'s onboarding or KYC if it asks for it, then mint $${capital} of its yield asset on ${chain}.`,
      follow: `Hold the minted asset and take one payout or interest claim inside the window, so the wallet shows a full cycle.`,
    };
  }
  if (c.includes('stable')) {
    return {
      entry: `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold the balance.`,
      follow: `Use the stable asset in one paired market ${name} lists, such as a lending supply or a liquidity pool, for a week.`,
    };
  }
  if (c.includes('insurance')) {
    return {
      entry: `Buy $${capital} of cover from ${name} on ${chain} for the longest term it offers and keep the policy active.`,
      follow: `Stake a smaller amount into ${name}'s capital pool as well, so the wallet appears on both sides of the market.`,
    };
  }
  if (c.includes('chain')) {
    return {
      entry: `Bridge $${capital} of USDC to ${name} and make it the wallet's home chain for this farm: gas, one swap and one deposit there.`,
      follow: `Use two native apps on ${name} each week; a new chain counts distinct active wallets and contracts touched.`,
    };
  }
  return {
    entry: `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the whole window.`,
    follow: `Repeat the core action once a week in a small amount, so the wallet reads as a returning user, not a one-off.`,
  };
}

/** One step as one string: the action, then its cost and its time, inside the gate's 20..600 characters. */
function step(action: string, cost: string, time: string): string {
  let s = `${action} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page weekly.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps from wallet setup to unwind, each with a cost and a time.
 * Nothing in a plan names a step the protocol's own category would not recognise.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): string[] {
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 250 ? 10 : capital >= 100 ? 6 : 3;
  const { entry, follow } = actionsFor(p, capital);
  return [
    step(
      `Start with a fresh wallet funded only from your main wallet, and store its seed phrase offline; one wallet per protocol keeps every farm separable.`,
      'no fee beyond the funding transfer',
      '10 minutes',
    ),
    step(entry, `$${capital} of capital plus about $${gas} of gas`, '20 minutes to set up'),
    step(follow, `about $${Math.max(2, Math.round(gas / 2))} of gas`, '15 minutes'),
    step(
      `Return once a week on the same weekday and repeat one qualifying action, so the wallet builds a streak instead of a single spike.`,
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    step(
      `Hold every position for at least ${hold} days; ${p.name} has run ${age === null ? 'for an unrecorded span' : `${age} days`} with no token on record, and short visits are the first thing points programs filter out.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    step(
      `Check ${p.name}'s own points or rewards page before withdrawing, and claim only from a link the protocol itself publishes; never pay a fee to claim an airdrop.`,
      'no fee to check',
      '10 minutes',
    ),
    step(
      `Keep a farm log (wallet, dates, transaction hashes, amounts) and leave $5 of gas in the wallet at the end, so the position can be unwound or topped up without a rescue transfer.`,
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

/** The launched protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    peer_multiple: row.model.peer_multiple,
    peer_count: row.model.peer_count,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const { byCategory, globalMedian } = peerMultiples(snapshot, model);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_median_ratio: round4(globalMedian),
    rows: board.map(radarRow),
    live,
    peers: [...byCategory.values()].sort((a, b) => (a.category < b.category ? -1 : 1)),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows: the gate wants at least 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
