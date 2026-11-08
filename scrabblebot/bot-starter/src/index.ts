// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  LETTER_VALUE,
  decideBid,
  initStrategy,
  planWords,
  type GameInfo,
  type Opponent,
  type SimKind,
} from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick
initStrategy(DICTIONARY); // builds the fast word index once (~1 s)

const STANDARD_BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
  Y: 2, Z: 1,
};

// ---------- Opponent memory ----------
// After each match the module publishes every auction's top bid. For real
// (non-sim) bots that won, we record how far over face value they bid, and
// keep it on disk so the bot gets better at reading rivals over time.
const MEMORY_PATH = path.join(process.cwd(), `.opponents-${BOT_NAME}.json`);
type Memory = Record<string, number[]>; // botId -> recent (topBid - face)
let memory: Memory = {};
try {
  memory = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
} catch {
  memory = {};
}
let memoryDirty = false;
function remember(botId: string, offset: number) {
  const xs = (memory[botId] ??= []);
  xs.push(offset);
  if (xs.length > 200) xs.splice(0, xs.length - 200);
  memoryDirty = true;
}
setInterval(() => {
  if (!memoryDirty) return;
  memoryDirty = false;
  try {
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory));
  } catch {}
}, 5000).unref();
function bidModel(botId: string): Opponent["bidModel"] {
  const xs = memory[botId];
  if (!xs || xs.length < 5) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)]!;
  const p85 = s[Math.floor(s.length * 0.85)]!;
  return { offset: med, spread: Math.max(1, p85 - med + 1) };
}

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const WORD_RETRY_MS = 500;

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

const add = (m: Map<string, number>, k: string, n = 1) =>
  m.set(k, (m.get(k) ?? 0) + n);

// Everything public about a running match, in the shape the strategy wants.
function buildGame(conn: DbConnection, matchId: bigint): GameInfo | null {
  const m = conn.db.matchState.id.find(matchId);
  if (!m || myBotId === null) return null;
  const won = new Map<string, Map<string, number>>();
  const played = new Map<string, Map<string, number>>();
  const auctioned = new Map<string, number>();
  for (const a of conn.db.auction.iter()) {
    if (a.matchId === matchId) add(auctioned, a.letter);
  }
  for (const r of conn.db.auctionResult.iter()) {
    if (r.matchId !== matchId || r.winnerBotId == null) continue;
    const k = String(r.winnerBotId);
    if (!won.has(k)) won.set(k, new Map());
    add(won.get(k)!, r.letter);
  }
  for (const w of conn.db.wordPlay.iter()) {
    if (w.matchId !== matchId) continue;
    const k = String(w.botId);
    if (!played.has(k)) played.set(k, new Map());
    for (const c of w.word) add(played.get(k)!, c);
  }
  const me = String(myBotId);
  // My starting tiles = what I hold + what I've played - what I've won.
  const myStart = new Map<string, number>();
  const rack = rackForMatch(conn, matchId);
  for (const c of Object.keys(STANDARD_BAG)) {
    const n =
      (rack.get(c) ?? 0) +
      (played.get(me)?.get(c) ?? 0) -
      (won.get(me)?.get(c) ?? 0);
    if (n > 0) myStart.set(c, n);
  }
  const opponents: Opponent[] = [];
  let myScore = 0;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    const id = String(p.botId);
    if (id === me) {
      myScore = Number(p.score);
      continue;
    }
    const bot = conn.db.bot.id.find(p.botId);
    const known = new Map<string, number>();
    for (const [c, n] of won.get(id) ?? []) {
      const k = n - (played.get(id)?.get(c) ?? 0);
      if (k > 0) known.set(c, k);
    }
    opponents.push({
      botId: id,
      balance: Number(p.balance),
      score: Number(p.score),
      sim: bot?.isSimulated ? (bot.strategy.tag as SimKind) : undefined,
      knownRack: known,
      bidModel: bot?.isSimulated ? undefined : bidModel(id),
    });
  }
  // Unseen = full bag - every auctioned letter - my start tiles - rivals'
  // start tiles they've revealed by playing more than they won.
  const unseen = new Map<string, number>();
  for (const [c, n] of Object.entries(STANDARD_BAG)) {
    let seen = (auctioned.get(c) ?? 0) + (myStart.get(c) ?? 0);
    for (const o of opponents) {
      seen += Math.max(
        0,
        (played.get(o.botId)?.get(c) ?? 0) - (won.get(o.botId)?.get(c) ?? 0),
      );
    }
    unseen.set(c, Math.max(0, n - seen));
  }
  return {
    auctionsLeft: m.bagTotal,
    auctionType: m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
    unseen,
    opponents,
    myScore,
  };
}

