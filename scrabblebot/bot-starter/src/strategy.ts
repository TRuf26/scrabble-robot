// "Witchcraft" strategy for ScrabbleBot.
//
// What the rules actually reward (read from the module source):
//   * Your rank is your SCORE, which only goes up when you play words.
//     Coins left at the end are worth nothing, and so are tiles left in
//     your rack when the bag runs out.
//   * A word pays (sum of letter values) x length multiplier, topping out
//     at 3x for 7+ letters. So every tile we can get into a 7+ word is worth
//     3x its face value, both as score and as coins to spend again.
//   * Lobby matches are Vickrey (the winner pays the second-highest bid),
//     so bidding what a letter is truly worth to us is the right move.
//   * The built-in sims bid by a public formula, and every balance is
//     public. So for any letter we know a bid *floor* that some sim is
//     guaranteed to beat us with.
//
// The tricks:
//   1. Value each letter by how much it raises our rack's expected final
//      score (the chance of completing near-miss 7+ words from what's
//      left in the bag, minus what those tiles will cost).
//   2. Hoard toward 7+ words, play them the moment they're complete, and
//      dump everything into the best set of words before the last
//      auction closes.
//   3. Risk-free price pushing: when we don't want a letter, bid just under
//      the lowest bid some sim is guaranteed to make. We can never win it,
//      but the winner pays our bid. That drains rivals' coins at no cost.
//   4. Denial: bid for letters that complete words a rival is visibly
//      collecting for (we can see what they won minus what they played).
//   5. First-price matches: bid just above the highest bid the field can
//      plausibly make, never our full value.
//   6. Spend coins faster as the game ends, since leftover coins are worth
//      nothing.

import {
  type Counts,
  LETTER_VALUE,
  type Lexicon,
  VALUE_BY_CODE,
  countsFromMap,
  keyOf,
  lexiconFor,
  total,
} from "./lexicon.js";

export { LETTER_VALUE } from "./lexicon.js";

export type SimKind = "Cheapskate" | "ValueBidder" | "Aggressive" | "Human";

export interface Opponent {
  botId: string;
  balance: number;
  score: number;
  // Set for the module's simulated bots, whose bidding formula is known.
  sim?: SimKind;
  // Tiles we know they hold: letters they won at auction minus letters
  // they've played. (Their 5 starting tiles stay hidden.)
  knownRack?: Map<string, number>;
  // For real bots: learned from past matches, their bid is about
  // face value + offset, give or take spread.
  bidModel?: { offset: number; spread: number };
}

export interface GameInfo {
  // Auctions still to open after the current one (the match's bagTotal).
  // 0 means the current auction is the last.
  auctionsLeft: number;
  auctionType: "Vickrey" | "FirstPrice";
  // Letters we haven't seen yet: still in the bag or hidden in rivals'
  // starting racks.
  unseen: Map<string, number>;
  opponents: Opponent[];
  myScore: number;
  // Coins paid in this match's closed auctions, oldest first (the PAID
  // column; in Vickrey that's the second-highest bid). Used to learn what
  // tiles actually cost in this lobby. Empty/undefined early is fine.
  recentPaid?: number[];
}

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  dictionary?: string[];
  game?: GameInfo;
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  myBalance?: number;
  game?: GameInfo;
}

