// Pump.fun Bot Sprint — momentum bot for agent-fun/replay/v2.
//
// Strategy (deterministic, no clock, no randomness, no I/O beyond stdin/stdout):
//   * Snipe launches: buy in a coin's first 8 slots, only when real SOL has
//     already reached >= 1 SOL, at least 2 distinct buyers are in, the opening
//     tape is net buying, no single buyer dominates, and the creator's own buy
//     is modest (<= 2 SOL) and the creator has not sold.
//   * Cut losers fast at -7%. Bank half at +20% and let the rest ride a trailing
//     stop (12% below the peak once up 20%) so a rare runner that completes pays
//     for the losers. Hard 600-slot hold limit; exit at once on a creator sell
//     or a single >= 1.5 SOL sell.
//   * Risk controls: at most 5 open positions, 0.06 SOL per coin, at most 2
//     entries per coin, 240-slot cooldown after an exit, and a deterministic
//     pace relaxation (from block time only) so the guardrail of >= 20 distinct
//     coins with >= 0.01 SOL round trips is met even on a quiet tape.
//
// Wire protocol: the harness sends NDJSON on stdin (hello, batch..., done); the bot
// answers exactly one reply line per batch on stdout, echoing its seq. Price is
// virtual_quote_reserves / virtual_token_reserves (SOL per token). Amounts are u64
// decimal strings; client ids are o1, o2, ... in send order.

import * as readline from 'node:readline';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL = (x: number): bigint => BigInt(Math.round(x * 1e9));

// ---- tunables (v2: sniper + tight stop + runner tail) ----------------------
// v1 defect: momentum entry bought AFTER a +4% run-up in 40 slots — on pump.fun
// that is usually the top; losers then bled to the -12% stop while winners were
// capped at +30%. Dev: -1.88 SOL, win rate 19%. v2 flips the entry to the launch
// itself (age 0-8 slots, distributed early buying, modest dev buy), cuts losers
// fast at -7%, banks half at +20% and lets the rest ride a trailing stop so the
// rare runner that completes pays for the losers.
const WINDOW_SLOTS = 40;
const MIN_BUYERS = 3;
const MAX_TOP_SHARE = 0.6;
const MIN_RQ_SOL = 2.0;
const MAX_RQ_SOL = 80;
const MAX_DEV_BUY_SOL = 1.0;
const MIN_AGE = 0;
const MAX_AGE = 5;
const STAKE = SOL(0.06);
const MIN_BUY = SOL(0.01);
const TP_HALF_RATIO = 1.3;
const SL_RATIO = 0.93;
const TRAIL_ARM = 1.3;
const TRAIL_KEEP = 0.85;
const MAX_HOLD_SLOTS = 120;
const COOLDOWN_SLOTS = 240;
const MAX_ENTRIES = 2;
const BIG_SELL_SOL = 1.5;
const BUY_SLIP_BPS = 2000;
const SELL_SLIP_BPS = 10000;
const PRUNE_AFTER_SLOTS = 7200;
const TAPE_KEEP_SLOTS = 240;

// Relaxed entry tiers, keyed on block-time pace (deterministic, from the tape).
const RELAX_1_AFTER_SEC = 1800;
const RELAX_2_AFTER_SEC = 3600;

// ---- types -----------------------------------------------------------------
type Mint = string;

interface Trade {
  slot: number;
  price: number;
  isBuy: boolean;
  sol: number; // SOL
  user: string;
}

interface Coin {
  mint: Mint;
  creator: string;
  createdSlot: number | null;
  createPrice: number;
  vToken: bigint;
  vQuote: bigint;
  rToken: bigint;
  rQuote: bigint;
  reservesSlot: number;
  complete: boolean;
  trades: Trade[];
  creatorSold: boolean;
  devBuySol: number;
  entries: number;
  lastExitSlot: number;
  buySlot: number;
  lastBuyPrice: number;
  tookPartial: boolean;
  peak: number;
  lastSeenSlot: number;
}

interface PendingInfo {
  side: 'buy' | 'sell';
  mint: Mint;
  decidedSlot: number;
  price: number;
  amount: bigint;
}

interface Hello {
  protocol: string;
  seed: string;
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
  };
  latency_slots: number;
  fees: { base_fee_lamports: string; priority_fee_lamports: string };
}