// Our live bid per open auction, so we can raise it after a word pays out.
const myBids = new Map<string, number>();

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  const a = conn.db.auction.id.find(auctionId);
  if (!a || a.status.tag !== "Open") return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const game = buildGame(conn, matchId);
  if (!game) return;
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
    dictionary: DICTIONARY,
    game,
  });
  const prev = myBids.get(key);
  if (prev === amount || (prev === undefined && amount <= 0)) return;
  myBids.set(key, amount);
  bidsByAuction.add(key);
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(`bid on auction ${auctionId}`));
  console.log(
    `[${BOT_NAME}] ${prev === undefined ? "bid" : "rebid"} ${amount} on '${letter}' (match ${matchId}, ${game.auctionsLeft} left)`,
  );
}

function rebidOpen(conn: DbConnection, matchId: bigint) {
  for (const a of conn.db.auction.iter()) {
    if (a.matchId === matchId && a.status.tag === "Open") {
      tryBid(conn, a.id, a.matchId, a.letter);
    }
  }
}

// Words we've sent but the server hasn't confirmed, per match.
const inFlight = new Map<string, number>();
const recheck = new Map<string, ReturnType<typeof setTimeout>>();

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches = new Set<bigint>();
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") matches.add(p.matchId);
  }
  const now = Date.now();
  for (const matchId of matches) {
    const key = String(matchId);
    if ((inFlight.get(key) ?? 0) > 0) continue;
    const since = now - (lastWordAttemptByMatch.get(key) ?? 0);
    if (since < WORD_RETRY_MS) {
      // Don't drop the check: run it as soon as the throttle allows.
      if (!recheck.has(key)) {
        recheck.set(
          key,
          setTimeout(() => {
            recheck.delete(key);
            tryPlayWord(conn);
          }, WORD_RETRY_MS - since + 5),
        );
      }
      continue;
    }
    const game = buildGame(conn, matchId);
    const participant = participantForMatch(conn, matchId);
    if (!game || !participant) continue;
    const words = planWords({
      myRack: rackForMatch(conn, matchId),
      dictionary: DICTIONARY,
      myBalance: participant.balance,
      game,
    });
    if (!words.length) continue;
    lastWordAttemptByMatch.set(key, now);
    inFlight.set(key, words.length);
    for (const word of words) {
      console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
      conn.reducers
        .submitWord({ matchId, word })
        .catch(logFailure(`playing '${word}'`))
        .finally(() => {
          const left = (inFlight.get(key) ?? 1) - 1;
          inFlight.set(key, left);
          if (left <= 0) {
            // The payout is in: spend it on the open auction if worth it.
            rebidOpen(conn, matchId);
            tryPlayWord(conn);
          }
        });
    }
  }
}

// ---------- Narrow subscriptions ----------
// subscribeToAllTables() downloads every match, auction and word ever played
// into the client cache, which runs Node out of memory. Instead:
//   1. small "core" tables (my credential, my rack, bots, lobby)
//   2. my own match_participant rows, to learn which matches I'm in
//   3. full detail only for my latest / newly joined match, dropped when it ends
// NOTE: table/column names are snake_case as in the module. If a query errors,
// check the names in src/module_bindings/.
type SubHandle = { unsubscribe: () => void };
const watchedMatches = new Map<string, SubHandle>();

function subErr(what: string) {
  return (_ctx: unknown, err?: unknown) =>
    console.error(`[${BOT_NAME}] subscription '${what}' failed:`, err ?? _ctx);
}

function watchMatch(conn: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (watchedMatches.has(key)) return;
  const id = matchId.toString();
  const handle = conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] watching match ${id}`);
      for (const a of conn.db.auction.iter()) {
        if (a.matchId === matchId && a.status.tag === "Open")
          tryBid(conn, a.id, a.matchId, a.letter);
      }
      tryPlayWord(conn);
    })
    .onError(subErr(`match ${id}`))
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${id}`,
      `SELECT * FROM match_participant WHERE match_id = ${id}`,
      `SELECT * FROM auction WHERE match_id = ${id}`,
      `SELECT * FROM auction_result WHERE match_id = ${id}`,
      `SELECT * FROM word_play WHERE match_id = ${id}`,
    ]);
  watchedMatches.set(key, handle as unknown as SubHandle);
}

