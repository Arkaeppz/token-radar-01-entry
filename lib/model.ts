// Launch Radar: a fitted token-launch model over one sealed DefiLlama snapshot.
//
// The model is fitted, not asserted. The snapshot's tokenised protocols (the ones whose record
// carries a market cap) are the training set: for each of them the market has already answered
// the question this board asks of the pre-token ones, namely what a token is worth next to the
// protocol's TVL. The fit works in log10 space:
//
//   log10(implied) = log10(tvl) + category multiple + size term + growth term + age term
//
// The category multiple is the peer group's median log10(mcap / tvl), shrunk toward the global
// median by the group's size, so a category with two peers borrows most of its multiple from the
// whole field and one with fifteen stands mostly on its own record. The size, growth and age
// terms are single slopes fitted by least squares on the residuals. Which of those terms earns
// its place is decided by five-fold cross-validation on the peers, run inside this program on
// every run: a term is kept only when it lowers the held-out median error. The board therefore
// changes if the snapshot changes, and no protocol's name is ever special-cased.
//
// Every implied value ships with the interval the validation measured: the 80th percentile of
// the held-out absolute log10 error, applied as a divide/multiply band. The dashboard prints the
// whole validation table, kept terms and dropped ones alike, so a reader can see what the model
// is worth before trusting a single row of the board.
//
// Beside value, each row carries the launch record of its peers: the share of protocols in its
// category whose record already carries a token, shrunk the same way. That share never moves a
// rank (the gate ranks by implied value alone); it prices the farm verdict, together with the
// plan's own costed steps: expected record-weighted value per dollar the plan spends.

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

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's version label, printed by the dashboard's method view. */
export const MODEL_VERSION = 'launch-radar-2';

/** Peers a category needs before its own median outweighs the global one (the shrink weight). */
const SHRINK_K = 4;
/** The growth figure is clamped to this band before it touches the fit or a score. */
const GROWTH_MIN = -50;
const GROWTH_MAX = 100;
/** Cross-validation folds over the slug-sorted peer list: deterministic on every run. */
const FOLDS = 5;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to the snapshot's `asOf`, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, on a sorted copy. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The q-th percentile (0..1) of a non-empty list, nearest-rank on a sorted copy. */
function percentile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const at = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[at]!;
}

/** Round to 4 decimal places, the board's stated precision for model internals. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * The house's own product rules, applied by this board at every size, not only above the
 * watchlist floor: categories whose product is a claim on an asset that already trades
 * (bridges, canonical bridges, liquid staking and restaking, restaked BTC, exchanges), names
 * carrying a whole word wrapped, staked or staking, and names that begin with an exchange's.
 * A wrapped or staked product of a token that already trades is not a token that does not
 * exist yet, whatever its TVL: WBTC is Bitcoin on Ethereum, not a launch waiting to happen.
 */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol is a wrapped, staked, bridged or exchange product of a traded asset. */
export function isProductOfTraded(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIX.test(p.name)) return true;
  return false;
}

/** Whether a protocol is one the board may rank: pre-token, and not a product of a traded asset. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isProductOfTraded(p) && !VERSIONED.test(p.name);
}

/** Why a protocol is not ranked, in the dashboard's accounting words. */
export function exclusionReason(p: SnapshotProtocol): string {
  if (!isPreToken(p)) return 'already records a token';
  if (p.category === 'CEX' || EXCHANGE_PREFIX.test(p.name)) return 'an exchange balance sheet or an exchange\'s own product, not a farmable launch';
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'a bridged product of assets that already trade';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') return 'a staking product of an asset that already trades';
  if (WRAPPED_WORD.test(p.name)) return 'a wrapped or staked product of a token that already trades';
  if (VERSIONED.test(p.name)) return 'a versioned pool of another protocol';
  return 'ranked';
}

/** One tokenised peer, reduced to the figures the fit reads. */
interface Peer {
  slug: string;
  category: string;
  logTvl: number;
  logRatio: number;
  growth: number;
  logAge: number;
}

/** A protocol's growth figure for the model: its 7-day change, clamped, 0 when unreported. */
function growthOf(p: SnapshotProtocol): number {
  return Math.min(GROWTH_MAX, Math.max(GROWTH_MIN, finite(p.change_7d, 0)));
}

/** A protocol's age feature: log10 of one plus its age in days; the peer median when unknown. */
function logAgeOf(age: number | null, medianAge: number): number {
  return Math.log10(1 + (age ?? medianAge));
}