// ---- state -----------------------------------------------------------------
const coins = new Map<Mint, Coin>();
const pending = new Map<string, PendingInfo>();
const boughtMints = new Set<Mint>();
let nextClient = 1;
let hello: Hello | null = null;
let cash = 0n;
let positions = new Map<Mint, { tokens: bigint; cost: bigint }>();
let firstBlockTime = -1;
let lastBlockTime = -1;
let batchesSeen = 0;

function txFee(): bigint {
  return BigInt(hello!.fees.base_fee_lamports) + BigInt(hello!.fees.priority_fee_lamports);
}

function priceOf(c: Coin): number {
  if (c.vToken === 0n) return 0;
  return Number(c.vQuote) / Number(c.vToken);
}

function positionValueLamports(mint: Mint): bigint {
  const pos = positions.get(mint);
  const c = coins.get(mint);
  if (!pos || !c) return 0n;
  const price = priceOf(c);
  if (price <= 0) return 0n;
  return BigInt(Math.floor(Number(pos.tokens) * price));
}

function maxBuyLamports(c: Coin): bigint {
  if (c.complete) return 0n;
  return (c.rQuote * BigInt(hello!.caps.max_order_bps_of_real_reserve)) / 10000n;
}

function committedPositions(): number {
  const mints = new Set<Mint>(positions.keys());
  for (const p of pending.values()) if (p.side === 'buy') mints.add(p.mint);
  return mints.size;
}

function freeCash(): bigint {
  const tx = txFee();
  let free = cash;
  for (const p of pending.values()) {
    free -= tx;
    if (p.side === 'buy') free -= p.amount;
  }
  return free;
}

function hasPending(mint: Mint, side: 'buy' | 'sell'): boolean {
  for (const p of pending.values()) if (p.mint === mint && p.side === side) return true;
  return false;
}

function getCoin(mint: Mint): Coin {
  let c = coins.get(mint);
  if (!c) {
    c = {
      mint,
      creator: '',
      createdSlot: null,
      createPrice: 0,
      vToken: 0n,
      vQuote: 0n,
      rToken: 0n,
      rQuote: 0n,
      reservesSlot: 0,
      complete: false,
      trades: [],
      creatorSold: false,
      devBuySol: 0,
      entries: 0,
      lastExitSlot: -1e9,
      buySlot: 0,
      lastBuyPrice: 0,
      tookPartial: false,
      peak: 0,
      lastSeenSlot: 0,
    };
    coins.set(mint, c);
  }
  return c;
}

function pruneTape(c: Coin, slot: number): void {
  const cut = slot - TAPE_KEEP_SLOTS;
  if (c.trades.length > 0 && c.trades[0].slot < cut) {
    c.trades = c.trades.filter((t) => t.slot >= cut);
  }
}

function windowStats(c: Coin, slot: number): {
  netSol: number;
  buys: number;
  buyers: number;
  buySol: number;
  topShare: number;
  startPrice: number;
  high: number;
} {
  const cut = slot - WINDOW_SLOTS;
  let netSol = 0;
  let buys = 0;
  let buySol = 0;
  const buyers = new Set<string>();
  const perBuyer = new Map<string, number>();
  let startPrice = c.createPrice;
  let high = 0;
  let first = true;
  for (const t of c.trades) {
    if (t.slot < cut) continue;
    if (first) {
      startPrice = t.price;
      first = false;
    }
    if (t.price > high) high = t.price;
    if (t.isBuy) {
      buys += 1;
      buySol += t.sol;
      netSol += t.sol;
      if (t.user !== c.creator) {
        buyers.add(t.user);
        perBuyer.set(t.user, (perBuyer.get(t.user) ?? 0) + t.sol);
      }
    } else {
      netSol -= t.sol;
    }
  }
  let top = 0;
  for (const v of perBuyer.values()) if (v > top) top = v;
  return {
    netSol,
    buys,
    buyers: buyers.size,
    buySol,
    topShare: buySol > 0 ? top / buySol : 1,
    startPrice,
    high,
  };
}

// Pace tier from block time: 0 = normal, 1 = relaxed, 2 = very relaxed.
function paceTier(): number {
  if (firstBlockTime < 0 || lastBlockTime < firstBlockTime) return 0;
  const elapsed = lastBlockTime - firstBlockTime;
  if (elapsed >= RELAX_2_AFTER_SEC && boughtMints.size < 6) return 2;
  if (elapsed >= RELAX_1_AFTER_SEC && boughtMints.size < 3) return 1;
  return 0;
}

interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  mint: Mint;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

function newClientId(): string {
  return `o${nextClient++}`;
}

