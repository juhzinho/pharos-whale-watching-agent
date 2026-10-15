import { getAddress, isAddress } from "viem";
import { TOKENS } from "./tokens.js";

export const MIN_WATCHED = 5;

/** Default watchlist: 8 addresses that were actually moving USDC/WPROS on Pacific Mainnet. */
export const DEFAULT_WATCHLIST = {
  tokens: [
    { symbol: "USDC", address: TOKENS.USDC, min: "50" },
    { symbol: "WPROS", address: TOKENS.WPROS, min: "20" },
  ],
  addresses: [
    { address: "0x912c9aDe24D44d8922f0866D8Dcb079f1363f647", label: { en: "Busiest USDC/WPROS flow", pt: "Fluxo USDC/WPROS mais ativo" } },
    { address: "0x936564245B69f5a293b42cbd752E0eE3bb68b470", label: { en: "Second-busiest flow", pt: "Segundo fluxo mais ativo" } },
    { address: "0x768B959191cE5876cabBbC014a08D72615BDdE54", label: { en: "Frequent USDC trader", pt: "Trader frequente de USDC" } },
    { address: "0xB53F6cB429B8e14b6b87362B5a20Ba69FC9C3B47", label: { en: "Large USDC round-trips", pt: "Ida-e-volta grande de USDC" } },
    { address: "0xA1204366ce65678872ece7F7a9eDEFe858574777", label: { en: "Large USDC round-trips", pt: "Ida-e-volta grande de USDC" } },
    { address: "0x7927d0297e903A2AaDf617760F17a975034d0C10", label: { en: "Large USDC round-trips", pt: "Ida-e-volta grande de USDC" } },
    { address: "0xf48Ff1e0aBc740C167049c46435E753b083bC317", label: { en: "Active WPROS flow", pt: "Fluxo ativo de WPROS" } },
    { address: "0x4146D192Da6428c9e1C243D2A953c625B5765623", label: { en: "WPROS seller", pt: "Vendedor de WPROS" } },
  ],
};

function asLabel(value, fallback) {
  if (!value) return { en: fallback, pt: fallback };
  if (typeof value === "string") return { en: value, pt: value };
  return { en: value.en || fallback, pt: value.pt || value.en || fallback };
}

function parseMin(value, where) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`${where} must be a non-negative number (got ${value})`);
  return text;
}

function parseToken(raw, i) {
  const symbol = String(raw.symbol ?? raw.id ?? "").trim().toUpperCase();
  const address = raw.address ? String(raw.address).trim() : TOKENS[symbol];
  if (!symbol) throw new Error(`tokens[${i}] needs a symbol`);
  if (!isAddress(address)) throw new Error(`tokens[${i}] (${symbol}) needs a valid contract address`);
  const min = parseMin(raw.min ?? "0", `tokens[${i}].min`) ?? "0";
  return { symbol, address: getAddress(address), min };
}

function parseAddress(raw, i) {
  const address = String(raw.address ?? raw ?? "").trim();
  if (!isAddress(address)) throw new Error(`addresses[${i}] is not a valid address: ${address}`);
  const checksum = getAddress(address);
  const min = {};
  const rawMin = raw.min && typeof raw.min === "object" ? raw.min : undefined;
  if (rawMin) {
    for (const [symbol, value] of Object.entries(rawMin)) {
      min[symbol.toUpperCase()] = parseMin(value, `addresses[${i}].min.${symbol}`);
    }
  }
  return { address: checksum, label: asLabel(raw.label, checksum), min };
}

/**
 * Validates a watchlist. At least 5 addresses, at least 1 token, unique checksummed addresses.
 * `mins` (e.g. { USDC: "100" }) overrides the default token thresholds.
 */
export function parseWatchlist(input = {}, { mins = {}, extraAddresses = [] } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const tokensRaw = Array.isArray(src.tokens) && src.tokens.length ? src.tokens : DEFAULT_WATCHLIST.tokens;
  const addressesRaw = [...(Array.isArray(src.addresses) ? src.addresses : DEFAULT_WATCHLIST.addresses), ...extraAddresses];

  const tokens = tokensRaw.map(parseToken);
  for (const [symbol, min] of Object.entries(mins)) {
    const token = tokens.find((t) => t.symbol === symbol.toUpperCase());
    if (!token) throw new Error(`--min ${symbol}: token is not in the watchlist`);
    token.min = parseMin(min, `--min ${symbol}`) ?? token.min;
  }

  const addresses = [];
  const seen = new Set();
  addressesRaw.forEach((raw, i) => {
    const parsed = parseAddress(raw, i);
    const key = parsed.address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    addresses.push(parsed);
  });

  if (!tokens.length) throw new Error("watchlist needs at least one token");
  if (addresses.length < MIN_WATCHED) {
    throw new Error(`watchlist needs at least ${MIN_WATCHED} addresses (got ${addresses.length})`);
  }

  return { tokens, addresses };
}

export function thresholdOf(whale, token) {
  return whale.min?.[token.symbol] ?? token.min;
}

export function labelsMap(watchlist) {
  const extra = {};
  for (const a of watchlist.addresses) extra[a.address.toLowerCase()] = a.label;
  return extra;
}

export function pickLabel(label, lang = "en") {
  if (!label) return null;
  if (typeof label === "string") return label;
  return label[lang] ?? label.en ?? label.pt ?? null;
}