// Knobs, exported so the offline simulator can tune them.
export const TUNING = {
  // Chance we win a letter we go after, against sims only / per real rival.
  winVsSims: 0.9,
  winDecayPerReal: 0.85,
  minWin: 0.3,
  // How far ahead (in missing tiles) we plan target words.
  maxMissingEarly: 3,
  maxMissingMid: 2,
  maxMissingLate: 1,
  targetMinLen: 4,
  topTargets: 10,
  costWeight: 1.0,
  // Weight of the "flexible rack" bonus.
  flexWeight: 3,
  // Coins kept per remaining auction before we bid at full value.
  reservePerAuction: 0.8,
  alphaMin: 1.6,
  alphaMax: 4,
  // Denial bidding against visible hoarders.
  denial: 0.45,
  // Price pushing against sims (Vickrey only, risk-free).
  pricePush: true,
  // Word timing.
  playSlack: 0.5,
  lowBalance: 15,
  coinNowBonus: 0.25,
  // Count the chance that one more tile upgrades the best play when
  // valuing a rack. Fixes the OWING-type spot, but over 40 simulated
  // matches it was noise (+1.1 ± 6.9) and ~5x slower, so it's off.
  upgradeValue: false,
  // Coins are worth less as the match ends: weight 1 early, coinWeightMin
  // at the end.
  coinDecay: false,
  coinWeightMin: 0.3,
  // If we can't afford the cheapest tile (balance < brokeFrac x its price),
  // play the best word we have instead of sitting on it.
  brokePlay: true,
  brokeFrac: 1.0,
  // Count the rack-health bonus when deciding whether to play a word.
  // Turning it off cost ~20 points/game in the simulator (10 games), so on.
  flexInPlay: true,
  // Play any ready 7+ letter word right away (it's already at 3x). Would
  // have played ZEMINDARY 50 auctions earlier in 46978; simulator says
  // -4.6/game over 10 games (noisy), so off until tested in real matches.
  playLongNow: false,
  // Which price counts as "can't afford": the cheapest unseen tile, the
  // average unseen tile, or the most expensive unseen tile (e.g. a Z).
  brokeRef: "cheapest" as "cheapest" | "average" | "dearest",
  // Hold words shorter than holdShortLen while more than holdShortLeft
  // usable auctions remain, unless we're broke (0 = off). Match 46368:
  // OWING (18) with 20 left, when almost any of T/R/D/O/E made a 6-letter
  // word for 25+. Simulated, 40 matches vs v8: +4.0 ± 3.3 points.
  holdShortLen: 6,
  holdShortLeft: 5,
  // Market price learning: how many recent auctions to average, the guess
  // before any have closed, and how far above the average a real bot may go.
  marketWindow: 15,
  // Lobby tiles have cleared around 8-12 coins (matches 45216, 45271).
  marketPrior: 10,
  marketHiMult: 1.8,
  // Budget pacing: once a letter is worth at least this much to us, bid at
  // least min(pace, market + 1) so coins don't pile up unused.
  paceMinDelta: 0.5,
  // The pacing floor is scaled by delta / paceFullDelta (capped at 1), so a
  // barely useful letter gets a small bid, not the full going price.
  paceFullDelta: 4,
  // Endgame spend-down: over the last spendDownAuctions auctions, bid at
  // least max(market + 1, spendDownMult * balance / auctions left).
  spendDownAuctions: 10,
  spendDownMult: 2,
  // Rack turnover. Once we hold playAtRack+ tiles, play the best word of
  // playMinLen+ letters right away instead of saving for a 7+ bingo.
  // Real multipliers seen in matches: 2-3 letters 1x, 5 letters 2x,
  // 6 letters ~2.5x, 7+ letters 3x. Cashing in at 5 tiles (ROSET for 10)
  // gave up most of that. With 7 tiles there's often no 7-letter word, so
  // let the rack reach 10: plenty of 7+ options, and 3 tiles left over to
  // build the next one. Simulated over 60 matches: rack 7 → 62.9 avg,
  // rack 10 → 83.5. Going past 10 didn't help.
  playAtRack: 10,
  playMinLen: 5,
  // Keep buying at the going rate while the rack has fewer tiles than this.
  rackRefill: 7,
  // Never assume tiles are cheaper than this when learning prices ourselves.
  marketFloor: 7,
  // Price each letter by what it usually sells for (a Z ~2.5x an average
  // tile) instead of one going price for everything, which capped bids on
  // big letters far below what they sell for.
  perLetterPrice: true,
  // Don't treat J, K, V, W, X, Z as awkward-rack liabilities (Q still is).
  softBigFlex: true,
  // Extra value for high-point letters: a letter worth v points gets its
  // value scaled by 1 + bigLetterBoost * (v - 1) / 9 (so a Z gets the full
  // boost, an E none). 0 = off. Simulated, 10 games vs v9: +7.6/game.
  bigLetterBoost: 1.2,
  // Prefer plays that leave at least this many tiles to build on; plays
  // that leave fewer cost this many points in the comparison.
  keepAfterPlay: 2,
  emptyRackPenalty: 4,
  // Bidding: past this rack size, extra tiles are worth less to us
  // (each tile over the cap cuts a letter's value by rackOverCut).
  // (At 7 this was the real limiter: it cut bids before the rack was big
  // enough to hold a 7-letter word plus spares.)
  rackSoftCap: 10,
  rackOverCut: 0.25,
  // Vowel balance (Y counts half): no penalty while the vowel count is
  // within 1 + vowelTol * rackSize tiles of vowelTarget * rackSize.
  vowelTarget: 0.4,
  vowelTol: 0.1,
  vowelPenalty: 2,
  // Words pay coins back, so we can spend more than our current balance over
  // the rest of the match. 1.5 ≈ "expect to earn another half of it back".
  paceBudgetMult: 1.5,
  // Log auctionsLeft etc. to check the last-auction off-by-one.
  debug: false,
};

