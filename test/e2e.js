import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const WHALE = "whale.js";
const USDC_OWNER = "0x9f8ea09770dc38fc61f5a62031b3be0526d54d92";

const CASES = [
  { name: "whale: --help", args: [WHALE, "--help"], code: 0, expect: /Usage:[\s\S]*at least 5 addresses/ },
  {
    name: "whale: --once reports a move and a summary of 8 addresses",
    args: [WHALE, "--once", "--lookback", "1000"],
    code: 0,
    expect: /Watching 8 addresses[\s\S]*get_logs topic0 Transfer[\s\S]*SIGNIFICANT[\s\S]*from 0x[0-9a-fA-F]{40}[\s\S]*to   0x[0-9a-fA-F]{40}[\s\S]*tx   0x[0-9a-f]{64}[\s\S]*Why it matters[\s\S]*SUMMARY[\s\S]*Busiest USDC\/WPROS flow[\s\S]*WPROS seller/,
  },
  {
    name: "whale: high --min still prints the 8-wallet summary",
    args: [WHALE, "--once", "--lookback", "300", "--min", "USDC=1000000000", "--min", "WPROS=1000000000"],
    code: 0,
    expect: /Watching 8 addresses[\s\S]*SUMMARY[\s\S]*quiet this window|SUMMARY[\s\S]*Busiest/,
    reject: /SIGNIFICANT/,
  },
  {
    name: "whale: live mode keeps running",
    args: [WHALE, "--lookback", "100", "--interval", "3"],
    killAfter: 55_000,
    code: null,
    expect: /Watching 8 addresses[\s\S]*Watching for new significant moves/,
    reject: /could not connect/,
  },
  { name: "whale: --lookback above the limit", args: [WHALE, "--lookback", "5000"], code: 1, expect: /--lookback must be/ },
  { name: "whale: --min format", args: [WHALE, "--min", "100"], code: 1, expect: /--min must look like/ },
  { name: "whale: invalid --add", args: [WHALE, "--add", "0x123"], code: 1, expect: /--add needs a valid address/ },
  { name: "whale: --only with fewer than 5 addresses", args: [WHALE, "--only", "--add", USDC_OWNER], code: 1, expect: /at least 5 addresses/ },
];

function run({ args, killAfter }) {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(process.execPath, args, { cwd: new URL("..", import.meta.url) });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), killAfter ?? 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, ms: performance.now() - start });
    });
  });
}

let failed = 0;
for (const c of CASES) {
  const { code, out, ms } = await run(c);
  const okCode = c.code === null ? true : code === c.code;
  const okExpect = c.expect ? c.expect.test(out) : true;
  const okReject = c.reject ? !c.reject.test(out) : true;
  const ok = okCode && okExpect && okReject;
  if (!ok) failed++;
  const mark = ok ? "ok" : "FAIL";
  console.log(`${mark}  ${c.name}  (${Math.round(ms)}ms, exit ${code})`);
  if (!ok) {
    if (!okCode) console.log(`     expected exit ${c.code}, got ${code}`);
    if (!okExpect) console.log(`     output did not match ${c.expect}`);
    if (!okReject) console.log(`     output matched forbidden ${c.reject}`);
    console.log(out.slice(-1500));
  }
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\n${CASES.length} e2e tests passed`);