function unwatchMatch(matchId: bigint) {
  const key = String(matchId);
  const h = watchedMatches.get(key);
  if (!h) return;
  watchedMatches.delete(key);
  // Give the end-of-match rows a moment to arrive before dropping them.
  setTimeout(() => {
    try {
      h.unsubscribe();
    } catch {}
  }, 5000);
}

// ---------- One-off data dump (DUMP=1 npm start) ----------
// Saves the last DUMP_MATCHES matches (default 2000, counted back from our
// latest match) to dump.json for offline analysis, then drops that data
// from the cache again so memory stays low.
function dumpRecent(conn: DbConnection, latest: bigint) {
  const n = BigInt(process.env.DUMP_MATCHES ?? "2000");
  const from = latest > n ? latest - n : 0n;
  console.log(`[${BOT_NAME}] dumping matches ${from + 1n}..${latest}…`);
  const handle = conn
    .subscriptionBuilder()
    .onApplied(() => {
      const inRange = (r: { matchId: bigint }) => r.matchId > from;
      const data = {
        auctions: [...conn.db.auctionResult.iter()].filter(inRange),
        words: [...conn.db.wordPlay.iter()].filter(inRange),
        players: [...conn.db.matchParticipant.iter()].filter(inRange),
        bots: [...conn.db.bot.iter()],
      };
      fs.writeFileSync(
        path.join(process.cwd(), "dump.json"),
        JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
      );
      console.log(
        `[${BOT_NAME}] wrote dump.json (${data.auctions.length} auctions, ${data.words.length} words, ${data.players.length} player rows)`,
      );
      setTimeout(() => {
        try {
          (handle as unknown as SubHandle).unsubscribe();
        } catch {}
      }, 1000);
    })
    .onError(subErr("dump"))
    .subscribe([
      `SELECT * FROM auction_result WHERE match_id > ${from}`,
      `SELECT * FROM word_play WHERE match_id > ${from}`,
      `SELECT * FROM match_participant WHERE match_id > ${from}`,
    ]);
}

function subscribeMine(conn: DbConnection, onReady: () => void) {
  if (myBotId === null) return;
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      // Only the most recent match can still be running for us.
      let latest: bigint | null = null;
      for (const p of conn.db.matchParticipant.iter()) {
        if (p.botId === myBotId && (latest === null || p.matchId > latest))
          latest = p.matchId;
      }
      if (latest !== null) watchMatch(conn, latest);
      if (process.env.DUMP && latest !== null) dumpRecent(conn, latest);
      onReady();
    })
    .onError(subErr("my matches"))
    .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`]);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  // Matches we join later: start watching as soon as our row appears.
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (myBotId !== null && p.botId === myBotId) watchMatch(conn, p.matchId);
  });

  conn
    .subscriptionBuilder()
    .onError(subErr("core"))
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            subscribeMine(conn, () => bootstrapActivity(conn));
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      subscribeMine(conn, () => bootstrapActivity(conn));
    })
    .subscribe([
      `SELECT * FROM bot_credential`,
      `SELECT * FROM my_rack`,
      `SELECT * FROM bot`,
      `SELECT * FROM lobby`,
      `SELECT * FROM lobby_member`,
    ]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag !== "Open") return;
    // Words first: on the final auction this cashes in the whole rack, and
    // the payout funds a bigger bid.
    tryPlayWord(conn);
    tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.auctionTopBidArchive.onInsert((_ctx, top) => {
    const r = conn.db.auctionResult.auctionId.find(top.auctionId);
    if (!r || r.winnerBotId == null || r.winnerBotId === myBotId) return;
    const bot = conn.db.bot.id.find(r.winnerBotId);
    if (!bot || bot.isSimulated) return;
    remember(String(r.winnerBotId), Number(top.topBid) - (LETTER_VALUE[r.letter] ?? 1));
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      unwatchMatch(neu.id);
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => console.log("disconnected"))
    .build();
}

main();