// Self-learned prices, for when the caller doesn't fill game.recentPaid.
// Between calls to decideBid we can tell how the previous auction went from
// our own balance: if it dropped, we won and paid the drop; if it didn't and
// we had bid, we lost, so the price was above our bid.
// (A word played in between adds coins and can hide a win; that only makes
// the estimate a little high, which is the safe side.)
const tracker = {
  lastBid: 0,
  lastLetter: "",
  lastBalance: -1,
  lastAuctionsLeft: -1,
  seen: [] as number[],
  noted: [] as number[], // real prices passed in via notePaid()
  byLetter: {} as Record<string, number[]>, // same, per letter
};

// What each letter sold for relative to the average tile, from 2,229
// lobby auctions in your log (average 12.6 coins). Big letters cost more
// but far less per point: an E ran ~11 coins per point, a Z ~3.
const PRICE_RATIO: Record<string, number> = {
  A: 0.86, B: 1.17, C: 1.25, D: 1.0, E: 0.9, F: 1.36, G: 0.98, H: 1.57,
  I: 0.82, J: 1.83, K: 1.5, L: 0.85, M: 1.2, N: 0.85, O: 0.79, P: 1.17,
  Q: 1.7, R: 0.87, S: 1.0, T: 0.76, U: 0.83, V: 1.18, W: 1.25, X: 2.14,
  Y: 1.46, Z: 2.55,
};

// Going price for one letter: the match's overall level times that
// letter's usual ratio, blended with what that letter has actually sold
// for this match (when the caller reports it via notePaid(paid, letter)).
function letterPrice(game: GameInfo, letter: string): number {
  const overall = marketPrice(game);
  const prior = TUNING.perLetterPrice ? overall * (PRICE_RATIO[letter] ?? 1) : overall;
  const obs = TUNING.perLetterPrice ? (tracker.byLetter[letter] ?? []).slice(-6) : [];
  const k = 3; // the prior counts like 3 observations
  return (obs.reduce((a, b) => a + b, 0) + k * prior) / (obs.length + k);
}

export function resetStrategyState() {
  tracker.lastBid = 0;
  tracker.lastLetter = "";
  tracker.lastBalance = -1;
  tracker.lastAuctionsLeft = -1;
  tracker.seen = [];
  tracker.noted = [];
  tracker.byLetter = {};
}

function observe(game: GameInfo, balance: number) {
  const prevLeft = tracker.lastAuctionsLeft;
  // Auctions-left went up: a new match started.
  if (prevLeft >= 0 && game.auctionsLeft > prevLeft) resetStrategyState();
  // Same auction asked about twice: nothing new to learn.
  if (prevLeft >= 0 && game.auctionsLeft === prevLeft) return;
  if (tracker.lastBid > 0 && tracker.lastBalance >= 0) {
    const drop = tracker.lastBalance - balance;
    // Store prices in "average-tile" terms, so buying one Z for 32 doesn't
    // make every E look like it costs 32.
    const ratio = TUNING.perLetterPrice ? (PRICE_RATIO[tracker.lastLetter] ?? 1) : 1;
    if (drop > 0) {
      tracker.seen.push(drop / ratio); // we won and paid this
    } else {
      // We lost, so the price was above our bid. That's only a lower bound:
      // it may raise the estimate but must never lower it. (Before, a lost
      // bid of 2 was logged as "price 3", which dragged the estimate down
      // and made the next bids even lower: matches 45531/45539.)
      const est = selfEstimate();
      const lb = (tracker.lastBid + 1) / ratio;
      if (lb > est) tracker.seen.push(lb);
    }
  }
}

function avg(xs: number[]): number {
  const r = xs.slice(-TUNING.marketWindow);
  return r.length ? r.reduce((a, b) => a + b, 0) / r.length : TUNING.marketPrior;
}
function selfEstimate(): number {
  return tracker.noted.length ? avg(tracker.noted) : avg(tracker.seen);
}

// Call this from your main loop for every closed auction (where it logs
// "auction ... → bot N paid P") so the strategy sees real prices:
//   notePaid(paid);
// It's the most accurate source; the balance-based guess is a fallback.
export function notePaid(paid: number, letter?: string) {
  if (paid <= 0) return;
  const L = letter?.toUpperCase() ?? "";
  const ratio = L && TUNING.perLetterPrice ? (PRICE_RATIO[L] ?? 1) : 1;
  tracker.noted.push(paid / ratio);
  if (L) (tracker.byLetter[L] ??= []).push(paid);
}

function record(game: GameInfo, balance: number, bid: number, letter: string) {
  tracker.lastBid = bid;
  tracker.lastLetter = letter;
  tracker.lastBalance = balance;
  tracker.lastAuctionsLeft = game.auctionsLeft;
}

