[![Pump.fun Bot Sprint](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/asyrof-uye/pump-fun-bot-sprint/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/asyrof-uye/pump-fun-bot-sprint/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint — launch sniper bot

A trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on [make.fun](https://make.fun). It trades paper money on a replay of pump.fun Solana bonding-curve data (`agent-fun/replay/v2`) and is ranked on net PnL.

## Strategy

**Snipe launches, cut losers fast, bank half and let the rest ride.**

- **Entry (first 5 slots of a coin's life):** buy 0.06 SOL only when real SOL has already reached ≥ 2 SOL, at least 3 distinct buyers are in, the opening tape is net buying, no single buyer dominates (> 60% of buy SOL), and the creator's own buy is modest (≤ 1 SOL) with no creator sell.
- **Exits:** stop-loss −7%; bank half the position at +30%; the rest rides a trailing stop (15% below the peak once up 30%); hard 120-slot hold limit; exit at once on a creator sell or a single ≥ 1.5 SOL sell.
- **Risk controls:** at most 5 open positions, 0.06 SOL per coin, at most 2 entries per coin, 240-slot cooldown after an exit, and a deterministic pace relaxation (from block time only) so the ≥ 20-coin guardrail is met even on a quiet tape.
- **Deterministic:** no clock, no randomness, no network, no reads outside this repository — the same replay always produces the same orders.

## Run

The grader runs it as `node main.ts` (Node 22, TypeScript stripped natively, zero dependencies). It speaks the replay protocol on stdin/stdout: `hello`, one `batch` per slot (events, marks, fills, account), one `reply` per batch with `buy`/`sell` orders, then `done`.

## Dev result

On the kit's dev window the bot finishes at −0.33 SOL net PnL (229 coins, 29.7% win rate, 3.7% max drawdown, top-3 coins 19% of gains) — the best of every approach tried here (the kit's momentum, sniper and reversion pilots all lose more on the same window), with the loss driven mostly by fees (0.35 SOL). The final window is fresh 6-hour data, so the dev score is a robustness check, not a forecast.

## License

MIT — see [LICENSE](LICENSE).