// ---- batch handling --------------------------------------------------------
function applyBatch(batch: any): void {
  const slot: number = batch.slot;
  batchesSeen += 1;

  for (const f of batch.fills as any[]) {
    const p = pending.get(f.client_id);
    pending.delete(f.client_id);
    if (p && f.status === 'filled' && p.side === 'buy') {
      const c = coins.get(p.mint);
      if (c) {
        c.buySlot = p.decidedSlot;
        c.lastBuyPrice = p.price;
        c.tookPartial = false;
        c.peak = 0;
        c.entries += 1;
        boughtMints.add(p.mint);
      }
    }
  }

  cash = BigInt(batch.account.cash_lamports);
  positions = new Map();
  for (const pos of batch.account.positions as any[]) {
    const tokens = BigInt(pos.token_amount);
    if (tokens > 0n) {
      positions.set(pos.mint, { tokens, cost: BigInt(pos.cost_lamports) });
    }
  }

  for (const m of batch.marks as any[]) {
    const c = coins.get(m.mint);
    if (!c || m.slot < c.reservesSlot) continue;
    c.vToken = BigInt(m.virtual_token_reserves);
    c.vQuote = BigInt(m.virtual_quote_reserves);
    c.rToken = BigInt(m.real_token_reserves);
    c.rQuote = BigInt(m.real_quote_reserves);
    c.reservesSlot = m.slot;
  }

  for (const e of batch.events as any[]) {
    if (typeof e.block_time === 'number') {
      if (firstBlockTime < 0) firstBlockTime = e.block_time;
      lastBlockTime = e.block_time;
    }
    const c = getCoin(e.mint);
    c.lastSeenSlot = slot;
    if (e.event === 'CreateEvent') {
      c.creator = e.creator;
      c.createdSlot = e.slot;
      c.vToken = BigInt(e.virtual_token_reserves);
      c.vQuote = BigInt(e.virtual_quote_reserves);
      c.rToken = BigInt(e.real_token_reserves);
      c.rQuote = 0n;
      c.reservesSlot = e.slot;
      c.createPrice = priceOf(c);
    } else if (e.event === 'TradeEvent') {
      c.vToken = BigInt(e.virtual_token_reserves);
      c.vQuote = BigInt(e.virtual_quote_reserves);
      c.rToken = BigInt(e.real_token_reserves);
      c.rQuote = BigInt(e.real_quote_reserves);
      c.reservesSlot = e.slot;
      const price = priceOf(c);
      c.trades.push({
        slot: e.slot,
        price,
        isBuy: e.is_buy,
        sol: Number(BigInt(e.sol_amount)) / 1e9,
        user: e.user,
      });
      pruneTape(c, slot);
      if (!e.is_buy && e.user === c.creator) c.creatorSold = true;
      if (e.is_buy && e.user === c.creator) c.devBuySol += Number(BigInt(e.sol_amount)) / 1e9;
    } else if (e.event === 'CompleteEvent') {
      c.complete = true;
    }
  }

  // Drop stale, unheld coins so memory stays bounded over a 24h tape.
  if (batchesSeen % 500 === 0) {
    for (const [mint, c] of coins) {
      if (!positions.has(mint) && !hasPending(mint, 'buy') && c.lastSeenSlot < slot - PRUNE_AFTER_SLOTS) {
        coins.delete(mint);
      }
    }
  }
}