// Typical clearing price in this match so far. Uses the caller's full
// auction history if given, else what we've learned from our own bids.
function marketPrice(game: GameInfo): number {
  const given = (game.recentPaid ?? []).filter((x) => x > 0);
  if (given.length) return avg(given);
  // Never assume tiles are cheaper than the prior from what we've seen;
  // lobby prices have run 8-15 in every match so far.
  return Math.max(TUNING.marketFloor, selfEstimate());
}

const STANDARD_BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
  Y: 2, Z: 1,
};

// Used when the caller passes no game info (e.g. unit tests).
function defaultGame(): GameInfo {
  return {
    auctionsLeft: 40,
    auctionType: "Vickrey",
    unseen: new Map(Object.entries(STANDARD_BAG)),
    opponents: [],
    myScore: 0,
  };
}

let defaultLexicon: Lexicon | null = null;
export function initStrategy(dictionary: string[]) {
  defaultLexicon = lexiconFor(dictionary);
}
function lex(dictionary?: string[]): Lexicon {
  if (dictionary && dictionary.length) return lexiconFor(dictionary);
  if (!defaultLexicon) throw new Error("call initStrategy(dictionary) first");
  return defaultLexicon;
}

// ---------- How rivals bid ----------

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

// The sims' exact rule, from the module: base + jitter in [-2, 2], at least
// 1, at most their balance.
function simBase(kind: SimKind, letter: string): number | null {
  const v = LETTER_VALUE[letter] ?? 1;
  switch (kind) {
    case "Human":
      return null;
    case "Cheapskate":
      return v - 1;
    case "ValueBidder":
      return v;
    case "Aggressive":
      return v + (VOWELS.has(letter) ? 4 : 2);
  }
}

interface BidRange {
  lo: number; // they will bid at least this
  mid: number; // typical bid
  hi: number; // they won't bid above this
}

function rivalRange(o: Opponent, letter: string, market: number): BidRange {
  const cap = (x: number) => Math.max(0, Math.min(x, o.balance));
  if (o.sim) {
    const base = simBase(o.sim, letter);
    if (base === null) return { lo: 0, mid: 0, hi: 0 };
    return {
      lo: cap(Math.max(base - 2, 1)),
      mid: cap(Math.max(base, 1)),
      hi: cap(Math.max(base + 2, 1)),
    };
  }
  const v = LETTER_VALUE[letter] ?? 1;
  if (o.bidModel) {
    const mid = v + o.bidModel.offset;
    return {
      lo: 0, // a real bot can always skip; never treat it as a floor
      mid: cap(Math.max(mid, 0)),
      hi: cap(Math.max(mid + o.bidModel.spread, 1)),
    };
  }
  // A real bot we know nothing about yet: assume it bids what tiles have
  // been going for in this match (never below a bit over face value).
  const mid = Math.max(market, v + 2);
  return { lo: 0, mid: cap(mid), hi: cap(Math.max(mid * TUNING.marketHiMult, v * 2 + 6)) };
}

// ---------- Valuation ----------

// Leftover-tile flexibility, in points. Common, combinable letters keep
// many future words open; duplicates, Q without U, and lopsided
// vowel/consonant mixes close them.
const FLEX: Record<string, number> = {
  A: 1.0, B: 0.2, C: 0.4, D: 0.6, E: 1.4, F: 0.0, G: 0.3, H: 0.4, I: 0.8,
  J: -0.5, K: -0.2, L: 0.7, M: 0.4, N: 0.9, O: 0.7, P: 0.3, Q: -3.0, R: 1.2,
  S: 1.6, T: 1.1, U: 0.0, V: -0.8, W: -0.4, X: 0.3, Y: 0.2, Z: -0.2,
};
// Softer version for the big letters. The originals treated J, K, Z, V
// and W as liabilities, but those are the cheapest points in the game
// (~3-4 coins per face point vs ~11 for an E) and the winners' best words
// are built on them. Q stays a real liability.
const FLEX_SOFT: Record<string, number> = {
  ...FLEX, J: 0.0, K: 0.2, V: -0.3, W: 0.0, X: 0.4, Z: 0.2,
};
const FLEX_BY_CODE = Array.from(
  { length: 26 },
  (_, i) => FLEX[String.fromCharCode(65 + i)] ?? 0,
);
const FLEX_SOFT_BY_CODE = Array.from(
  { length: 26 },
  (_, i) => FLEX_SOFT[String.fromCharCode(65 + i)] ?? 0,
);
const VOWEL_CODES = [0, 4, 8, 14, 20];

