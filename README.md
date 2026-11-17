# cbbtc-regime-keeper

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/Mrlfg911/cbbtc-regime-keeper/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/Mrlfg911/cbbtc-regime-keeper/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A cbBTC/USDC bot for make.fun's 24-hour BTC race: it holds cbBTC while the market is not
breaking down and steps aside into cash when it is, so it keeps exposure through an up move
without paying the fees of a bot that trades every cross.

## Strategy

One asset (CBBTC, priced in USDC from its Orca Whirlpool), long only, no leverage, at most one
position and at most one order per reply.

- **Entry** (fills at the next bar's open): on the first bar whose close is at or above its own
  240-bar mean, spend 97% of the cash. Before 240 bars of history (an empty warm-up, or the very
  first bars of the window) that test passes on the first tradeable bar.
- **Exit**, the whole position, on either of:
  - a trailing stop 800 bps under the highest close since entry;
  - 8 consecutive closes at least 120 bps under the 240-bar mean, which is a regime break rather
    than a single wick.
- **Re-entry**: after an exit the bot waits 180 bars before it may buy again, so a choppy tape is
  not churned, and it only buys back once the close is at or above the mean again.
- **Slippage**: every order caps its `max_slippage_bps` at 150, so a liquidity gap refuses the
  fill instead of taking it at any price; a refused order is simply decided again on the next bar.
- No wall clock, no randomness, no environment: every run on the same bars makes the same orders.

The reasoning behind the shape is in the commit history and in the transcripts: on the published
dev window a fast cross bot lost 100+ USDC purely to fees and price impact, a buy-and-hold made
about 1 USDC, and anything that round-trips more than a handful of times cannot beat the 4 bps fee
plus 2 bps slippage plus pool impact. So the bot trades rarely and only steps out on a real break.

## Run it

```sh
node /bot/main.ts
```

The harness speaks `agent-fun/bars-replay/v1` on stdin/stdout: one `hello`, one `batch` per
minute, then `done`, and the bot answers each batch with exactly one reply. Locally, from an
unpacked kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/cbbtc-regime-keeper --driver process
```

`vendor/makefun-bars.ts` is a byte-identical copy of the kit's `sdk/makefun-bars.ts` shim, and the
only file the bot imports from.

## Layout

```
main.ts               the bot: indicators, the entry/exit rules, the reply
vendor/makefun-bars.ts the protocol shim (kit SDK copy, unmodified)
LICENSE               MIT
.makefun/owner.json   the wallet this entry signs with
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
