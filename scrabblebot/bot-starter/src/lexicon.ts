// Fast word engine. Every word is stored as a 26-bit "which letters" mask
// plus a 26-slot letter-count row, so the questions the strategy asks
// thousands of times per auction ("what can I spell?", "what am I 1-2
// letters away from?") are a tight loop over typed arrays, not string work.

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

export const VALUE_BY_CODE: number[] = Array.from(
  { length: 26 },
  (_, i) => LETTER_VALUE[String.fromCharCode(65 + i)] ?? 1,
);

// Mirrors the server: <=3 letters 1x, 4 1.5x, 5 2x, 6 2.5x, 7+ 3x,
// integer division.
export function multiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  const [n, d] = multiplier(word.length);
  return Math.floor((base * n) / d);
}

export type Counts = Int32Array; // length 26

export function emptyCounts(): Counts {
  return new Int32Array(26);
}

export function countsFromMap(m: Map<string, number>): Counts {
  const c = emptyCounts();
  for (const [k, v] of m) {
    const i = k.charCodeAt(0) - 65;
    if (i >= 0 && i < 26) c[i] += v;
  }
  return c;
}

export function countsFromString(s: string): Counts {
  const c = emptyCounts();
  for (const ch of s) {
    const i = ch.charCodeAt(0) - 65;
    if (i >= 0 && i < 26) c[i]++;
  }
  return c;
}

export function maskOf(c: Counts): number {
  let m = 0;
  for (let i = 0; i < 26; i++) if (c[i] > 0) m |= 1 << i;
  return m >>> 0;
}

export function total(c: Counts): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += c[i];
  return t;
}