function flex(r: Counts): number {
  let s = 0;
  let n = 0;
  let vowels = 0;
  for (let b = 0; b < 26; b++) {
    const c = r[b]!;
    if (!c) continue;
    n += c;
    s += (TUNING.softBigFlex ? FLEX_SOFT_BY_CODE : FLEX_BY_CODE)[b]!;
    const free = b === 4 ? 2 : 1; // a second E is fine
    if (c > free) s -= (c - free) * 1.0;
  }
  for (const v of VOWEL_CODES) vowels += r[v]!;
  vowels += 0.5 * r[24]!; // Y works as a vowel about half the time
  if (n >= 1) {
    // Aim for ~40% vowels, measured in tiles, with a tolerance that grows
    // with the rack. Smooth at every rack size: the old version only kicked
    // in at 3 tiles, so from a 2-tile rack *every* letter looked bad and the
    // bot bid 0 for 50 auctions straight (same stall as matches 45531/45539).
    const t = TUNING;
    const dev = Math.abs(vowels - t.vowelTarget * n);
    const gap = Math.max(0, dev - (1 + t.vowelTol * n));
    if (gap > 0) s -= t.vowelPenalty * (gap + 0.5 * gap * gap);
  }
  if (r[16]! > 0 && r[20]! === 0) s -= 2; // Q, no U
  return s;
}

function poissonTail(lambda: number, k: number): number {
  // P(X >= k), X ~ Poisson(lambda)
  if (k <= 0) return 1;
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let i = 1; i < k; i++) {
    term *= lambda / i;
    cdf += term;
  }
  return Math.max(0, 1 - cdf);
}

class Evaluator {
  readonly lx: Lexicon;
  readonly game: GameInfo;
  readonly nUsable: number;
  readonly maxMissing: number;
  readonly tau: number;
  readonly lambda = new Float64Array(26);
  readonly price = new Float64Array(26);
  // How much a coin is worth in points: 1 early, falling toward
  // coinWeightMin as the match ends (leftover coins are worth nothing).
  readonly coinWeight: number;
  private memo = new Map<string, number>();

  constructor(lx: Lexicon, game: GameInfo) {
    this.lx = lx;
    this.game = game;
    // A letter from the very last auction lands after the match ends, so
    // only the auctions before it can complete a word.
    this.nUsable = Math.max(0, game.auctionsLeft - 1);
    const t = TUNING;
    this.maxMissing =
      this.nUsable >= 30
        ? t.maxMissingEarly
        : this.nUsable >= 10
          ? t.maxMissingMid
          : this.nUsable >= 1
            ? t.maxMissingLate
            : 0;
    this.tau = Math.min(1, this.nUsable / 40);
    this.coinWeight = TUNING.coinDecay
      ? TUNING.coinWeightMin + (1 - TUNING.coinWeightMin) * this.tau
      : 1;

    const nReal = game.opponents.filter((o) => !o.sim).length;
    const win = Math.max(
      t.minWin,
      t.winVsSims * Math.pow(t.winDecayPerReal, nReal),
    );
    let unseenTotal = 0;
    for (const v of game.unseen.values()) unseenTotal += Math.max(0, v);
    for (let b = 0; b < 26; b++) {
      const letter = String.fromCharCode(65 + b);
      const u = Math.max(0, game.unseen.get(letter) ?? 0);
      this.lambda[b] =
        unseenTotal > 0 ? (this.nUsable * u * win) / unseenTotal : 0;
      // In Vickrey we pay the highest rival bid; in first price we pay a
      // little over it.
      let mx = 0;
      const lp = letterPrice(game, letter);
      for (const o of game.opponents) mx = Math.max(mx, rivalRange(o, letter, lp).mid);
      if (game.opponents.length === 0) mx = (LETTER_VALUE[letter] ?? 1) + 1;
      this.price[b] = mx + (game.auctionType === "FirstPrice" ? 1 : 0);
    }
  }

