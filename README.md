# Pharos Whale-Watching Agent

Tracks a configurable list of **at least 5 addresses** on Pharos Pacific Mainnet and reports **significant** ERC20 moves as they happen, with context on why each one matters, plus a **summary of recent activity across every watched address**.

Read-only. No wallet, no private key, no sending.

**Pharos Season of AI** · Medium · Chain MCP

**Live demo:** https://pharos-contract-reader.vercel.app/#whales

## Requirements

| Requirement | How |
|---|---|
| 01 Tracks ≥ 5 configurable addresses | Default watchlist has **8** real mainnet addresses (`watchlist.json`). Change the file, or pass `--add 0x…` / `--watchlist other.json`. The agent refuses `--only` with fewer than 5 |
| 02 Configurable “significant” threshold per token | Each token has its own `min` (USDC 50, WPROS 20 by default). Override with `--min USDC=200` or a per-address `min` in the JSON. Comparisons use exact integers (`parseUnits`), no floating point |
| 03 Each report explains the move | Block, direction (IN/OUT), kind (TRANSFER/MINT/BURN), amount with decimals, **from**, **to** (labelled when known), full tx hash, and a **“why it matters”** sentence (size vs threshold, whale-to-whale, mint/burn, first seen, opened/exited/passthrough position, labelled counterparty) |
| 04 Summary view of recent activity across all watched addresses | After every `--once` scan (and on Ctrl+C in live mode): per address, move counts, in/out per token, remaining balances, nonce, largest move, and a one-line note — including addresses that were quiet. Transfers below the min are counted and named, not dropped |

## How it talks to Pharos

Chain MCP `https://mcp.pharos.xyz/mcp`:

- `get_logs` **filtered by token contract, event signature** `Transfer(address,address,uint256)` (`topic0 = 0xddf252ad…b3ef`), **and the watched addresses as topic1 (from) / topic2 (to)** so busy tokens do not hide the wallets. Window split at 1000 blocks
- `get_block_number` to follow new blocks
- `eth_call` (`decimals`, `symbol`, `balanceOf`) and `get_balance` / `get_transaction_count` for the snapshot on each watched wallet

Each watched side of a transfer is scored with **that address’s own min**. Whale-to-whale transfers emit an OUT row and an IN row. Live mode polls, re-reads the last 5 blocks in case logs were indexed late, and de-duplicates by `tx hash + log index + direction + whale`.

## Install and run

Requires Node.js 20.12+.

```bash
npm install
npm start -- --once --lookback 1000          # scan and exit
npm start -- --once --min USDC=200 --links
npm start                                    # live, Ctrl+C for a fresh summary
npm start -- --add 0xYourWhale --lang pt
```

| Option | Default | Meaning |
|---|---|---|
| `--watchlist <file>` | `watchlist.json` | Addresses + per-token mins |
| `--min TOKEN=amount` | from the file | Override that token’s threshold |
| `--add 0x…` | — | Extra address (repeatable) |
| `--only` | off | Ignore the default 8; watch only `--add` addresses (still ≥ 5) |
| `--lookback` | 1000 | Initial history (1–1000 blocks) |
| `--interval` | 5 | Seconds between live checks (min 2) |
| `--once` | off | Scan, print, exit |
| `--lang en\|pt` | en | Report language |
| `--links` | off | Explorer URLs |

## Default watchlist

Eight addresses that were actually moving USDC and/or WPROS on mainnet (largest volume in a 1000-block sample). Edit `watchlist.json` to point the agent at any other set of 5+.

## Example (`npm start -- --once --lookback 300`)

```
SIGNIFICANT  [block 20,341,290] OUT TRANSFER 77.761964 USDC
  Busiest USDC/WPROS flow (0x912c…f647) sent 77.761964 USDC to Second-busiest flow (0x9365…b470).
  Why it matters: at or above the 50 USDC threshold; both sides are on the watchlist (whale-to-whale);
  first activity for this token in the scanned window; counterparty is labelled Second-busiest flow.
  from 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  to   0x936564245B69f5a293b42cbd752E0eE3bb68b470
  tx   0xb1e5636e267fcbbb4af574b7b7e5b8e7335a5659f0461d865e588dae318566a5

SUMMARY — recent activity across every watched address

Busiest USDC/WPROS flow
  0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  moves 4 (4 significant) · USDC in 0 / out 388.72 / hold 525,083.94
  largest 524.34 WPROS · opened or added a WPROS position

Frequent USDC trader
  0x768B959191cE5876cabBbC014a08D72615BDdE54
  USDC in 251.98 / out 251.98 · USDC passed through (in = out)

Large USDC round-trips
  0xB53F6cB429B8e14b6b87362B5a20Ba69FC9C3B47
  moves 0 · quiet this window
```

## Tests

```bash
npm test            # unit + live mainnet e2e
npm run test:unit   # watchlist, thresholds, explanations
npm run test:e2e    # --once, high threshold, live loop, validation
```
