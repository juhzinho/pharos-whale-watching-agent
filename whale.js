#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAddress } from "viem";
import { connect, isTransient, takeCallLog, CHAIN_MCP_URL } from "./lib/mcp.js";
import { MAX_WINDOW } from "./lib/transfers.js";
import { parseWatchlist } from "./lib/watchlist.js";
import { latestBlock, presentMove, presentSummary, watchWindow } from "./lib/whales.js";

function summarizeCalls(names) {
  const counts = names.reduce((acc, n) => ((acc[n] = (acc[n] ?? 0) + 1), acc), {});
  return Object.entries(counts)
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join(", ");
}

const DEFAULT_LIST = new URL("./watchlist.json", import.meta.url);
const OVERLAP = 5;
const HEARTBEAT_MS = 60_000;

const USAGE = `Usage: node whale.js [options]

Watches a configurable list of at least 5 addresses for significant ERC20
moves on Pharos Pacific Mainnet through Chain MCP (get_logs filtered by
token contract, Transfer event signature, and watched from/to). Reports
each new significant move with from, to, amount, tx hash, block, and why
it matters, then a summary across every watched address.

Options:
  --watchlist <file>     JSON watchlist (default: watchlist.json)
  --min <TOKEN=amount>   override that token's significance threshold (repeatable)
  --add <0x…>            extra address to watch (repeatable; still need ≥ 5 in total)
  --only                 ignore the default 8 and watch only the --add addresses (need ≥ 5)
  --lookback <blocks>    initial history, 1 to ${MAX_WINDOW} (default 1000)
  --interval <s>         seconds between live checks (default 5, minimum 2)
  --once                 scan the window, print the report and exit
  --lang en|pt           language of the report (default en)
  --links                print explorer URLs
  --help`;

function fail(message) {
  console.log(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { watchlist: DEFAULT_LIST, mins: {}, extra: [], lookback: 1000, interval: 5, once: false, lang: "en", links: false, only: false };
  const numeric = (flag, value) => {
    if (value === undefined || value.startsWith("--") || !/^\d+(\.\d+)?$/.test(value)) fail(`${flag} needs a number.`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--watchlist") {
      const file = argv[++i];
      if (!file || file.startsWith("--")) fail("--watchlist needs a file path.");
      opts.watchlist = file;
    } else if (a === "--min") {
      const spec = argv[++i];
      const m = spec?.match(/^([A-Za-z0-9]+)=(\d+(?:\.\d+)?)$/);
      if (!m) fail('--min must look like USDC=100 (token=amount).');
      opts.mins[m[1].toUpperCase()] = m[2];
    } else if (a === "--add") {
      const addr = argv[++i];
      if (!isAddress(addr)) fail(`--add needs a valid address (got ${addr}).`);
      opts.extra.push(addr);
    } else if (a === "--lookback") opts.lookback = Number(numeric(a, argv[++i]));
    else if (a === "--interval") opts.interval = Number(numeric(a, argv[++i]));
    else if (a === "--once") opts.once = true;
    else if (a === "--only") opts.only = true;
    else if (a === "--links") opts.links = true;
    else if (a === "--lang") {
      const lang = argv[++i];
      if (lang !== "en" && lang !== "pt") fail("--lang must be en or pt.");
      opts.lang = lang;
    } else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith("--")) fail(`Unknown option: ${a}`);
    else fail(`Unexpected argument: ${a}`);
  }
  if (opts.interval < 2) fail("--interval must be at least 2 seconds.");
  if (!Number.isInteger(opts.lookback) || opts.lookback < 1 || opts.lookback > MAX_WINDOW) {
    fail(`--lookback must be an integer from 1 to ${MAX_WINDOW}.`);
  }
  return opts;
}