  // Expected final points from holding rack `r` now.
  phi(r: Counts): number {
    const key = keyOf(r);
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const lx = this.lx;
    const dump = lx.bestDump(r).value;
    let best = dump;

    if (this.maxMissing > 0 && total(r) > 0) {
      const K = TUNING.topTargets;
      const topI: number[] = [];
      const topV: number[] = [];
      const lambda = this.lambda;
      const price = this.price;
      const cw = TUNING.costWeight * this.coinWeight;
      lx.nearMiss(r, this.maxMissing, TUNING.targetMinLen, (i, missing, nMiss) => {
        if (nMiss === 0) return; // already counted by the dump
        let p = 1;
        let cost = 0;
        for (let b = 0; b < 26; b++) {
          const k = missing[b]!;
          if (!k) continue;
          p *= poissonTail(lambda[b]!, k);
          cost += k * price[b]!;
          if (p < 1e-4) return;
        }
        const v = p * (lx.rewards[i]! - cw * cost);
        if (v <= 0) return;
        if (topV.length < K) {
          topI.push(i);
          topV.push(v);
        } else {
          let mi = 0;
          for (let j = 1; j < K; j++) if (topV[j]! < topV[mi]!) mi = j;
          if (v > topV[mi]!) {
            topV[mi] = v;
            topI[mi] = i;
          }
        }
      });
      for (let j = 0; j < topI.length; j++) {
        const rest = lx.without(r, topI[j]!);
        const v = topV[j]! + lx.bestDump(rest).value;
        if (v > best) best = v;
      }
    }

    // Upgrade value: the chance that one more tile turns what we can play
    // now into something better (OWING + T/R/D/O/E -> a 6-letter word at
    // 2.5x). The target search above can't see this: it scores each target
    // word alone and keeps the single best, so many small, likely upgrades
    // added up to nothing and holding looked no better than playing now.
    if (TUNING.upgradeValue && this.nUsable >= 1 && total(r) >= 2) {
      const cw = TUNING.costWeight * this.coinWeight;
      const ups: [number, number][] = [];
      const rp = new Int32Array(r);
      for (let b = 0; b < 26; b++) {
        if (this.lambda[b]! <= 0) continue;
        rp[b]!++;
        const g = lx.bestDump(rp).value - dump - cw * this.price[b]!;
        rp[b]!--;
        if (g > 0) ups.push([g, poissonTail(this.lambda[b]!, 1)]);
      }
      ups.sort((a, b) => b[0] - a[0]);
      // Expected gain from the best upgrade we actually get.
      let miss = 1;
      let up = 0;
      for (const [g, pr] of ups) {
        up += miss * pr * g;
        miss *= 1 - pr;
      }
      if (dump + up > best) best = dump + up;
    }

    const value = best + this.tau * TUNING.flexWeight * flex(r);
    this.memo.set(key, value);
    return value;
  }

  // A rival's gain from `letter`, judged only from tiles we can see them
  // holding: how close it brings them to a 5+ letter word.
  rivalGain(known: Counts, letterCode: number): number {
    const lx = this.lx;
    const score = (r: Counts) => {
      let best = 0;
      lx.nearMiss(r, 1, 5, (i, missing, nMiss) => {
        let p = 1;
        if (nMiss) {
          for (let b = 0; b < 26; b++) {
            if (missing[b]) p *= poissonTail(this.lambda[b]! * 0.6, missing[b]!);
          }
        }
        const v = p * lx.rewards[i]!;
        if (v > best) best = v;
      });
      return best;
    };
    const plus = new Int32Array(known);
    plus[letterCode]++;
    return Math.max(0, score(plus) - score(known));
  }
}

// ---------- Bidding ----------

export function decideBid(ctx: BidContext): number {
  const game = ctx.game ?? defaultGame();
  const balance = Math.max(0, Math.floor(ctx.myBalance));
  observe(game, balance);
  const bid = decideBidInner(ctx, game, balance);
  record(game, balance, bid, ctx.letter.toUpperCase());
  return bid;
}