/** The fitted pieces: category multiples in log10, the three slopes, and the peer medians. */
export interface Fit {
  globalLogRatio: number;
  categoryLogRatio: Map<string, number>;
  categoryPeers: Map<string, number>;
  sizeSlope: number;
  growthSlope: number;
  ageSlope: number;
  useSize: boolean;
  useGrowth: boolean;
  useAge: boolean;
  meanLogTvl: number;
  medianAgeDays: number;
  peerCount: number;
}

/** Category multiples: each group's median log ratio, shrunk toward the global median. */
function categoryMultiples(peers: Peer[]): { global: number; byCategory: Map<string, number>; counts: Map<string, number> } {
  const global = median(peers.map((p) => p.logRatio));
  const groups = new Map<string, number[]>();
  for (const p of peers) {
    const list = groups.get(p.category) ?? [];
    list.push(p.logRatio);
    groups.set(p.category, list);
  }
  const byCategory = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const [category, ratios] of groups) {
    const n = ratios.length;
    byCategory.set(category, (n * median(ratios) + SHRINK_K * global) / (n + SHRINK_K));
    counts.set(category, n);
  }
  return { global, byCategory, counts };
}

/** A least-squares slope of y on x through the means; 0 when x does not vary. */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) * (xs[i]! - mx);
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Fit the multiples and the chosen slopes on a peer list. Terms are fitted in order: category
 * multiples first, then the size slope (how the cap-to-TVL ratio moves with TVL itself) on their
 * residuals, then the growth slope, then the age slope on what is left.
 */
function fitOn(peers: Peer[], useSize: boolean, useGrowth: boolean, useAge: boolean): Fit {
  const { global, byCategory, counts } = categoryMultiples(peers);
  const mult = (p: Peer): number => byCategory.get(p.category) ?? global;
  const meanLogTvl = peers.reduce((a, p) => a + p.logTvl, 0) / Math.max(1, peers.length);
  let residuals = peers.map((p) => p.logRatio - mult(p));
  let sizeSlope = 0;
  if (useSize) {
    sizeSlope = slope(peers.map((p) => p.logTvl - meanLogTvl), residuals);
    residuals = residuals.map((r, i) => r - sizeSlope * (peers[i]!.logTvl - meanLogTvl));
  }
  let growthSlope = 0;
  if (useGrowth) {
    growthSlope = slope(peers.map((p) => p.growth), residuals);
    residuals = residuals.map((r, i) => r - growthSlope * peers[i]!.growth);
  }
  let ageSlope = 0;
  if (useAge) {
    ageSlope = slope(peers.map((p) => p.logAge), residuals);
    residuals = residuals.map((r, i) => r - ageSlope * peers[i]!.logAge);
  }
  const ages = peers.map((p) => Math.pow(10, p.logAge) - 1);
  return {
    globalLogRatio: global,
    categoryLogRatio: byCategory,
    categoryPeers: counts,
    sizeSlope,
    growthSlope,
    ageSlope,
    useSize,
    useGrowth,
    useAge,
    meanLogTvl,
    medianAgeDays: Math.round(median(ages)),
    peerCount: peers.length,
  };
}

/** A peer's predicted log10 market cap under a fit. */
function predictLog(fit: Fit, category: string, logTvl: number, growth: number, logAge: number): number {
  const mult = fit.categoryLogRatio.get(category) ?? fit.globalLogRatio;
  let out = logTvl + mult;
  if (fit.useSize) out += fit.sizeSlope * (logTvl - fit.meanLogTvl);
  if (fit.useGrowth) out += fit.growthSlope * growth;
  if (fit.useAge) out += fit.ageSlope * logAge;
  return out;
}

/** One candidate model's held-out record: every peer's absolute log10 error under cross-validation. */
export interface Validation {
  useSize: boolean;
  useGrowth: boolean;
  useAge: boolean;
  medianError: number;
  p80Error: number;
  errors: number[];
}

