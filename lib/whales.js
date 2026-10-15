import { decodeFunctionResult, encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { callJson } from "./mcp.js";
import { explorerAddress, explorerTx, formatAmount, formatInteger, labelOf, short } from "./format.js";
import { fetchTransfers, latestBlock, readTokenInfo, TRANSFER_TOPIC, transferKey } from "./transfers.js";
import { labelsMap, pickLabel, thresholdOf } from "./watchlist.js";

export { TRANSFER_TOPIC, latestBlock };

function extraString(labels, address, lang) {
  const hit = labels[address.toLowerCase()];
  return pickLabel(hit, lang) ?? undefined;
}

function labeledWhale(address, labels, lang) {
  const name = extraString(labels, address, lang) ?? labelOf(address, {}, lang);
  return name ? `${name} (${short(address)})` : short(address);
}

async function tokenBalance(client, token, holder, block) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  const { result } = await callJson(client, "eth_call", { transaction: { to: token, data }, block });
  if (!result || result === "0x") return 0n;
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result });
}

async function snapshotWhales(client, watchlist, tokens, block) {
  const snapshots = await Promise.all(
    watchlist.addresses.map(async (whale) => {
      const results = await Promise.allSettled([
        callJson(client, "get_balance", { address: whale.address, block }),
        callJson(client, "get_transaction_count", { address: whale.address, block }),
        ...tokens.map((t) => tokenBalance(client, t.address, whale.address, block)),
      ]);
      const valueOf = (i, fallback) => (results[i].status === "fulfilled" ? results[i].value : fallback);
      const native = valueOf(0, {});
      const nonce = valueOf(1, {});
      const wei = native.balanceWei ?? native.balance ?? native.result ?? native.value ?? "0";
      const count = nonce.transactionCount ?? nonce.count ?? nonce.result ?? nonce.nonce ?? 0;
      const balances = { PROS: BigInt(wei || 0) };
      tokens.forEach((t, i) => {
        const v = valueOf(i + 2, 0n);
        balances[t.symbol] = typeof v === "bigint" ? v : 0n;
      });
      return { address: whale.address, native: balances.PROS, nonce: Number(count) || 0, balances };
    })
  );
  return new Map(snapshots.map((s) => [s.address.toLowerCase(), s]));
}

function emptyStats(tokens) {
  const zero = Object.fromEntries(tokens.map((t) => [t.symbol, 0n]));
  return { seen: 0, significant: 0, in: { ...zero }, out: { ...zero }, volume: { ...zero }, lastBlock: 0, largest: null };
}

function recordStat(stat, token, direction, value, meta) {
  stat.seen++;
  if (meta.significant) stat.significant++;
  stat.volume[token.symbol] += value;
  stat[direction][token.symbol] += value;
  if (meta.block >= stat.lastBlock) stat.lastBlock = meta.block;
  if (!stat.largest || value > stat.largest.value) stat.largest = { ...meta, value, symbol: token.symbol };
}

function positionOf(stat, token, endBalance) {
  const inn = stat.in[token.symbol] ?? 0n;
  const out = stat.out[token.symbol] ?? 0n;
  if (inn === 0n && out === 0n) return null;
  if (endBalance === 0n && out > 0n) return "exit";
  if (endBalance > 0n && inn > 0n && out === 0n) return "opened";
  if (inn > 0n && out > 0n && inn === out) return "passthrough";
  return "resized";
}

export function explainMove(move, lang = "en") {
  const t = TEXTS[lang] ?? TEXTS.en;
  const times = move.threshold > 0n ? move.value / move.threshold : 0n;
  const reasons = [];
  if (times >= 10n) reasons.push(t.times(formatInteger(times, lang)));
  else if (times >= 2n) reasons.push(t.above(formatInteger(times, lang)));
  else reasons.push(t.threshold(move.minHuman, move.symbol));
  if (move.whaleToWhale) reasons.push(t.whaleToWhale);
  if (move.kind === "mint") reasons.push(t.mint);
  if (move.kind === "burn") reasons.push(t.burn);
  if (move.position === "exit") reasons.push(t.exit);
  if (move.position === "opened") reasons.push(t.opened);
  if (move.position === "passthrough") reasons.push(t.passthrough);
  if (move.firstSeen) reasons.push(t.firstSeen);
  if (move.counterpartyLabel) reasons.push(t.known(move.counterpartyLabel));
  return t.sentence(move, reasons);
}

