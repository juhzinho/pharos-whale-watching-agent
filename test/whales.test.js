import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WATCHLIST, MIN_WATCHED, parseWatchlist, thresholdOf } from "../lib/watchlist.js";
import { collectMoves, explainMove, noteFor } from "../lib/whales.js";
import { LOG_WINDOW, MAX_LOOKBACK, MAX_LOOKBACK_API, logWindows, lookbackFrom, topicAddress } from "../lib/transfers.js";
import { TOKENS } from "../lib/tokens.js";

test("default watchlist has at least 5 labelled addresses and two tokens", () => {
  const w = parseWatchlist();
  assert.ok(w.addresses.length >= MIN_WATCHED);
  assert.equal(w.tokens.length, 2);
  assert.equal(w.tokens[0].symbol, "USDC");
  assert.equal(w.tokens[1].symbol, "WPROS");
  for (const a of w.addresses) {
    assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(a.label.en);
    assert.ok(a.label.pt);
  }
});

test("rejects fewer than 5 addresses", () => {
  assert.throws(
    () => parseWatchlist({ addresses: DEFAULT_WATCHLIST.addresses.slice(0, 4) }),
    /at least 5/
  );
});

test("rejects an invalid address and a bad --min", () => {
  assert.throws(() => parseWatchlist({ addresses: [...DEFAULT_WATCHLIST.addresses, "0x123"] }), /not a valid address/);
  assert.throws(() => parseWatchlist(undefined, { mins: { USDC: "nope" } }), /must be a non-negative number/);
  assert.throws(() => parseWatchlist(undefined, { mins: { USDT: "1" } }), /not in the watchlist/);
});

test("1–4 extra addresses are appended to the default 8", () => {
  const extra = "0xe7368221de15a7c5e0a50a95317b06e6d08c3861";
  const w = parseWatchlist(undefined, { extraAddresses: [extra] });
  assert.equal(w.addresses.length, DEFAULT_WATCHLIST.addresses.length + 1);
  assert.ok(w.addresses.some((a) => a.address.toLowerCase() === extra.toLowerCase()));
});

test("a custom list of 5+ addresses replaces the default 8", () => {
  const custom = DEFAULT_WATCHLIST.addresses.slice(3, 8).map((a) => a.address);
  const w = parseWatchlist({ addresses: custom });
  assert.equal(w.addresses.length, 5);
  assert.equal(
    w.addresses.some((a) => a.address.toLowerCase() === DEFAULT_WATCHLIST.addresses[0].address.toLowerCase()),
    false
  );
});

test("checksums, de-duplicates and applies per-token and per-address thresholds", () => {
  const extra = DEFAULT_WATCHLIST.addresses[0].address.toLowerCase();
  const w = parseWatchlist(
    {
      tokens: [
        { symbol: "USDC", min: "50" },
        { symbol: "WPROS", min: "20" },
      ],
      addresses: [
        ...DEFAULT_WATCHLIST.addresses,
        { address: extra, label: "duplicate" },
        { address: "0x9F8Ea09770Dc38fc61f5a62031b3BE0526D54D92", label: "owner", min: { USDC: "500" } },
      ],
    },
    { mins: { USDC: "80" } }
  );
  assert.equal(w.tokens.find((t) => t.symbol === "USDC").min, "80");
  const owner = w.addresses.find((a) => a.address.toLowerCase() === "0x9f8ea09770dc38fc61f5a62031b3be0526d54d92");
  assert.equal(owner.address, "0x9F8Ea09770Dc38fc61f5a62031b3BE0526D54D92");
  assert.equal(thresholdOf(owner, w.tokens[0]), "500");
  assert.equal(thresholdOf(w.addresses[0], w.tokens[0]), "80");
  assert.equal(w.addresses.filter((a) => a.address.toLowerCase() === extra.toLowerCase()).length, 1);
});

function move(over = {}) {
  return {
    direction: "out",
    kind: "transfer",
    amount: "600",
    symbol: "USDC",
    whaleName: "Busiest flow (0x912c…f647)",
    fromName: "Busiest flow (0x912c…f647)",
    toName: "0x86C8…F95f",
    value: 600n * 10n ** 6n,
    threshold: 50n * 10n ** 6n,
    minHuman: "50",
    whaleToWhale: false,
    firstSeen: false,
    position: null,
    counterpartyLabel: null,
    ...over,
  };
}

test("explanation includes amount, destination and why it matters (en + pt)", () => {
  const en = explainMove(move({ firstSeen: true }), "en");
  assert.match(en, /Busiest flow/);
  assert.match(en, /sent 600 USDC to 0x86C8/);
  assert.match(en, /Why it matters/);
  assert.match(en, /12× the configured threshold/);
  assert.match(en, /first activity/);
  const pt = explainMove(move({ firstSeen: true }), "pt");
  assert.match(pt, /enviou 600 USDC/);
  assert.match(pt, /Por que importa/);
});

