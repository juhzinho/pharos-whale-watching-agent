import { decodeEventLog, decodeFunctionResult, encodeFunctionData, erc20Abi, toEventSelector } from "viem";
import { callJson } from "./mcp.js";

export const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
/** Per-call cap of Chain MCP get_logs. Larger ranges are split into these windows. */
export const LOG_WINDOW = 1000;
export const MAX_WINDOW = LOG_WINDOW;
/** CLI / agents can page this far (50 get_logs windows). */
export const MAX_LOOKBACK = 50_000;
/** Live API stays inside the Vercel 60s budget. */
export const MAX_LOOKBACK_API = 10_000;

const ZERO = /^0x0{40}$/i;
const TOO_BIG = /too many|result limit|response (too |size)|exceeded|payload|max logs|query returned more/i;

export async function readTokenInfo(client, token) {
  const read = async (functionName) => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName });
    const { result } = await callJson(client, "eth_call", { transaction: { to: token, data } });
    return decodeFunctionResult({ abi: erc20Abi, functionName, data: result });
  };
  const [decimals, symbol] = await Promise.all([read("decimals"), read("symbol")]);
  return { decimals, symbol };
}

export async function latestBlock(client) {
  return Number((await callJson(client, "get_block_number")).blockNumber);
}

export const transferKey = (t) => `${t.tx}:${t.logIndex}`;

/** 32-byte topic for an indexed address (from / to on Transfer). */
export function topicAddress(address) {
  return `0x${address.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
}

/** Inclusive [fromBlock, toBlock] split into MCP-legal get_logs windows. */
export function logWindows(fromBlock, toBlock, size = LOG_WINDOW) {
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || toBlock < fromBlock) return [];
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += size) {
    out.push({ fromBlock: start, toBlock: Math.min(start + size - 1, toBlock) });
  }
  return out;
}

/** First block of a lookback window, including live catch-up that never exceeds `lookback`. */
export function lookbackFrom(head, lookback, since = null, overlap = 5) {
  const start = since === null || since === undefined
    ? head - lookback + 1
    : Math.max(since + 1 - overlap, head - lookback + 1);
  return Math.max(start, 0);
}

function decodeTransfers(logs) {
  const transfers = [];
  let skipped = 0;
  for (const log of logs) {
    let args;
    try {
      ({ args } = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics }));
    } catch {
      skipped++; // same topic, different layout (e.g. an NFT Transfer)
      continue;
    }
    transfers.push({
      block: Number(log.blockNumber),
      logIndex: Number(log.logIndex),
      tx: log.transactionHash,
      from: args.from,
      to: args.to,
      value: args.value,
      kind: ZERO.test(args.from) ? "mint" : ZERO.test(args.to) ? "burn" : "transfer",
    });
  }
  return { transfers, skipped };
}

async function getLogsPaged(client, token, fromBlock, toBlock, topics) {
  try {
    return await callJson(client, "get_logs", { address: token, topics, fromBlock, toBlock });
  } catch (error) {
    if (fromBlock >= toBlock || !TOO_BIG.test(`${error.message ?? ""}`)) throw error;
    const mid = fromBlock + Math.floor((toBlock - fromBlock) / 2);
    const [left, right] = await Promise.all([
      getLogsPaged(client, token, fromBlock, mid, topics),
      getLogsPaged(client, token, mid + 1, toBlock, topics),
    ]);
    return [...left, ...right];
  }
}

async function pullLogs(client, token, fromBlock, toBlock, topicSets) {
  const byKey = new Map();
  let skipped = 0;
  let chunks = 0;
  for (const topics of topicSets) {
    const parts = await Promise.all(
      logWindows(fromBlock, toBlock).map(async (w) => {
        const logs = await getLogsPaged(client, token, w.fromBlock, w.toBlock, topics);
        chunks++;
        return decodeTransfers(logs);
      })
    );
    for (const decoded of parts) {
      skipped += decoded.skipped;
      for (const t of decoded.transfers) {
        const key = transferKey(t);
        if (!byKey.has(key)) byKey.set(key, t);
      }
    }
  }
  const transfers = [...byKey.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return { transfers, skipped, chunks };
}

/**
 * Decoded ERC20 Transfer events of `token` in [fromBlock, toBlock], oldest first.
 * Chain MCP get_logs is capped at 1000 blocks per call; this pages the full span
 * in parallel (the MCP client already limits concurrency and retries 429s).
 * When `parties` is set, get_logs is also filtered by those addresses as topic1 (from)
 * and topic2 (to). Falls back to an unfiltered Transfer query if the MCP rejects extra topics.
 */
export async function fetchTransfers(client, token, fromBlock, toBlock, { parties = [] } = {}) {
  const padded = [...new Set(parties.map((a) => topicAddress(a)))];
  const filtered = padded.length
    ? [
        [TRANSFER_TOPIC, padded],
        [TRANSFER_TOPIC, null, padded],
      ]
    : [[TRANSFER_TOPIC]];
  try {
    return await pullLogs(client, token, fromBlock, toBlock, filtered);
  } catch (error) {
    if (!padded.length) throw error;
    return pullLogs(client, token, fromBlock, toBlock, [[TRANSFER_TOPIC]]);
  }
}