function decideBidInner(ctx: BidContext, game: GameInfo, balance: number): number {
  const letter = ctx.letter.toUpperCase();
  const code = letter.charCodeAt(0) - 65;
  if (code < 0 || code > 25 || balance <= 0) return 0;
  const lx = lex(ctx.dictionary);
  const ev = new Evaluator(lx, game);
  const market = letterPrice(game, letter);
  if (TUNING.debug) {
    console.debug(
      `[bid] ${letter} auctionsLeft=${game.auctionsLeft} nUsable=${ev.nUsable} balance=${balance} market=${market.toFixed(1)} learned=${tracker.seen.length} given=${game.recentPaid?.length ?? 0}`,
    );
  }

  // Lowest bid some sim is guaranteed to make on this letter.
  let floor = 0;
  let rivalHi = 0;
  let rivalMid = 0;
  for (const o of game.opponents) {
    const rr = rivalRange(o, letter, market);
    floor = Math.max(floor, rr.lo);
    rivalHi = Math.max(rivalHi, rr.hi);
    rivalMid = Math.max(rivalMid, rr.mid);
  }
  const pushBid = () =>
    TUNING.pricePush && game.auctionType === "Vickrey" && floor - 1 >= 1
      ? Math.min(balance, floor - 1)
      : 0;

  // Last auction ("0 left"): the tile arrives after the match ends. Your log
  // confirms it: the M in 45531 and the S in 45539 were won at 0 left and
  // never played, while the J won at 1 left became JEU. Nobody can use this
  // tile, so just make the winner pay.
  if (game.auctionsLeft <= 0) return pushBid();

  const r = countsFromMap(ctx.myRack);
  const rPlus = new Int32Array(r);
  rPlus[code]++;
  let delta = ev.phi(rPlus) - ev.phi(r);
  // Value high-point letters more. In ~2,000 lobby matches the top 12 bots
  // bought 3.6 letters worth 3+ points per match; Binter v9 bought 1.9,
  // and overpaid for 1-pointers instead (12.3 coins vs a 10.7 market).
  // Their 7+ words averaged 47.7 points vs Binter's 39.6.
  const face = LETTER_VALUE[letter] ?? 1;
  if (delta > 0 && TUNING.bigLetterBoost > 0) delta *= 1 + (TUNING.bigLetterBoost * (face - 1)) / 9;
  // Don't let the rack balloon: tiles past the soft cap are worth less,
  // since we'd rather be playing words than collecting more letters.
  const over = total(r) + 1 - TUNING.rackSoftCap;
  if (over > 0 && delta > 0) delta *= Math.max(0, 1 - TUNING.rackOverCut * over);

  // Liquidity: coins are worthless at the end, so the closer we get, the
  // closer we bid to (and above) face value.
  const reserve = TUNING.reservePerAuction * ev.nUsable;
  const alpha = Math.min(
    TUNING.alphaMax,
    Math.max(TUNING.alphaMin, TUNING.alphaMin + (0.8 * balance) / (reserve + 20)),
  );
  let truth = Math.max(0, delta * alpha);

  // Pacing: coins are worthless at the end, so spend them at roughly our
  // fair share of the remaining auctions. If we want this letter at all,
  // bid at least enough to beat the going rate, within that budget.
  // Rack refill: with a short rack no single letter looks valuable (there's
  // no word close to finished), so delta is tiny and the bids fell to 1-8
  // for 45+ auctions straight in matches 45531/45539. A short rack is
  // exactly when we most need tiles, so pay the going rate for any letter
  // that doesn't hurt the rack.
  const short = total(r) < TUNING.rackRefill;
  if (delta > (short ? 0 : TUNING.paceMinDelta)) {
    const players = game.opponents.length + 1;
    const expectedWins = Math.max(1, ev.nUsable / players);
    // Earn-back only matters while there's time to play words.
    const earnBack = 1 + (TUNING.paceBudgetMult - 1) * ev.tau;
    const pace = (balance * earnBack) / expectedWins;
    const weight = short ? 1 : Math.min(1, delta / TUNING.paceFullDelta);
    truth = Math.max(truth, Math.min(pace, market + 1) * weight);
  }

  // Denial: if a rival we can see collecting tiles badly needs this one.
  let denial = 0;
  if (TUNING.denial > 0) {
    for (const o of game.opponents) {
      if (o.sim || !o.knownRack) continue;
      const known = countsFromMap(o.knownRack);
      if (total(known) < 4) continue;
      const g = ev.rivalGain(known, code);
      const weight = o.score >= game.myScore ? 1.2 : 0.8;
      denial = Math.max(denial, TUNING.denial * g * weight);
    }
  }
  let bid = Math.max(truth, denial);

  if (game.auctionType === "FirstPrice" && game.opponents.length > 0) {
    // We pay our own bid: bid just enough to beat the field, not our value.
    if (bid > rivalHi) bid = rivalHi + 1;
    else if (bid > rivalMid) bid = Math.max(rivalMid + 1, (bid + rivalMid) / 2);
    else bid = bid * 0.8;
  }

  // Endgame spend-down: in the last few auctions, leftover coins are about
  // to be worth nothing, so bid at least the going price (or a growing share
  // of our balance) on every letter. Even a tile we can't use costs us
  // nothing real and keeps it away from a rival.
  const auctionsInclThis = game.auctionsLeft + 1;
  if (auctionsInclThis <= TUNING.spendDownAuctions) {
    const share = balance / auctionsInclThis;
    const spend = Math.max(market + 1, share * TUNING.spendDownMult);
    bid = Math.max(bid, Math.min(balance, spend));
  }

  bid = Math.floor(bid);
  if (bid < 1 && delta > 0.5) bid = 1;
  // Not worth winning? Push the price up instead.
  if (game.auctionType === "Vickrey") bid = Math.max(bid, pushBid());
  return Math.max(0, Math.min(balance, bid));
}

// ---------- Playing words ----------