const TEXTS = {
  en: {
    times: (n) => `${n}× the configured threshold`,
    above: (n) => `${n}× the configured threshold`,
    threshold: (min, symbol) => `at or above the ${min} ${symbol} threshold`,
    whaleToWhale: "both sides are on the watchlist (whale-to-whale)",
    mint: "new tokens were minted to this address",
    burn: "tokens were burned from this address",
    exit: "the remaining token balance is now 0 — this looks like an exit",
    opened: "the address had no later outflow and still holds a balance — a new or added position",
    passthrough: "inflow and outflow in this window cancel out — the tokens passed through",
    firstSeen: "first activity for this token in the scanned window",
    known: (name) => `counterparty is labelled ${name}`,
    sentence: (m, reasons) => {
      const who = m.whaleName;
      const amt = `${m.amount} ${m.symbol}`;
      const other = m.direction === "out" ? m.toName : m.fromName;
      const verb = m.direction === "out" ? `sent ${amt} to ${other}` : `received ${amt} from ${other}`;
      return `${who} ${verb}. Why it matters: ${reasons.join("; ")}.`;
    },
  },
  pt: {
    times: (n) => `${n}× o limite configurado`,
    above: (n) => `${n}× o limite configurado`,
    threshold: (min, symbol) => `igual ou acima do limite de ${min} ${symbol}`,
    whaleToWhale: "os dois lados estão na lista (baleia para baleia)",
    mint: "tokens novos foram emitidos para este endereço",
    burn: "tokens foram queimados neste endereço",
    exit: "o saldo restante do token agora é 0 — parece uma saída de posição",
    opened: "não houve saída depois e ainda há saldo — posição nova ou aumentada",
    passthrough: "entrada e saída neste intervalo se anulam — os tokens só passaram",
    firstSeen: "primeira atividade deste token na janela analisada",
    known: (name) => `a contraparte está rotulada como ${name}`,
    sentence: (m, reasons) => {
      const who = m.whaleName;
      const amt = `${m.amount} ${m.symbol}`;
      const other = m.direction === "out" ? m.toName : m.fromName;
      const verb = m.direction === "out" ? `enviou ${amt} para ${other}` : `recebeu ${amt} de ${other}`;
      return `${who} ${verb}. Por que importa: ${reasons.join("; ")}.`;
    },
  },
};

/**
 * Classify decoded transfers against the watchlist. Each watched side of a
 * transfer is scored with that address's own min; whale-to-whale emits two rows.
 */
export function collectMoves(watchlist, tokens) {
  const labels = labelsMap(watchlist);
  const watched = new Map(watchlist.addresses.map((a) => [a.address.toLowerCase(), a]));
  const stats = new Map(watchlist.addresses.map((a) => [a.address.toLowerCase(), emptyStats(tokens)]));
  const firstSeen = new Set();
  const moves = [];
  const activity = [];
  let matched = 0;

  const side = (whale, direction, t, token, whaleToWhale) => {
    const minText = thresholdOf(whale, token);
    const minRaw = parseUnits(minText, token.decimals);
    const significant = t.value >= minRaw;
    const counterparty = direction === "out" ? t.to : t.from;
    recordStat(stats.get(whale.address.toLowerCase()), token, direction, t.value, {
      block: t.block,
      tx: t.tx,
      logIndex: t.logIndex,
      kind: t.kind,
      significant,
    });

    const seenKey = `${whale.address.toLowerCase()}:${token.symbol}`;
    const isFirst = !firstSeen.has(seenKey);
    firstSeen.add(seenKey);

    const amountEn = formatAmount(t.value, token.decimals, 6, "en");
    const amountPt = formatAmount(t.value, token.decimals, 6, "pt");
    const key = `${transferKey(t)}:${direction}:${whale.address.toLowerCase()}`;
    activity.push({
      key,
      whale: whale.address,
      direction,
      symbol: token.symbol,
      significant,
      block: t.block,
      amount: { en: amountEn, pt: amountPt },
    });
    if (!significant) return;

    moves.push({
      key,
      block: t.block,
      logIndex: t.logIndex,
      tx: t.tx,
      token: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      kind: t.kind,
      direction,
      whale: whale.address,
      from: t.from,
      to: t.to,
      value: t.value,
      threshold: minRaw,
      minHuman: formatAmount(minRaw, token.decimals, 6, "en"),
      amount: amountEn,
      amountByLang: { en: amountEn, pt: amountPt },
      whaleToWhale,
      firstSeen: isFirst,
      counterparty,
      counterpartyLabel: extraString(labels, counterparty, "en") ?? labelOf(counterparty, {}, "en") ?? null,
    });
  };

  for (const token of tokens) {
    for (const t of token.transfers) {
      const fromW = watched.get(t.from.toLowerCase());
      const toW = watched.get(t.to.toLowerCase());
      if (!fromW && !toW) continue;
      matched++;
      const whaleToWhale = Boolean(fromW && toW);
      if (fromW) side(fromW, "out", t, token, whaleToWhale);
      if (toW) side(toW, "in", t, token, whaleToWhale);
    }
  }

  return { moves, stats, activity, matched, labels };
}

