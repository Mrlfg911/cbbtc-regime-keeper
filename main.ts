// cbBTC regime follower: holds cbBTC while the trend is up, sits in cash while it is not,
// and steps aside on a volatility-scaled trailing stop. One asset, long only, no leverage.
//
// Rules, all read from the only bar this reply answers and the closes before it:
//   - fast and slow EMAs of the close, 45 and 240 bars, seeded on their first span.
//   - entry (fills at the next open): fast above slow by ENTRY_MARGIN_BPS, and the close above
//     the slow EMA, and enough history for both.
//   - exit, the whole position, on any of: fast below slow by EXIT_MARGIN_BPS (a regime flip,
//     with hysteresis so a flat market does not churn), the close past a trailing stop of
//     TRAIL_BPS under the highest close since entry, or ATR(60) over the close above the entry
//     ATR by SPIKE_MULT, which is a volatility break the stop would otherwise ride down.
//   - a re-entry waits COOLDOWN_BARS after an exit.
//   - the reply carries at most one order. Slippage is capped at MAX_SLIPPAGE_BPS.
//
// Deterministic: float64 arithmetic on + - * / only, no clock, no random, no environment.

import { BPS, runBars, type BarsState, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST = 45;
const SLOW = 240;
const ATR_SPAN = 60;
const ENTRY_MARGIN_BPS = 12;
const EXIT_MARGIN_BPS = 10;
const TRAIL_BPS = 320;
const SPIKE_MULT = 2.4;
const COOLDOWN_BARS = 45;
const MAX_SLIPPAGE_BPS = 120;
const BPS_NUM = 10_000;

interface Ema { span: number; count: number; value: number | null }
function newEma(span: number): Ema { return { span, count: 0, value: null }; }
function pushEma(e: Ema, x: number): void {
  if (e.value === null) {
    e.count += 1;
    if (e.count >= e.span) e.value = x; // seeded on the span-th close
    return;
  }
  const k = 2 / (e.span + 1);
  e.value = e.value + k * (x - e.value);
}

const fast = newEma(FAST);
const slow = newEma(SLOW);

let prevClose: number | null = null;
/** Rolling sum of |close - previous close|, the ATR proxy in price units. */
const ranges: number[] = [];
let rangeSum = 0;
let atrAtEntry: number | null = null;
let heldHigh: number | null = null;
let cooldown = 0;
let lastSide: 'flat' | 'long' = 'flat';

function atr(): number | null {
  if (ranges.length < ATR_SPAN) return null;
  return rangeSum / ranges.length;
}

function onBatch(state: BarsState, batch: { bars: Bar[] }): BuyInput[] | SellInput[] {
  const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
  if (!bar) return [];
  const close = Number(BigInt(bar.c)) / 1e5; // price_scale 5: USDC per unit

  if (prevClose !== null) {
    const r = Math.abs(close - prevClose);
    ranges.push(r);
    rangeSum += r;
    if (ranges.length > ATR_SPAN) rangeSum -= ranges.shift() as number;
  }
  prevClose = close;

  pushEma(fast, close);
  pushEma(slow, close);

  const holding = state.positions.find((p) => p.symbol === 'CBBTC');
  const held = holding !== undefined && BigInt(holding.qty) > 0n;
  if (!held) { heldHigh = null; atrAtEntry = null; }
  if (cooldown > 0) cooldown -= 1;

  const f = fast.value;
  const s = slow.value;
  if (f === null || s === null) return [];

  const gapBps = ((f - s) / s) * BPS_NUM;
  const a = atr();

  if (held) {
    if (heldHigh === null) heldHigh = close;
    if (close > heldHigh) heldHigh = close;
    const trailBps = heldHigh > 0 ? ((heldHigh - close) / heldHigh) * BPS_NUM : 0;
    const spike = a !== null && atrAtEntry !== null && atrAtEntry > 0 && a > atrAtEntry * SPIKE_MULT;
    if (gapBps < -EXIT_MARGIN_BPS || trailBps > TRAIL_BPS || spike) {
      cooldown = COOLDOWN_BARS;
      lastSide = 'flat';
      return [{ side: 'sell', symbol: 'CBBTC', qty: holding!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  if (cooldown === 0 && gapBps > ENTRY_MARGIN_BPS && close > s) {
    const cash = BigInt(state.account.cash_quote_units);
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (cash / 50n < minNotional) return [];
    const spend = (cash * 95n) / 100n; // keep 5% back for the fee and the impact
    if (spend < minNotional) return [];
    heldHigh = close;
    atrAtEntry = a;
    lastSide = 'long';
    return [{ side: 'buy', symbol: 'CBBTC', notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

runBars({ onBatch });