export function keyOf(c: Counts): string {
  return String.fromCharCode(...Array.from(c, (v) => 48 + v));
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export class Lexicon {
  readonly words: string[];
  readonly n: number;
  readonly masks: Uint32Array;
  readonly counts: Uint8Array; // n * 26
  readonly rewards: Int32Array;
  readonly lens: Uint8Array;
  private set: Set<string>;
  private dumpMemo = new Map<string, { value: number; words: number[] }>();

  // Words longer than `maxLen` are dropped: past 7 letters the multiplier
  // stops growing, so an 11-letter word is worth no more per letter than a
  // 7, and it's far harder to assemble.
  constructor(dictionary: string[], maxLen = 10) {
    const seen = new Set<string>();
    const ws: string[] = [];
    for (const raw of dictionary) {
      const w = raw.trim().toUpperCase();
      if (w.length < 2 || w.length > maxLen || seen.has(w)) continue;
      if (!/^[A-Z]+$/.test(w)) continue;
      seen.add(w);
      ws.push(w);
    }
    // Highest reward first, so scans can stop early and the first hit in
    // a list is the best.
    ws.sort((a, b) => wordReward(b) - wordReward(a) || b.length - a.length);
    this.words = ws;
    this.n = ws.length;
    this.set = seen;
    this.masks = new Uint32Array(this.n);
    this.counts = new Uint8Array(this.n * 26);
    this.rewards = new Int32Array(this.n);
    this.lens = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const w = ws[i]!;
      let m = 0;
      for (let j = 0; j < w.length; j++) {
        const b = w.charCodeAt(j) - 65;
        this.counts[i * 26 + b]++;
        m |= 1 << b;
      }
      this.masks[i] = m >>> 0;
      this.rewards[i] = wordReward(w);
      this.lens[i] = w.length;
    }
  }

  has(word: string): boolean {
    return this.set.has(word);
  }

  // Indices of every word spellable from `rack`, best reward first.
  spellable(rack: Counts, minLen = 2): number[] {
    const rm = maskOf(rack);
    const inv = ~rm >>> 0;
    const tot = total(rack);
    const out: number[] = [];
    const { masks, counts, lens } = this;
    for (let i = 0; i < this.n; i++) {
      if ((masks[i]! & inv) !== 0) continue;
      const L = lens[i]!;
      if (L > tot || L < minLen) continue;
      let ok = true;
      let m = masks[i]!;
      const base = i * 26;
      while (m) {
        const b = 31 - Math.clz32(m & -m);
        m &= m - 1;
        if (counts[base + b]! > rack[b]!) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(i);
    }
    return out;
  }

  // Calls `visit(i, missing)` for every word (length >= minLen) that is at
  // most `maxMissing` tiles away from `rack`. `missing` is a reused 26-slot
  // array of how many of each letter are still needed: copy it to keep it.
  nearMiss(
    rack: Counts,
    maxMissing: number,
    minLen: number,
    visit: (i: number, missing: Int32Array, nMissing: number) => void,
  ): void {
    const rm = maskOf(rack);
    const inv = ~rm >>> 0;
    const tot = total(rack);
    const missing = new Int32Array(26);
    const { masks, counts, lens } = this;
    for (let i = 0; i < this.n; i++) {
      const wm = masks[i]!;
      const L = lens[i]!;
      if (L < minLen || L > tot + maxMissing) continue;
      if (popcount(wm & inv) > maxMissing) continue;
      let def = 0;
      let m = wm;
      const base = i * 26;
      let touched = 0;
      while (m) {
        const b = 31 - Math.clz32(m & -m);
        m &= m - 1;
        const d = counts[base + b]! - rack[b]!;
        if (d > 0) {
          def += d;
          if (def > maxMissing) break;
          missing[b] = d;
          touched |= 1 << b;
        }
      }
      if (def <= maxMissing) visit(i, missing, def);
      // reset only what we touched
      while (touched) {
        const b = 31 - Math.clz32(touched & -touched);
        touched &= touched - 1;
        missing[b] = 0;
      }
    }
  }

  // Remove word i's letters from `rack` (in place). Assumes spellable.
  subtract(rack: Counts, i: number): void {
    const base = i * 26;
    let m = this.masks[i]!;
    while (m) {
      const b = 31 - Math.clz32(m & -m);
      m &= m - 1;
      rack[b] -= this.counts[base + b]!;
    }
  }

  // Rack minus whatever letters of word i it holds (never below zero).
  without(rack: Counts, i: number): Counts {
    const r = new Int32Array(rack);
    const base = i * 26;
    let m = this.masks[i]!;
    while (m) {
      const b = 31 - Math.clz32(m & -m);
      m &= m - 1;
      r[b] = Math.max(0, r[b]! - this.counts[base + b]!);
    }
    return r;
  }

  // Best set of disjoint words to play from `rack` right now (max total
  // reward). Bounded depth-first search over the spellable words, memoised
  // by rack.
  bestDump(rack: Counts, nodeLimit = 4000): { value: number; words: number[] } {
    const key = keyOf(rack);
    const hit = this.dumpMemo.get(key);
    if (hit) return hit;
    const cands = this.spellable(rack);
    let best = { value: 0, words: [] as number[] };
    if (cands.length > 0) {
      let nodes = 0;
      const cur: number[] = [];
      const r = new Int32Array(rack);
      // Upper bound: every remaining tile at 3x.
      const ub = (rr: Counts) => {
        let s = 0;
        for (let b = 0; b < 26; b++) s += rr[b]! * VALUE_BY_CODE[b]!;
        return s * 3;
      };
      const fits = (i: number) => {
        const base = i * 26;
        let m = this.masks[i]!;
        while (m) {
          const b = 31 - Math.clz32(m & -m);
          m &= m - 1;
          if (this.counts[base + b]! > r[b]!) return false;
        }
        return true;
      };
      const dfs = (start: number, acc: number) => {
        if (acc > best.value) best = { value: acc, words: cur.slice() };
        if (++nodes > nodeLimit) return;
        if (acc + ub(r) <= best.value) return;
        let tried = 0;
        for (let k = start; k < cands.length; k++) {
          const i = cands[k]!;
          if (!fits(i)) continue;
          // Branch on the few best options per level; the long tail of
          // two-letter words rarely changes the answer.
          if (++tried > 12) break;
          this.subtract(r, i);
          cur.push(i);
          dfs(k, acc + this.rewards[i]!);
          cur.pop();
          const base = i * 26;
          let m = this.masks[i]!;
          while (m) {
            const b = 31 - Math.clz32(m & -m);
            m &= m - 1;
            r[b] += this.counts[base + b]!;
          }
          if (nodes > nodeLimit) return;
        }
      };
      dfs(0, 0);
    }
    if (this.dumpMemo.size > 20000) this.dumpMemo.clear();
    this.dumpMemo.set(key, best);
    return best;
  }
}

// One lexicon per dictionary array, built on first use.
const cache = new WeakMap<string[], Lexicon>();
export function lexiconFor(dictionary: string[]): Lexicon {
  let lx = cache.get(dictionary);
  if (!lx) {
    lx = new Lexicon(dictionary);
    cache.set(dictionary, lx);
  }
  return lx;
}