/**
 * Scan [fromBlock, toBlock] for significant moves of the watched addresses.
 * get_logs is filtered by token contract, Transfer topic0, and the watched from/to.
 */
export async function watchWindow(client, watchlist, { fromBlock, toBlock, balances = true } = {}) {
  const parties = watchlist.addresses.map((a) => a.address);
  const tokens = await Promise.all(
    watchlist.tokens.map(async (t) => {
      const info = await readTokenInfo(client, t.address);
      const { transfers, skipped } = await fetchTransfers(client, t.address, fromBlock, toBlock, { parties });
      return { ...t, ...info, minRaw: parseUnits(t.min, info.decimals), transfers, skipped };
    })
  );

  const { moves, stats, activity, matched, labels } = collectMoves(watchlist, tokens);
  let skipped = 0;
  for (const token of tokens) skipped += token.skipped;

  const snaps = balances ? await snapshotWhales(client, watchlist, tokens, toBlock) : new Map();
  const lastOf = new Map();
  for (const row of moves) lastOf.set(`${row.whale.toLowerCase()}:${row.symbol}`, row);

  for (const row of moves) {
    const stat = stats.get(row.whale.toLowerCase());
    const endBal = snaps.get(row.whale.toLowerCase())?.balances[row.symbol];
    const last = lastOf.get(`${row.whale.toLowerCase()}:${row.symbol}`);
    row.position = row === last && endBal !== undefined ? positionOf(stat, { symbol: row.symbol }, endBal) : null;
    row.whaleName = labeledWhale(row.whale, labels, "en");
    row.fromName = labeledWhale(row.from, labels, "en");
    row.toName = labeledWhale(row.to, labels, "en");
    row.why = {
      en: explainMove(
        {
          ...row,
          whaleName: labeledWhale(row.whale, labels, "en"),
          fromName: labeledWhale(row.from, labels, "en"),
          toName: labeledWhale(row.to, labels, "en"),
          counterpartyLabel: extraString(labels, row.counterparty, "en") ?? labelOf(row.counterparty, {}, "en"),
        },
        "en"
      ),
      pt: explainMove(
        {
          ...row,
          whaleName: labeledWhale(row.whale, labels, "pt"),
          fromName: labeledWhale(row.from, labels, "pt"),
          toName: labeledWhale(row.to, labels, "pt"),
          counterpartyLabel: extraString(labels, row.counterparty, "pt") ?? labelOf(row.counterparty, {}, "pt"),
          minHuman: formatAmount(row.threshold, row.decimals, 6, "pt"),
        },
        "pt"
      ),
    };
  }

  const summary = watchlist.addresses.map((whale) => {
    const key = whale.address.toLowerCase();
    const stat = stats.get(key);
    const snap = snaps.get(key);
    const notes = noteFor(whale, stat, snap, tokens);
    return {
      address: whale.address,
      label: whale.label,
      seen: stat.seen,
      significant: stat.significant,
      in: Object.fromEntries(tokens.map((t) => [t.symbol, stat.in[t.symbol]])),
      out: Object.fromEntries(tokens.map((t) => [t.symbol, stat.out[t.symbol]])),
      lastBlock: stat.lastBlock || null,
      largest: stat.largest,
      nonce: snap?.nonce ?? null,
      balances: snap?.balances ?? null,
      notes,
    };
  });

  return {
    fromBlock,
    toBlock,
    tokens: tokens.map((t) => ({
      symbol: t.symbol,
      address: t.address,
      decimals: t.decimals,
      min: t.min,
      topic: TRANSFER_TOPIC,
      transfers: t.transfers.length,
      skipped: t.skipped,
    })),
    watchlist: watchlist.addresses.map((a) => ({ address: a.address, label: a.label })),
    moves: moves.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex),
    activity,
    summary,
    matched,
    skipped,
  };
}