// Words to play right now, in order. Usually empty (we're hoarding toward
// a long word) or one 7+ word; at the very end, every word we can make.
export function planWords(ctx: WordContext): string[] {
  const game = ctx.game ?? defaultGame();
  const lx = lex(ctx.dictionary);
  const r = countsFromMap(ctx.myRack);
  if (total(r) < 2) return [];

  // Endgame: the last auction is open. Nothing more can arrive in time to
  // matter, so cash in everything before it closes.
  if (game.auctionsLeft <= 0) {
    return lx.bestDump(r).words.map((i) => lx.words[i]!);
  }

  const ev = new Evaluator(lx, game);
  let balance = ctx.myBalance ?? 100;
  // The price we need to be able to pay to stay in the auctions: the
  // cheapest unseen tile, the average one, or the most expensive one.
  let cheapest = Infinity;
  let dearest = 0;
  let sum = 0;
  let cnt = 0;
  for (const [L, n] of game.unseen) {
    if (n <= 0) continue;
    const pr = letterPrice(game, L);
    cheapest = Math.min(cheapest, pr);
    dearest = Math.max(dearest, pr);
    sum += pr * n;
    cnt += n;
  }
  if (!cnt) cheapest = dearest = sum = marketPrice(game), (cnt = 1);
  const need =
    TUNING.brokeRef === "dearest" ? dearest : TUNING.brokeRef === "average" ? sum / cnt : cheapest;
  const out: string[] = [];
  // Rack value for play-vs-hold decisions. The rack-health bonus is left
  // out: it scores how flexible our tiles are, grows with every tile we
  // hold, and isn't points. Counting it made every play look like a loss
  // (match 46978: ZEMINDARY, 72 points, ready at 62 left, held for 50
  // auctions because playing it "lost" a 20-point health bonus).
  const val = (x: Counts) =>
    TUNING.flexInPlay ? ev.phi(x) : ev.phi(x) - ev.tau * TUNING.flexWeight * flex(x);
  for (let step = 0; step < 4; step++) {
    // Broke: we can't win another tile, so holding can't improve the rack.
    // Play the best word now; its coins put us back in the auctions.
    const broke = TUNING.brokePlay && balance < TUNING.brokeFrac * need;
    const base = val(r);
    const all = lx.spellable(r);
    // A ready 7+ word already has the top multiplier (3x): waiting can't
    // raise it, and its coins buy tiles now. Play it.
    const longReady = TUNING.playLongNow && all.some((i) => lx.words[i]!.length >= 7);
    // Cash-in rule: once the rack is this big, don't keep saving up for a
    // 7+ word. Play the best word of playMinLen+ letters now, keeping the
    // most useful leftovers, so the rack keeps turning over instead of
    // emptying out in one big play.
    const cashIn = total(r) >= TUNING.playAtRack;
    const cands = cashIn
      ? all
          .filter((i) => lx.words[i]!.length >= TUNING.playMinLen)
          .sort((a, b) => lx.rewards[b]! - lx.rewards[a]!)
          .slice(0, 30)
      : all.slice(0, 12);
    let bestGain = -Infinity;
    let bestI = -1;
    for (const i of cands) {
      // Never play the whole rack in one word unless that's all we can do:
      // keep at least keepAfterPlay tiles to build the next word from.
      const left = total(r) - lx.words[i]!.length;
      const keepPenalty = cashIn && left < TUNING.keepAfterPlay ? TUNING.emptyRackPenalty : 0;
      const rest = new Int32Array(r);
      lx.subtract(rest, i);
      const reward = lx.rewards[i]!;
      // Coins in hand now are worth a bit extra while we're short.
      const coinBonus =
        reward * TUNING.coinNowBonus * (balance < TUNING.lowBalance ? 1 : 0.3);
      // Optional: hold short words while there's time to grow them.
      if (!cashIn && !broke && TUNING.holdShortLen > 0 &&
          lx.words[i]!.length < TUNING.holdShortLen && ev.nUsable > TUNING.holdShortLeft) continue;
      const gain = reward + coinBonus + val(rest) - base - keepPenalty;
      if (gain > bestGain) {
        bestGain = gain;
        bestI = i;
      }
    }
    // Under the cash-in rule we play the best option even if hoarding
    // looked slightly better on paper.
    if (longReady && !cashIn) {
      // Best 7+ word, judged by points now plus what's left behind.
      let bi = -1;
      let bv = -Infinity;
      for (const i of all) {
        if (lx.words[i]!.length < 7) continue;
        const rest = new Int32Array(r);
        lx.subtract(rest, i);
        const v = lx.rewards[i]! + val(rest);
        if (v > bv) { bv = v; bi = i; }
      }
      if (bi >= 0) bestI = bi;
    }
    if (bestI < 0 || (!cashIn && !broke && !longReady && bestGain < -TUNING.playSlack)) break;
    out.push(lx.words[bestI]!);
    balance += lx.rewards[bestI]!; // words pay coins
    lx.subtract(r, bestI);
  }
  return out;
}

export function chooseWord(ctx: WordContext): string | null {
  return planWords(ctx)[0] ?? null;
}

// Re-exported for tools and tests.
export { VALUE_BY_CODE };