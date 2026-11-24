[![Pump.fun Bot Sprint](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/asyrof-uye/pump-fun-bot-sprint/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/asyrof-uye/pump-fun-bot-sprint/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint — fee-aware minimal-trade bot

A trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on [make.fun](https://make.fun). It trades paper money on a replay of pump.fun Solana bonding-curve data (`agent-fun/replay/v2`) and is ranked on net PnL.

## Strategy

**Fewer, higher-conviction entries; sell into the spike, then stop.**

- **Entry (first 5 slots of a coin's life, decided from age 1):** buy 0.10 SOL only for the strongest launches — real SOL already ≥ 5, at least 6 distinct buyers in, the opening tape net buying, no single buyer over 50% of buy SOL, and the creator's own buy modest (≤ 1 SOL) with no creator sell. One entry per coin, no pace-relaxation tiers: weak late-window entries are fee burn, and the ≥ 20-coin guardrail is still met 4x over.
- **Exits:** hard take-profit +25% (sell everything); stop-loss −7%; 300-slot hold limit; exit at once on a creator sell or a single ≥ 1.5 SOL sell. No partial banking, no trailing stop — two fills per round trip, not three.
- **Why this shape:** the v2 sniper traded 229 coins and lost −0.33 SOL with gross trading PnL ≈ 0 — fees (0.35 SOL) were most of the loss. Dev-window analysis shows half of all coins never rise above their early price, spikes dump fast (median hold-to-end multiple 0.89x), and longer holds / looser trailing stops lose money on this window. So this variant cuts trade count ~in half and takes profits fast.
- **Risk controls:** at most 5 open positions, 0.10 SOL per coin (capped by the harness 1%-of-real-reserve order cap), 240-slot cooldown after an exit.
- **Deterministic:** no clock, no randomness, no network, no reads outside this repository — the same replay always produces the same orders.

## Run

The grader runs it as `node main.ts` (Node 22, TypeScript stripped natively, zero dependencies). It speaks the replay protocol on stdin/stdout: `hello`, one `batch` per slot (events, marks, fills, account), one `reply` per batch with `buy`/`sell` orders, then `done`.

## Dev result

On the kit's dev window the v3 variant finishes at **−0.18 SOL net PnL** (115 coins, 115 round trips, 37.4% win rate, 3.9% max drawdown, fees 0.27 SOL) — better than v2's −0.33 SOL but **still below holding cash, so it is HELD and not submitted**. Stress test (20 rebuilt copies): median −0.25 SOL, p10 −0.55, p90 −0.07; 18 of 20 copies lost money. The final window is fresh 6-hour data, so the dev score is a robustness check, not a forecast.

## License

MIT — see [LICENSE](LICENSE).
