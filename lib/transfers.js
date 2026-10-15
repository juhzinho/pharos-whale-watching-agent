import { decodeEventLog, decodeFunctionResult, encodeFunctionData, erc20Abi, toEventSelector } from "viem";
import { callJson } from "./mcp.js";

export const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
export const MAX_WINDOW = 1000; // get_logs rejects ranges larger than 1000 blocks

const ZERO = /^0x0{40}$/i;

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

async function pullLogs(client, token, fromBlock, toBlock, topicSets) {
  const byKey = new Map();
  let skipped = 0;
  for (const topics of topicSets) {
    for (let start = fromBlock; start <= toBlock; start += MAX_WINDOW) {
      const end = Math.min(start + MAX_WINDOW - 1, toBlock);
      const logs = await callJson(client, "get_logs", { address: token, topics, fromBlock: start, toBlock: end });
      const decoded = decodeTransfers(logs);
      skipped += decoded.skipped;
      for (const t of decoded.transfers) {
        const key = transferKey(t);
        if (!byKey.has(key)) byKey.set(key, t);
      }
    }
  }
  const transfers = [...byKey.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return { transfers, skipped };
}

/**
 * Decoded ERC20 Transfer events of `token` in [fromBlock, toBlock], oldest first.
 * When `parties` is set, get_logs is also filtered by those addresses as topic1 (from)
 * and topic2 (to), so busy tokens don't hide the watched wallets. Falls back to an
 * unfiltered Transfer query if the MCP rejects the extra topics.
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
