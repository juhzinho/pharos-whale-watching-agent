# Task 4 — Whale-Watching Agent (Medium · Chain MCP)

Tracks a configurable list of **at least 5 addresses** on Pharos Pacific Mainnet and reports **significant** ERC20 moves as they happen, with context on why each one matters, plus a **summary of recent activity across every watched address**.

Read-only. No wallet, no private key, no sending.

**Live demo:** https://pharos-contract-reader.vercel.app/#whales  
**GitHub:** https://github.com/juhzinho/pharos-whale-watching-agent

## Requirements

| Requirement | How |
|---|---|
| 01 Tracks ≥ 5 configurable addresses | Default watchlist has **8** real mainnet addresses (`watchlist.json`). Change the file, or pass `--add 0x…` / `--watchlist other.json`. The agent refuses to start with fewer than 5 |
| 02 Configurable “significant” threshold per token | Each token has its own `min` (USDC 50, WPROS 20 by default). Override with `--min USDC=200` or a per-address `min` in the JSON. Comparisons use exact integers (`parseUnits`), no floating point |
| 03 Each report explains the move | Block, direction (IN/OUT), kind (TRANSFER/MINT/BURN), amount with decimals, **from**, **to** (labelled when known), full tx hash, and a **“why it matters”** sentence (size vs threshold, whale-to-whale, mint/burn, first seen, opened/exited/passthrough position, labelled counterparty) |
| 04 Summary view of recent activity across all watched addresses | After every `--once` scan (and on Ctrl+C in live mode): per address, move counts, in/out per token, remaining balances, nonce, largest move, and a one-line note — including addresses that were quiet |

## How it talks to Pharos

Chain MCP `https://mcp.pharos.xyz/mcp`:

- `get_logs` **filtered by token contract address and event signature** `Transfer(address,address,uint256)` (`topic0 = 0xddf252ad…b3ef`). Each call is at most 1000 blocks; the agent pages larger `--lookback` values (up to 50,000) in parallel and retries 429s
- `get_block_number` to follow new blocks
- `eth_call` (`decimals`, `symbol`, `balanceOf`) and `get_balance` / `get_transaction_count` for the snapshot on each watched wallet

Live mode polls, re-reads the last 5 blocks in case logs were indexed late, and de-duplicates by `tx hash + log index`.

## Install and run

Requires Node.js 20.12+. From the repository root:

```bash
npm install
npm run whale -- --once --lookback 1000          # scan and exit
npm run whale -- --once --min USDC=200 --links
npm run whale                                    # live, Ctrl+C for a fresh summary
npm run whale -- --add 0xYourWhale --lang pt
```

| Option | Default | Meaning |
|---|---|---|
| `--watchlist <file>` | `watchlist.json` | Addresses + per-token mins |
| `--min TOKEN=amount` | from the file | Override that token’s threshold |
| `--add 0x…` | — | Extra address (repeatable) |
| `--only` | off | Ignore the default 8; watch only `--add` addresses (still ≥ 5) |
| `--lookback` | 1000 | Initial history (1–50,000 blocks, paged at 1000) |
| `--interval` | 5 | Seconds between live checks (min 2) |
| `--once` | off | Scan, print, exit |
| `--lang en\|pt` | en | Report language |
| `--links` | off | Explorer URLs |

## Default watchlist

Eight addresses that were actually moving USDC and/or WPROS on mainnet (largest volume in a 1000-block sample). Edit `watchlist.json` to point the agent at any other set of 5+.

## Example (`npm run whale -- --once --lookback 1000`)

```
SIGNIFICANT  [block 20,338,969] OUT TRANSFER 77.724066 USDC
  Busiest USDC/WPROS flow (0x912c…f647) sent 77.724066 USDC to Second-busiest flow (0x9365…b470).
  Why it matters: at or above the 50 USDC threshold; both sides are on the watchlist (whale-to-whale);
  first activity for this token in the scanned window; counterparty is labelled Second-busiest flow.
  from 0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  to   0x936564245B69f5a293b42cbd752E0eE3bb68b470
  tx   0x62e06d84122bb8a14dc749cc2ca5c5f6f8195a2fd142a6ec81f55c8efa8978ee

SUMMARY — recent activity across every watched address

Busiest USDC/WPROS flow
  0x912c9aDe24D44d8922f0866D8Dcb079f1363f647
  moves 36 (19 significant) · USDC in 1,102.41 / out 1,373.98 / hold 525,200.55
  largest 524.43 WPROS · active this window

Frequent USDC trader
  0x768B959191cE5876cabBbC014a08D72615BDdE54
  USDC in 862.57 / out 862.57 · USDC passed through (in = out)

Large USDC round-trips
  0xB53F6cB429B8e14b6b87362B5a20Ba69FC9C3B47
  moves 0 · quiet this window
```

## Tests

```bash
npm run test:unit          # includes watchlist + explanation cases
npm run test:e2e -- whale  # live mainnet: --once, high threshold, live loop, validation
```