function loadJson(path) {
  try {
    const file = typeof path === "string" ? path : path.pathname ? path : path;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") fail(`watchlist file not found: ${path}`);
    fail(`could not read watchlist: ${e.message}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
let watchlist;
try {
  watchlist = opts.only
    ? parseWatchlist({ addresses: opts.extra }, { mins: opts.mins })
    : parseWatchlist(loadJson(opts.watchlist), { mins: opts.mins, extraAddresses: opts.extra });
} catch (e) {
  fail(e.message);
}

let client;
try {
  client = await connect(CHAIN_MCP_URL, "pharos-whale-watching-agent");
} catch (e) {
  console.error(`Error: could not connect to Chain MCP (${e.message})`);
  process.exit(1);
}

const lang = opts.lang;
const reported = new Map();
let lastOutput = Date.now();

function printMoves(moves, live) {
  for (const move of moves) {
    if (reported.has(move.key)) continue;
    reported.set(move.key, move.block);
    const view = presentMove(move, lang);
    const prefix = live ? "NEW " : "";
    console.log(`\n${prefix}SIGNIFICANT  ${view.headline}`);
    console.log(`  ${view.why}`);
    console.log(`  from ${move.from}`);
    console.log(`  to   ${move.to}`);
    console.log(`  tx   ${opts.links ? view.explorer : move.tx}`);
    lastOutput = Date.now();
  }
  for (const [key, block] of reported) if (block < (head ?? 0) - OVERLAP * 2) reported.delete(key);
}

function printSummary(result) {
  const rows = presentSummary(result.summary, result.tokens, lang);
  console.log(lang === "pt" ? "\nRESUMO — atividade recente de todos os endereços vigiados\n" : "\nSUMMARY — recent activity across every watched address\n");
  for (const row of rows) {
    const flows = row.flows.map((f) => `${f.symbol} in ${f.in} / out ${f.out}${f.hold != null ? ` / hold ${f.hold}` : ""}`).join(" · ");
    console.log(`${row.name}`);
    console.log(`  ${row.address}${opts.links ? `  ${row.explorer}` : ""}`);
    console.log(
      `  moves ${row.seen} (${row.significant} significant) · last block ${row.lastBlock}` +
        (row.nonce != null ? ` · nonce ${row.nonce}` : "") +
        (row.pros != null ? ` · ${row.pros} PROS` : "")
    );
    console.log(`  ${flows}`);
    console.log(`  largest ${row.largest} · ${row.notes}`);
    console.log("");
  }
}

function printHeader(head, firstBlock) {
  console.log(`Watching ${watchlist.addresses.length} addresses on Pharos Pacific Mainnet via Chain MCP`);
  for (const t of watchlist.tokens) {
    console.log(`  ${t.symbol} ${t.address}  min ${t.min} ${t.symbol}  get_logs topic0 Transfer(address,address,uint256)`);
  }
  console.log(`  lookback ${opts.lookback} blocks · interval ${opts.interval}s · lang ${lang}`);
  console.log(`  window ${firstBlock} → ${head}\n`);
}

let head;
takeCallLog(client);

async function scan(fromBlock, toBlock, { live, balances }) {
  const result = await watchWindow(client, watchlist, { fromBlock, toBlock, balances });
  printMoves(result.moves, live);
  return result;
}

try {
  head = await latestBlock(client);
} catch (e) {
  console.error(
    isTransient(e)
      ? `Error: Chain MCP is not responding right now (${e.message}). Try again in a few seconds.`
      : `Error: ${e.message}`
  );
  process.exit(1);
}

const firstBlock = Math.max(0, head - opts.lookback + 1);
printHeader(head, firstBlock);

let result;
try {
  result = await scan(firstBlock, head, { live: false, balances: opts.once });
} catch (e) {
  console.error(`Error reading history: ${e.message}`);
  process.exit(1);
}

if (opts.once) {
  printSummary(result);
  const calls = takeCallLog(client);
  console.log(`Chain MCP: ${summarizeCalls(calls)} (${calls.length})`);
  console.log(`Blocks ${firstBlock} to ${head} checked. ${result.moves.length} significant moves, ${result.matched} transfers touched a watched address.`);
  await client.close().catch(() => {});
  process.exit(0);
}

printSummary(result);
console.log(`— history loaded (up to block ${head}). Watching for new significant moves… (Ctrl+C to stop)\n`);
lastOutput = Date.now();

process.on("SIGINT", async () => {
  try {
    printSummary(await watchWindow(client, watchlist, { fromBlock: firstBlock, toBlock: head, balances: true }));
  } catch {
    /* still exit */
  }
  await client.close().catch(() => {});
  process.exit(0);
});

let failures = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, opts.interval * 1000));
  try {
    const next = await latestBlock(client);
    if (next > head) {
      const from = Math.max(firstBlock, head + 1 - OVERLAP);
      await scan(from, next, { live: true, balances: false });
      head = next;
    }
    failures = 0;
    if (Date.now() - lastOutput >= HEARTBEAT_MS) {
      console.log(`  (still watching — block ${head}, no new significant moves in the last minute)`);
      lastOutput = Date.now();
    }
  } catch (e) {
    failures++;
    console.error(`Warning: ${e.message} — retrying next cycle (${failures} failure(s) in a row)`);
  }
}