/** Five-fold cross-validation of one term choice over the peers, folds by slug order. */
function crossValidate(peers: Peer[], useSize: boolean, useGrowth: boolean, useAge: boolean): Validation {
  const sorted = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const errors: number[] = [];
  for (let fold = 0; fold < FOLDS; fold++) {
    const train = sorted.filter((_, i) => i % FOLDS !== fold);
    const test = sorted.filter((_, i) => i % FOLDS === fold);
    const fit = fitOn(train, useSize, useGrowth, useAge);
    for (const p of test) {
      const predicted = predictLog(fit, p.category, p.logTvl, p.growth, p.logAge);
      errors.push(Math.abs(predicted - (p.logTvl + p.logRatio)));
    }
  }
  return { useSize, useGrowth, useAge, medianError: median(errors), p80Error: percentile(errors, 0.8), errors };
}

/** The fitted model and everything the dashboard states about it. */
export interface ModelReport {
  version: string;
  peerCount: number;
  chosen: { useSize: boolean; useGrowth: boolean; useAge: boolean };
  validations: { terms: string; medianMultiple: number; p80Multiple: number }[];
  medianMultiple: number;
  bandMultiple: number;
  sizeSlope: number;
  growthSlope: number;
  ageSlope: number;
  globalMultiple: number;
  shrinkK: number;
}

/** The tokenised peers of the snapshot: a recorded, positive market cap over a positive TVL. */
function peersOf(snapshot: Snapshot): Peer[] {
  const ages = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null);
  const medianAge = ages.length > 0 ? median(ages) : 365;
  const peers: Peer[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    peers.push({
      slug: p.slug,
      category: p.category ?? 'Uncategorised',
      logTvl: Math.log10(p.tvl_usd),
      logRatio: Math.log10(p.mcap_usd / p.tvl_usd),
      growth: growthOf(p),
      logAge: logAgeOf(age, medianAge),
    });
  }
  return peers;
}

/** Fit the production model: validate all eight term choices, keep the best, refit on all peers. */
export function fitModel(snapshot: Snapshot): { fit: Fit; report: ModelReport } {
  const peers = peersOf(snapshot);
  const choices: { useSize: boolean; useGrowth: boolean; useAge: boolean }[] = [];
  for (const useSize of [false, true]) {
    for (const useGrowth of [false, true]) {
      for (const useAge of [false, true]) {
        choices.push({ useSize, useGrowth, useAge });
      }
    }
  }
  const validations = choices.map((c) => crossValidate(peers, c.useSize, c.useGrowth, c.useAge));
  let best = validations[0]!;
  for (const v of validations) {
    // A tie goes to the simpler model: fewer terms wins.
    const simpler = (x: Validation): number => (x.useSize ? 1 : 0) + (x.useGrowth ? 1 : 0) + (x.useAge ? 1 : 0);
    if (v.medianError < best.medianError - 1e-12 || (Math.abs(v.medianError - best.medianError) <= 1e-12 && simpler(v) < simpler(best))) {
      best = v;
    }
  }
  const fit = fitOn(peers, best.useSize, best.useGrowth, best.useAge);
  const termsName = (v: Validation): string => {
    const parts = ['category'];
    if (v.useSize) parts.push('size');
    if (v.useGrowth) parts.push('growth');
    if (v.useAge) parts.push('age');
    return parts.join(' + ');
  };
  const report: ModelReport = {
    version: MODEL_VERSION,
    peerCount: peers.length,
    chosen: { useSize: best.useSize, useGrowth: best.useGrowth, useAge: best.useAge },
    validations: validations.map((v) => ({
      terms: termsName(v),
      medianMultiple: round4(Math.pow(10, v.medianError)),
      p80Multiple: round4(Math.pow(10, v.p80Error)),
    })),
    medianMultiple: round4(Math.pow(10, best.medianError)),
    bandMultiple: round4(Math.pow(10, best.p80Error)),
    sizeSlope: round4(fit.sizeSlope),
    growthSlope: round4(fit.growthSlope),
    ageSlope: round4(fit.ageSlope),
    globalMultiple: round4(Math.pow(10, fit.globalLogRatio)),
    shrinkK: SHRINK_K,
  };
  return { fit, report };
}