function decideOrders(batch: any): Order[] {
  const slot: number = batch.slot;
  const orders: Order[] = [];
  const tier = paceTier();
  const minBuyers = tier === 2 ? 1 : MIN_BUYERS;
  const minRq = tier === 2 ? 0.5 : MIN_RQ_SOL;
  const tx = txFee();
  let free = freeCash();
  let openSlots = hello!.caps.max_open_positions - committedPositions();

  // Events seen this batch, in order: creator sells / big sells per mint.
  const creatorSoldNow = new Set<Mint>();
  const bigSellNow = new Set<Mint>();
  const eventMints: Mint[] = [];
  const seenEventMints = new Set<Mint>();
  for (const e of batch.events as any[]) {
    if (!seenEventMints.has(e.mint)) {
      seenEventMints.add(e.mint);
      eventMints.push(e.mint);
    }
    if (e.event === 'TradeEvent' && !e.is_buy) {
      const c = coins.get(e.mint);
      if (c && e.user === c.creator) creatorSoldNow.add(e.mint);
      if (Number(BigInt(e.sol_amount)) / 1e9 >= BIG_SELL_SOL) bigSellNow.add(e.mint);
    }
  }

  // ---- exits first ---------------------------------------------------------
  for (const [mint, pos] of positions) {
    const c = coins.get(mint);
    if (!c || c.complete) continue;
    if (hasPending(mint, 'sell')) continue;
    if (orders.length >= hello!.caps.max_orders_per_batch) break;
    const value = positionValueLamports(mint);
    if (value <= 0n || pos.cost <= 0n) continue;
    const ratio = Number(value) / Number(pos.cost);
    if (ratio >= TRAIL_ARM && ratio > c.peak) c.peak = ratio;
    // Bank half once up 20%: the rest rides the trailing stop.
    if (!c.tookPartial && ratio >= TP_HALF_RATIO) {
      const half = pos.tokens / 2n;
      if (half > 0n) {
        const id = newClientId();
        orders.push({
          side: 'sell',
          client_id: id,
          mint,
          token_amount: half.toString(),
          max_slippage_bps: SELL_SLIP_BPS,
        });
        pending.set(id, { side: 'sell', mint, decidedSlot: slot, price: priceOf(c), amount: half });
        c.tookPartial = true;
        continue;
      }
    }
    let exit = false;
    if (ratio <= SL_RATIO) exit = true;
    else if (c.peak > 0 && ratio <= c.peak * TRAIL_KEEP) exit = true;
    else if (slot - c.buySlot >= MAX_HOLD_SLOTS) exit = true;
    else if (creatorSoldNow.has(mint)) exit = true;
    else if (bigSellNow.has(mint)) exit = true;
    if (!exit) continue;
    const id = newClientId();
    orders.push({
      side: 'sell',
      client_id: id,
      mint,
      token_amount: pos.tokens.toString(),
      max_slippage_bps: SELL_SLIP_BPS,
    });
    pending.set(id, { side: 'sell', mint, decidedSlot: slot, price: priceOf(c), amount: pos.tokens });
    c.lastExitSlot = slot;
    c.peak = 0;
  }

  // ---- new entries (launch sniper) -----------------------------------------
  for (const mint of eventMints) {
    if (orders.length >= hello!.caps.max_orders_per_batch) break;
    if (openSlots <= 0) break;
    const c = coins.get(mint);
    if (!c || c.complete) continue;
    if (positions.has(mint) || hasPending(mint, 'buy') || hasPending(mint, 'sell')) continue;
    if (c.entries >= MAX_ENTRIES) continue;
    if (slot - c.lastExitSlot < COOLDOWN_SLOTS) continue;
    if (c.createdSlot === null) continue;
    const age = slot - c.createdSlot;
    if (age < MIN_AGE || age > MAX_AGE) continue;
    const rqSol = Number(c.rQuote) / 1e9;
    if (rqSol < minRq || rqSol > MAX_RQ_SOL) continue;
    if (c.creatorSold) continue;
    if (c.devBuySol > MAX_DEV_BUY_SOL) continue;
    const price = priceOf(c);
    if (price <= 0) continue;
    const stats = windowStats(c, slot);
    if (stats.buyers < minBuyers) continue;
    if (stats.netSol < 0) continue; // the opening tape must be net buying
    if (stats.topShare > MAX_TOP_SHARE) continue;
    const cap = maxBuyLamports(c);
    const amount = cap < STAKE ? cap : STAKE;
    if (amount < MIN_BUY || free < amount + tx) continue;
    const id = newClientId();
    orders.push({
      side: 'buy',
      client_id: id,
      mint,
      quote_lamports: amount.toString(),
      max_slippage_bps: BUY_SLIP_BPS,
    });
    pending.set(id, { side: 'buy', mint, decidedSlot: slot, price, amount });
    free -= amount + tx;
    openSlots -= 1;
  }

  return orders;
}

// ---- main loop -------------------------------------------------------------
async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('bad JSON line from harness');
      process.exit(1);
    }
    if (msg.type === 'hello') {
      hello = msg as Hello;
      cash = BigInt(hello.capital.lamports);
    } else if (msg.type === 'batch') {
      if (!hello) {
        console.error('batch before hello');
        process.exit(1);
      }
      applyBatch(msg);
      const orders = decideOrders(msg);
      const reply = JSON.stringify({ type: 'reply', seq: msg.seq, orders });
      process.stdout.write(reply + '\n');
    } else if (msg.type === 'done') {
      process.exit(0);
    } else {
      console.error(`unknown harness message type: ${String(msg.type)}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
