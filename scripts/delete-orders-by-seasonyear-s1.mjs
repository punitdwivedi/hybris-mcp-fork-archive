/**
 * Delete Orders (+ entries, consignments, BayerDiscounts) on s1
 * where seasonYear IN ('2024','2025').
 * (Order has no seedYear attribute; seasonYear is the seed-year field.)
 *
 * Usage:
 *   SEASON_YEARS=2024,2025 DELETE_BATCH=2000 node scripts/delete-orders-by-seasonyear-s1.mjs
 */
import { HybrisClient } from "../dist/hybris-client.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
HybrisClient.REQUEST_TIMEOUT_MS = 600000;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const mcp = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../.cursor/mcp.json"), "utf8")
);
const s1 = mcp.mcpServers.hybris_s1.env;

const client = new HybrisClient({
  baseUrl: s1.HYBRIS_BASE_URL.replace(/\/$/, ""),
  username: s1.HYBRIS_USERNAME,
  password: s1.HYBRIS_PASSWORD,
  hacPath: s1.HYBRIS_HAC_PATH !== undefined ? s1.HYBRIS_HAC_PATH : "/hac",
  occPath: s1.HYBRIS_OCC_PATH || "/monsantocommercewebservices/v2",
});

let BATCH = Number(process.env.DELETE_BATCH || 2000);
const YEARS = (process.env.SEASON_YEARS || "2024,2025")
  .split(",")
  .map((y) => y.trim())
  .filter(Boolean);
const YEAR_SQL = YEARS.map((y) => `'${y.replace(/'/g, "''")}'`).join(",");

let emptyStreak = 0;

async function runGroovy(script, commit = true, attempt = 1) {
  try {
    const raw = await client.hacRequest(`/console/scripting/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        script,
        scriptType: "groovy",
        commit: String(commit),
      }),
    });
    if (raw.stacktraceText) {
      throw new Error(raw.stacktraceText.slice(0, 2000));
    }
    return { output: raw.outputText || "", result: raw.executionResult };
  } catch (e) {
    const msg = String(e.message || e);
    if (attempt < 5 && /(502|503|504|session expired|HAC API error)/i.test(msg)) {
      client.hacSession = null;
      const waitMs = attempt * 8000;
      console.error(`Transient error (attempt ${attempt}): ${msg.slice(0, 120)} — retry in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      return runGroovy(script, commit, attempt + 1);
    }
    throw e;
  }
}

async function assertS1() {
  const raw = await runGroovy(
    `import de.hybris.platform.util.Config\nreturn Config.getParameter('db.url')`,
    false
  );
  const db = String(raw.result || "");
  if (!db.includes("bayeragaz1-s1")) {
    throw new Error(`Refusing to run — not s1 DB: ${db}`);
  }
  console.log(`DB OK: ${db}`);
}

