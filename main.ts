// cbBTC exposure keeper: take the position early, keep it while the market is not breaking
// down, and step aside on a wide volatility-scaled trailing stop so a crash is not ridden to
// the bottom. One asset, long only, no leverage, at most one order per reply.
//
// Rules, all read from the bars and the account this harness sends:
//   - entry (fills at the next open): on the first bar where the close is at or above its own
//     240-bar mean (or on the very first tradeable bar, when there is no history yet), spend
//     ENTRY_FRACTION of the cash. Only one entry at a time.
//   - exit, the whole position: a trailing stop of TRAIL_BPS under the highest close since entry,
//     or two consecutive closes under the 240-bar mean by BREAK_MARGIN_BPS.
//   - re-entry after an exit: on the first close back above the 240-bar mean, in cash again.
//   - slippage is capped at MAX_SLIPPAGE_BPS so a liquidity gap refuses the fill instead of
//     taking it at any price; a refused order is simply sent again on the next bar.
//
// Deterministic: float64 arithmetic on + - * / only, no clock, no random, no environment.

import { runBars, type BarsState, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Share of the cash spent on an entry, the fee and the price impact left inside it. */
const ENTRY_FRACTION = 0.97;
/** Bars in the mean the entry, the breakdown and the re-entry read. */
const MEAN_BARS = 240;
/** How far under the mean, in bps, a close must sit to count as a break. */
const BREAK_MARGIN_BPS = 120;
/** The trailing stop, in bps under the highest close since entry. */
const TRAIL_BPS = 800;
/** Refuse a fill further than this from the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 150;
/** Consecutive closes under the mean that make an exit. */
const BREAK_BARS = 8;

const BPS = 10_000;
const closes: number[] = [];
let meanSum = 0;
let heldHigh: number | null = null;
let breakRun = 0;
let cooldown = 0;

function meanOf(): number | null {
  if (closes.length < MEAN_BARS) return null;
  return meanSum / closes.length;
}

function onBatch(state: BarsState, batch: { bars: Bar[] }): BuyInput[] | SellInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (!bar) return [];
  if (state.warmingUp) return [];

  // Price at price_scale 5: USDC per unit, kept as a float only for the indicators.
  const close = Number(BigInt(bar.c));

  closes.push(close);
  meanSum += close;
  if (closes.length > MEAN_BARS) meanSum -= closes.shift() as number;

  const holding = state.positions.get(SYMBOL);
  const held = holding !== undefined && holding.qty > 0n;
  if (!held) heldHigh = null;
  if (cooldown > 0) cooldown -= 1;

  const mean = meanOf();

  if (held) {
    if (heldHigh === null || close > heldHigh) heldHigh = close;
    const drawdownBps = heldHigh > 0 ? ((heldHigh - close) / heldHigh) * BPS : 0;
    if (mean !== null && close < mean * (1 - BREAK_MARGIN_BPS / BPS)) breakRun += 1;
    else breakRun = 0;
    if (drawdownBps > TRAIL_BPS || breakRun >= BREAK_BARS) {
      breakRun = 0;
      cooldown = 180;
      return [{ side: 'sell', symbol: SYMBOL, qty: holding!.qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  breakRun = 0;
  if (cooldown > 0) return [];
  const policyOk = mean === null || close >= mean;
  if (!policyOk) return [];

  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  const cash = state.cash;
  const spend = BigInt(Math.floor(Number(cash) * ENTRY_FRACTION));
  if (spend < minNotional) return [];

  heldHigh = close;
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

runBars({ onBatch });