/** The launch record of a category: its tokenised share of all its protocols, shrunk to the field's. */
export function categoryOdds(snapshot: Snapshot): Map<string, { odds: number; tokenised: number; total: number }> {
  const counts = new Map<string, { tokenised: number; total: number }>();
  let allTokenised = 0;
  for (const p of snapshot.protocols) {
    const category = p.category ?? 'Uncategorised';
    const entry = counts.get(category) ?? { tokenised: 0, total: 0 };
    entry.total += 1;
    if (!isPreToken(p)) {
      entry.tokenised += 1;
      allTokenised += 1;
    }
    counts.set(category, entry);
  }
  const global = allTokenised / Math.max(1, snapshot.protocols.length);
  const out = new Map<string, { odds: number; tokenised: number; total: number }>();
  for (const [category, entry] of counts) {
    const odds = (entry.tokenised + SHRINK_K * global) / (entry.total + SHRINK_K);
    out.set(category, { odds: round4(odds), tokenised: entry.tokenised, total: entry.total });
  }
  return out;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  model: {
    category_multiple: number;
    category_peers: number;
    size_slope: number;
    growth_slope: number;
    age_slope: number;
  };
  peer_odds: number;
  farm_steps: string[];
  farm: {
    capital_usd: number;
    spend_usd: number;
    hours: number;
    verdict: string;
  };
}

/** Gas per on-chain action in dollars, by the chain a position lives on: the plan's own estimates. */
const GAS_BY_CHAIN: [string, number][] = [
  ['Ethereum', 14],
  ['Solana', 0.6],
  ['Base', 0.8],
  ['Arbitrum', 0.8],
  ['Optimism', 0.8],
  ['BSC', 0.6],
  ['Polygon', 0.5],
  ['Avalanche', 1.2],
  ['Linea', 0.8],
  ['Scroll', 0.8],
  ['zkSync Era', 0.8],
];

/** The gas estimate for a protocol's first chain; chains the table does not name cost $2.50. */
function gasFor(p: SnapshotProtocol): number {
  const first = p.chains[0];
  if (first === undefined) return 2.5;
  for (const [chain, gas] of GAS_BY_CHAIN) if (chain === first) return gas;
  return 2.5;
}

/** How much capital one farm position puts to work, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 10_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's main action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Supply $${capital} of USDC to ${name} on ${chain} so the wallet carries a live lending position`;
  if (c.includes('dex')) return `Provide $${capital} split between USDC and the chain's gas asset in ${name}'s main pool on ${chain}`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then put the bridged funds to work in one app there`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the wallet`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into one of ${name}'s curated vaults on ${chain} and keep the vault shares`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield asset on ${chain} through its own app and hold it in the wallet`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the shares`;
  if (c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and keep the vault shares`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and take one position in its most liquid market`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy NFT in the wallet`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} through its own app and keep the position open`;
}

/** The category's second action: the step that makes the wallet look like a user, not a deposit. */
function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Borrow a small amount against the position on ${name} and repay it a week later, so the wallet shows both sides of the market`;
  if (c.includes('dex')) return `Make two small swaps through ${name} on ${chain} on different days, so the wallet's activity is not a single deposit`;
  if (c.includes('bridge')) return `Bridge a small amount back through ${name} after two weeks, leaving the rest working on ${chain}`;
  if (c.includes('staking') || c.includes('restak')) return `Claim any staking rewards ${name} shows and restake them once, so the position compounds on the record`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Close the hedge on ${name} after two weeks and open a fresh one, so the wallet shows repeat trading activity`;
  if (c.includes('prediction')) return `Settle the first position on ${name} when its market resolves and take one more in a different market`;
  return `Repeat ${name}'s core action once more with a small amount on ${chain}, so the wallet shows a returning user, not a one-off`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text}. Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** A protocol's farm plan: six costed steps and the plan's own totals. */
export function farmPlan(p: SnapshotProtocol, age: number | null): { steps: FarmStep[]; capital: number; spend: number; hours: number } {
  const chain = chainOf(p);
  const gas = gasFor(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(2, Math.round(hold / 7));
  const gasText = gas < 1 ? `about $${gas.toFixed(2)}` : `about $${Math.round(gas)}`;
  const steps: FarmStep[] = [
    {
      text: `Set up a fresh wallet that holds only the funds this farm uses, with its seed phrase written offline`,
      cost: `${gasText} of gas for its first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital at work and ${gasText} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, chain),
      cost: `${gasText} of gas`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action on ${p.name} every week (a deposit, a swap, a claim or a vote), on a weekday rather than in one burst`,
      cost: `${gasText} of gas a week`,
      time: `10 minutes a week for ${weeks} weeks`,
    },
    {
      text: `Hold the position for at least ${hold} days, so the activity stands in more than one weekly snapshot of the protocol`,
      cost: `the $${capital} stays in the position; nothing is spent`,
      time: `${hold} days`,
    },
    {
      text: `Before withdrawing, open ${p.name}'s own points or rewards page and follow only the claim link it publishes; then log the wallet, dates and transactions in a farm log`,
      cost: 'nothing to check, and never pay anyone to claim',
      time: '10 minutes',
    },
  ];
  const spend = Math.round((gas * (2 + weeks) + gas) * 100) / 100;
  const hours = Math.round(((5 + 15 + 10 + 10 + weeks * 10) / 60) * 10) / 10;
  return { steps, capital, spend, hours };
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
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  category_multiple: number;
  peer_odds: number;
  verdict: string;
  capital_usd: number;
  spend_usd: number;
  hours: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number | null;
  ratio: number | null;
}

/** A protocol the board does not rank, with the reason, for the accounting view. */
export interface ExcludedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelReport;
  counts: {
    protocols: number;
    tokenised: number;
    preToken: number;
    ranked: number;
    watchlist: number;
    excluded: number;
  };
  rows: RadarRow[];
  live: LiveRow[];
  excluded: ExcludedRow[];
}