function sampleList(overrides = {}) {
  return parseWatchlist({
    tokens: [
      { symbol: "USDC", address: TOKENS.USDC, min: "50" },
      { symbol: "WPROS", address: TOKENS.WPROS, min: "20" },
    ],
    addresses: DEFAULT_WATCHLIST.addresses.slice(0, 5),
    ...overrides,
  });
}

function tokenRows(list, usdcTransfers = [], wprosTransfers = []) {
  return list.tokens.map((t) => ({
    ...t,
    decimals: t.symbol === "USDC" ? 6 : 18,
    transfers: t.symbol === "USDC" ? usdcTransfers : wprosTransfers,
  }));
}

test("topicAddress pads an indexed Transfer topic", () => {
  assert.equal(
    topicAddress("0x912c9aDe24D44d8922f0866D8Dcb079f1363f647"),
    "0x000000000000000000000000912c9ade24d44d8922f0866d8dcb079f1363f647"
  );
});

test("sub-threshold transfers count as seen, not significant, and the note names the largest", () => {
  const list = sampleList();
  const whale = list.addresses[0];
  const { moves, stats, matched } = collectMoves(
    list,
    tokenRows(list, [
      {
        block: 10,
        logIndex: 1,
        tx: "0xabc",
        from: "0x1111111111111111111111111111111111111111",
        to: whale.address,
        value: 1_620_000n,
        kind: "transfer",
      },
      {
        block: 11,
        logIndex: 0,
        tx: "0xdef",
        from: whale.address,
        to: "0x1111111111111111111111111111111111111111",
        value: 2_770_000n,
        kind: "transfer",
      },
    ])
  );
  const stat = stats.get(whale.address.toLowerCase());
  assert.equal(matched, 2);
  assert.equal(moves.length, 0);
  assert.equal(stat.seen, 2);
  assert.equal(stat.significant, 0);
  const notes = noteFor(whale, stat, undefined, tokenRows(list));
  assert.match(notes.en, /2 transfer\(s\) below the min/);
  assert.match(notes.en, /2\.77 USDC/);
  assert.match(notes.pt, /abaixo do mínimo/);
});

test("whale-to-whale over the min reports both sides with that address's own threshold", () => {
  const a = DEFAULT_WATCHLIST.addresses[0];
  const b = DEFAULT_WATCHLIST.addresses[1];
  const list = parseWatchlist({
    tokens: [
      { symbol: "USDC", address: TOKENS.USDC, min: "50" },
      { symbol: "WPROS", address: TOKENS.WPROS, min: "20" },
    ],
    addresses: [
      { address: a.address, min: { USDC: "500" } },
      ...DEFAULT_WATCHLIST.addresses.slice(1, 5),
    ],
  });
  const { moves, stats } = collectMoves(
    list,
    tokenRows(list, [
      {
        block: 20,
        logIndex: 3,
        tx: "0xeee",
        from: a.address,
        to: b.address,
        value: 100_000_000n,
        kind: "transfer",
      },
    ])
  );
  assert.equal(stats.get(a.address.toLowerCase()).significant, 0);
  assert.equal(stats.get(b.address.toLowerCase()).significant, 1);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].direction, "in");
  assert.equal(moves[0].whale.toLowerCase(), b.address.toLowerCase());
  assert.equal(moves[0].whaleToWhale, true);
});

test("explanation flags whale-to-whale, mint, burn, exit and passthrough", () => {
  assert.match(explainMove(move({ whaleToWhale: true }), "en"), /whale-to-whale/);
  assert.match(explainMove(move({ kind: "mint", direction: "in" }), "en"), /minted/);
  assert.match(explainMove(move({ kind: "burn" }), "en"), /burned/);
  assert.match(explainMove(move({ position: "exit" }), "en"), /exit/);
  assert.match(explainMove(move({ position: "opened" }), "en"), /position/);
  assert.match(explainMove(move({ position: "passthrough" }), "en"), /passed through/);
  assert.match(explainMove(move({ counterpartyLabel: "Circle" }), "en"), /labelled Circle/);
});

test("logWindows pages a span into 1000-block MCP calls", () => {
  assert.equal(LOG_WINDOW, 1000);
  assert.equal(MAX_LOOKBACK, 50_000);
  assert.equal(MAX_LOOKBACK_API, 10_000);
  const w = logWindows(100, 2500);
  assert.equal(w.length, 3);
  assert.deepEqual(w[0], { fromBlock: 100, toBlock: 1099 });
  assert.deepEqual(w[1], { fromBlock: 1100, toBlock: 2099 });
  assert.deepEqual(w[2], { fromBlock: 2100, toBlock: 2500 });
  assert.deepEqual(logWindows(5, 4), []);
  assert.equal(logWindows(1, 50_000).length, 50);
});

test("lookbackFrom never exceeds the requested window on live catch-up", () => {
  assert.equal(lookbackFrom(10_000, 1000), 9001);
  assert.equal(lookbackFrom(10_000, 5000, 9990, 5), 9986);
  assert.equal(lookbackFrom(10_000, 300, 100, 5), 9701);
  assert.equal(lookbackFrom(50, 1000), 0);
});