function rawNum(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function remainingCount() {
  const r = await runGroovy(
    `
def jdbc = spring.getBean("jdbcTemplate")
return jdbc.queryForObject("""
SELECT COUNT(*) FROM orders WHERE p_seasonyear IN (${YEAR_SQL})
""", Integer)
`,
    false
  );
  return rawNum(r.result);
}

function deleteBatchScript(batchSize) {
  return `
def jdbc = spring.getBean("jdbcTemplate")
def batch = ${batchSize}

def pks = jdbc.queryForList("""
SELECT TOP """ + batch + """ PK FROM orders
WHERE p_seasonyear IN (${YEAR_SQL})
ORDER BY PK
""").collect { (it.PK as Long) }

if (!pks) {
  println "deletedOrders=0;deletedEntries=0;deletedDiscounts=0;deletedConsignments=0;deletedConsignmentEntries=0;done=true"
  return "deletedOrders=0;deletedEntries=0;deletedDiscounts=0;deletedConsignments=0;deletedConsignmentEntries=0;done=true"
}

def inList = pks.join(",")
def consignments = 0
def consignmentEntries = 0
def discounts = 0

try {
  consignments = jdbc.update("DELETE FROM consignments WHERE p_order IN ("+inList+")")
} catch (Exception ignored) {}
try {
  // if consignments deleted first failed due to FK, delete entries first
} catch (Exception ignored) {}

[
  "DELETE FROM paymnttrnsctentries WHERE p_paymenttransaction IN (SELECT PK FROM paymenttransactions WHERE p_order IN ("+inList+"))",
  "DELETE FROM paymenttransactions WHERE p_order IN ("+inList+")"
].each { sql -> try { jdbc.update(sql) } catch (Exception ignored) {} }

try {
  consignmentEntries = jdbc.update(
    "DELETE FROM consignmententries WHERE p_consignment IN (SELECT PK FROM consignments WHERE p_order IN ("+inList+"))"
  )
} catch (Exception e) { println "CE_FAIL=" + e.message }

try {
  consignments = jdbc.update("DELETE FROM consignments WHERE p_order IN ("+inList+")")
} catch (Exception e) { println "C_FAIL=" + e.message }

try { jdbc.update("DELETE FROM orderhistoryentries WHERE p_order IN ("+inList+")") } catch (Exception ignored) {}

try { discounts += jdbc.update("DELETE FROM bayerdiscounts WHERE p_order IN ("+inList+")") } catch (Exception e) { println "DISCOUNT_ORDER_FAIL=" + e.message }
try {
  discounts += jdbc.update("DELETE FROM bayerdiscounts WHERE p_entry IN (SELECT PK FROM orderentries WHERE p_order IN ("+inList+"))")
} catch (Exception e) { println "DISCOUNT_ENTRY_FAIL=" + e.message }

def entries = 0
try {
  entries = jdbc.update("DELETE FROM orderentries WHERE p_order IN ("+inList+")")
} catch (Exception e) {
  println "ENTRY_FAIL=" + e.message
  return "ENTRY_FAIL:" + e.message
}

def orders = 0
try {
  orders = jdbc.update("DELETE FROM orders WHERE PK IN ("+inList+")")
} catch (Exception e) {
  println "ORDER_FAIL=" + e.message
  return "ORDER_FAIL:" + e.message
}

try { spring.getBean("cacheController").clearCache("*" as String) } catch (Exception ignored) {}

def summary = "deletedOrders=" + orders + ";deletedEntries=" + entries + ";deletedDiscounts=" + discounts +
  ";deletedConsignments=" + consignments + ";deletedConsignmentEntries=" + consignmentEntries + ";done=false"
println summary
return summary
`;
}

function parseSummary(text) {
  const src = String(text || "");
  const get = (k) => {
    const m = src.match(new RegExp(k + "=([^;\\s]+)"));
    return m ? m[1] : null;
  };
  return {
    deletedOrders: Number(get("deletedOrders") || 0),
    deletedEntries: Number(get("deletedEntries") || 0),
    deletedDiscounts: Number(get("deletedDiscounts") || 0),
    deletedConsignments: Number(get("deletedConsignments") || 0),
    deletedConsignmentEntries: Number(get("deletedConsignmentEntries") || 0),
    done: get("done") === "true",
    fail: /FAIL=/.test(src) || src.includes("ENTRY_FAIL") || src.includes("ORDER_FAIL"),
    raw: src,
  };
}

await assertS1();

const started = Date.now();
let totalOrders = 0;
let totalEntries = 0;
let totalDiscounts = 0;
let totalConsignments = 0;
let totalConsignmentEntries = 0;
let batchNum = 0;

console.log(`Target: ${s1.HYBRIS_BASE_URL}`);
console.log(`seasonYear IN (${YEAR_SQL})  batch=${BATCH}`);
let remaining = await remainingCount();
console.log(`Starting remaining orders: ${remaining}`);

while (remaining > 0) {
  batchNum++;
  const t0 = Date.now();
  try {
    const res = await runGroovy(deleteBatchScript(BATCH), true);
    const summary = parseSummary(res.result || res.output);
    if (summary.fail) {
      console.error(`Batch ${batchNum} failed:`, summary.raw);
      process.exit(2);
    }
    totalOrders += summary.deletedOrders;
    totalEntries += summary.deletedEntries;
    totalDiscounts += summary.deletedDiscounts;
    totalConsignments += summary.deletedConsignments;
    totalConsignmentEntries += summary.deletedConsignmentEntries;
    remaining = await remainingCount();
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const batchSec = ((Date.now() - t0) / 1000).toFixed(1);
    const rate = totalOrders / ((Date.now() - started) / 1000 || 1);
    const etaSec = rate > 0 ? remaining / rate : 0;
    console.log(
      `batch=${batchNum} +orders=${summary.deletedOrders} +entries=${summary.deletedEntries} ` +
        `+discounts=${summary.deletedDiscounts} +cons=${summary.deletedConsignments} +ce=${summary.deletedConsignmentEntries} ` +
        `remaining=${remaining} batchSec=${batchSec} elapsedSec=${elapsed} ` +
        `rate=${rate.toFixed(1)}/s etaMin=${(etaSec / 60).toFixed(1)}`
    );
    if (summary.deletedOrders === 0) {
      emptyStreak++;
      client.hacSession = null;
      console.warn(`Empty delete remaining=${remaining} streak=${emptyStreak}`);
      if (emptyStreak >= 3) {
        if (BATCH > 500) {
          BATCH = Math.max(500, Math.floor(BATCH / 2));
          emptyStreak = 0;
          console.warn(`Reducing batch to ${BATCH}`);
          continue;
        }
        console.error("Repeated empty deletes — stopping.");
        process.exit(3);
      }
      await new Promise((r) => setTimeout(r, 5000));
      remaining = await remainingCount();
      continue;
    }
    emptyStreak = 0;
  } catch (e) {
    console.error(`Batch ${batchNum} error:`, e.message || e);
    client.hacSession = null;
    if (BATCH > 500) {
      BATCH = Math.max(500, Math.floor(BATCH / 2));
      console.warn(`Reducing batch to ${BATCH}`);
    }
    await new Promise((r) => setTimeout(r, 10000));
    remaining = await remainingCount();
  }
}

console.log(
  `DONE totalOrders=${totalOrders} totalEntries=${totalEntries} totalDiscounts=${totalDiscounts} ` +
    `totalConsignments=${totalConsignments} totalConsignmentEntries=${totalConsignmentEntries} ` +
    `elapsedSec=${((Date.now() - started) / 1000).toFixed(1)}`
);
process.exit(0);