/** Score every rankable pre-token protocol and build the board, the dashboard data and the report. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { fit, report } = fitModel(snapshot);
  const odds = categoryOdds(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const band = report.bandMultiple;

  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => {
      const age = ageDays(snapshot.as_of, p.listed_at);
      const category = p.category ?? 'Uncategorised';
      const logAge = logAgeOf(age, fit.medianAgeDays);
      const logImp = predictLog(fit, category, Math.log10(Math.max(1, p.tvl_usd)), growthOf(p), logAge);
      const implied = Math.max(1, Math.round(Math.pow(10, logImp)));
      const plan = farmPlan(p, age);
      const peerOdds = odds.get(category)?.odds ?? 0;
      return { p, age, category, implied, plan, peerOdds };
    });

  // The farm verdict prices a row: record-weighted implied value per dollar the plan spends.
  const efficiencies = scored.map((s) => (s.implied * s.peerOdds) / Math.max(1, s.plan.spend)).sort((a, b) => a - b);
  const p50 = percentile(efficiencies, 0.5);
  const p85 = percentile(efficiencies, 0.85);
  const verdictOf = (s: (typeof scored)[number]): string => {
    const eff = (s.implied * s.peerOdds) / Math.max(1, s.plan.spend);
    return eff >= p85 ? 'Farm first' : eff >= p50 ? 'Farm' : 'Watch';
  };

  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    implied_low_usd: Math.max(1, Math.round(s.implied / band)),
    implied_high_usd: Math.round(s.implied * band),
    model: {
      category_multiple: round4(Math.pow(10, fit.categoryLogRatio.get(s.category) ?? fit.globalLogRatio)),
      category_peers: fit.categoryPeers.get(s.category) ?? 0,
      size_slope: fit.sizeSlope,
      growth_slope: fit.growthSlope,
      age_slope: fit.ageSlope,
    },
    peer_odds: s.peerOdds,
    farm_steps: s.plan.steps.map(stepText),
    farm: {
      capital_usd: s.plan.capital,
      spend_usd: s.plan.spend,
      hours: s.plan.hours,
      verdict: verdictOf(s),
    },
  }));

  const rows: RadarRow[] = board.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    age_days: r.age_days,
    watchlist: watchlist.has(r.slug),
    implied_value_usd: r.implied_value_usd,
    implied_low_usd: r.implied_low_usd,
    implied_high_usd: r.implied_high_usd,
    category_multiple: r.model.category_multiple,
    peer_odds: r.peer_odds,
    verdict: r.farm.verdict,
    capital_usd: r.farm.capital_usd,
    spend_usd: r.farm.spend_usd,
    hours: r.farm.hours,
    farm_steps: r.farm_steps,
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : 1))
    .slice(0, 40)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));

  const excluded: ExcludedRow[] = snapshot.protocols
    .filter((p) => !isRankable(p) && isPreToken(p))
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: exclusionReason(p) }));

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: report,
    counts: {
      protocols: snapshot.protocols.length,
      tokenised: snapshot.protocols.filter((p) => !isPreToken(p)).length,
      preToken: snapshot.protocols.filter(isPreToken).length,
      ranked: board.length,
      watchlist: snapshot.watchlist.length,
      excluded: excluded.length,
    },
    rows,
    live,
    excluded,
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
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
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
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  if (board.length < 100) return `the board holds ${board.length} rows, under the gate's 100`;
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
