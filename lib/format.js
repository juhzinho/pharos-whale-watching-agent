import { formatUnits } from "viem";
import { KNOWN_ADDRESSES } from "./tokens.js";

export const EXPLORER = "https://www.pharosscan.xyz";

export const explorerAddress = (address) => `${EXPLORER}/address/${address}`;
export const explorerTx = (hash) => `${EXPLORER}/tx/${hash}`;

export const short = (value) => `${value.slice(0, 6)}…${value.slice(-4)}`;

export function labelOf(address, extra = {}, lang = "pt") {
  const key = address.toLowerCase();
  return extra[key] ?? KNOWN_ADDRESSES[key]?.[lang] ?? KNOWN_ADDRESSES[key]?.pt;
}

export function labeled(address, extra = {}, lang = "pt") {
  const label = labelOf(address, extra, lang);
  return label ? `${label} (${short(address)})` : short(address);
}

const SEPARATORS = { pt: { group: ".", decimal: "," }, en: { group: ",", decimal: "." } };

// Formats without going through Number, so large supplies keep every digit.
export function formatAmount(raw, decimals = 0, maxFraction = 2, lang = "pt") {
  const { group, decimal } = SEPARATORS[lang] ?? SEPARATORS.pt;
  const [intPart, fracPart = ""] = formatUnits(BigInt(raw), Number(decimals)).split(".");
  const sign = intPart.startsWith("-") ? "-" : "";
  const grouped = intPart.replace(/^-/, "").replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const fraction = fracPart.slice(0, maxFraction).replace(/0+$/, "");
  if (!fraction && /[1-9]/.test(fracPart) && /^-?0$/.test(intPart)) {
    return `${sign}< 0${decimal}${"0".repeat(Math.max(maxFraction - 1, 0))}1`;
  }
  return sign + grouped + (fraction ? `${decimal}${fraction}` : "");
}

export function formatInteger(value, lang = "pt") {
  const { group } = SEPARATORS[lang] ?? SEPARATORS.pt;
  return BigInt(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, group);
}