export function noteFor(whale, stat, snap, tokens) {
  const en = [];
  const pt = [];
  for (const t of tokens) {
    const inn = stat.in[t.symbol] ?? 0n;
    const out = stat.out[t.symbol] ?? 0n;
    if (inn === 0n && out === 0n) continue;
    const end = snap?.balances[t.symbol];
    const pos = end === undefined ? null : positionOf(stat, t, end);
    if (pos === "exit") {
      en.push(`exited ${t.symbol} (balance now 0)`);
      pt.push(`saiu de ${t.symbol} (saldo agora 0)`);
    } else if (pos === "opened") {
      en.push(`opened or added a ${t.symbol} position`);
      pt.push(`abriu ou aumentou posição em ${t.symbol}`);
    } else if (pos === "passthrough") {
      en.push(`${t.symbol} passed through (in = out)`);
      pt.push(`${t.symbol} só passou (entrada = saída)`);
    }
  }
  if (stat.seen > 0 && stat.significant === 0 && stat.largest) {
    const tok = tokens.find((t) => t.symbol === stat.largest.symbol);
    const amtEn = tok ? formatAmount(stat.largest.value, tok.decimals, 6, "en") : String(stat.largest.value);
    const amtPt = tok ? formatAmount(stat.largest.value, tok.decimals, 6, "pt") : String(stat.largest.value);
    const n = formatInteger(stat.seen, "en");
    const nPt = formatInteger(stat.seen, "pt");
    en.push(`${n} transfer(s) below the min (largest ${amtEn} ${stat.largest.symbol})`);
    pt.push(`${nPt} transferência(s) abaixo do mínimo (maior ${amtPt} ${stat.largest.symbol})`);
  }
  if (!en.length && stat.seen === 0) {
    en.push("quiet this window");
    pt.push("sem movimento nesta janela");
  }
  return { en: en.join("; ") || "active this window", pt: pt.join("; ") || "ativo nesta janela" };
}

export function presentMove(move, lang = "en") {
  const dir = move.direction === "out" ? (lang === "pt" ? "SAÍDA" : "OUT") : lang === "pt" ? "ENTRADA" : "IN";
  const kind = move.kind.toUpperCase();
  const amount = move.amountByLang?.[lang] ?? move.amount;
  return {
    headline: `[block ${formatInteger(move.block, lang)}] ${dir} ${kind} ${amount} ${move.symbol}`,
    why: move.why[lang],
    from: move.from,
    to: move.to,
    tx: move.tx,
    explorer: explorerTx(move.tx),
    whale: explorerAddress(move.whale),
  };
}

export function presentSummary(summary, tokens, lang = "en") {
  return summary.map((row) => {
    const money = (raw, t) => formatAmount(raw ?? 0n, t.decimals, 2, lang);
    const flows = tokens.map((t) => {
      const inn = money(row.in[t.symbol], t);
      const out = money(row.out[t.symbol], t);
      const hold = row.balances ? money(row.balances[t.symbol], t) : null;
      return { symbol: t.symbol, in: inn, out, hold };
    });
    return {
      address: row.address,
      explorer: explorerAddress(row.address),
      name: pickLabel(row.label, lang) ?? short(row.address),
      seen: row.seen,
      significant: row.significant,
      lastBlock: row.lastBlock ? formatInteger(row.lastBlock, lang) : "—",
      nonce: row.nonce,
      pros: row.balances ? formatAmount(row.balances.PROS, 18, 4, lang) : null,
      flows,
      largest: row.largest
        ? `${formatAmount(row.largest.value, tokens.find((t) => t.symbol === row.largest.symbol)?.decimals ?? 18, 2, lang)} ${row.largest.symbol}`
        : "—",
      notes: row.notes[lang],
    };
  });
}
