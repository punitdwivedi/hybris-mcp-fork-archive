/**
 * Phase 1: delete synthetic BC-% orders on s1.
 *
 * Mode KEEP_TARGET:
 *   STORE_UID=cbus KEEP_ORDERS=31444 CODE_LIKE='BC-%'
 *   Deletes BC-% on that store until remaining store order count == KEEP_ORDERS
 *
 * Mode DELETE_ALL:
 *   STORE_UID=core_cbus CODE_LIKE='BC-%'  (omit KEEP_ORDERS)
 *   Deletes all matching on that store
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
const STORE = process.env.STORE_UID;
const LIKE = process.env.CODE_LIKE || "BC-%";
const KEEP =
  process.env.KEEP_ORDERS !== undefined && process.env.KEEP_ORDERS !== ""
    ? Number(process.env.KEEP_ORDERS)
    : null;

if (!STORE) {
  console.error("STORE_UID required");
  process.exit(1);
}

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
    if (raw.stacktraceText) throw new Error(raw.stacktraceText.slice(0, 2000));
    return { output: raw.outputText || "", result: raw.executionResult };
  } catch (e) {
    const msg = String(e.message || e);
    if (attempt < 5 && /(502|503|504|session expired|HAC API error)/i.test(msg)) {
      client.hacSession = null;
      await new Promise((r) => setTimeout(r, attempt * 8000));
      return runGroovy(script, commit, attempt + 1);
    }
    throw e;
  }
}

function rawNum(v) {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function assertS1() {
  const raw = await runGroovy(
    `import de.hybris.platform.util.Config\nreturn Config.getParameter('db.url')`,
    false
  );
  const db = String(raw.result || "");
  if (!db.includes("bayeragaz1-s1")) throw new Error(`Not s1: ${db}`);
  console.log(`DB OK: ${db}`);
}

async function storeOrderCount() {
  const r = await runGroovy(
    `
def jdbc = spring.getBean("jdbcTemplate")
return jdbc.queryForObject("""
SELECT COUNT(*) FROM orders o
JOIN basestore s ON o.p_store = s.PK
WHERE s.p_uid = '${STORE}'
""", Integer)
`,
    false
  );
  return rawNum(r.result);
}

async function matchCount() {
  const r = await runGroovy(
    `
def jdbc = spring.getBean("jdbcTemplate")
return jdbc.queryForObject("""
SELECT COUNT(*) FROM orders o
JOIN basestore s ON o.p_store = s.PK
WHERE s.p_uid = '${STORE}' AND o.p_code LIKE '${LIKE}'
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
def store = "${STORE}"
def like = "${LIKE}"

def pks = jdbc.queryForList("""
SELECT TOP """ + batch + """ o.PK
FROM orders o
JOIN basestore s ON o.p_store = s.PK
WHERE s.p_uid = ? AND o.p_code LIKE ?
ORDER BY o.createdTS ASC, o.PK ASC
""", store, like).collect { (it.PK as Long) }

if (!pks) {
  println "deletedOrders=0;deletedEntries=0;deletedDiscounts=0;deletedConsignments=0;deletedConsignmentEntries=0;done=true"
  return "deletedOrders=0;deletedEntries=0;deletedDiscounts=0;deletedConsignments=0;deletedConsignmentEntries=0;done=true"
}

def inList = pks.join(",")
def discounts = 0
def consignments = 0
def consignmentEntries = 0

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
console.log(`store=${STORE} code LIKE '${LIKE}' keepStoreOrders=${KEEP ?? "(delete all matches)"} batch=${BATCH}`);

let storeCount = await storeOrderCount();
let matches = await matchCount();
console.log(`Starting storeOrders=${storeCount} matching=${matches}`);

function shouldContinue() {
  if (KEEP == null) return matches > 0;
  return storeCount > KEEP && matches > 0;
}

while (shouldContinue()) {
  // shrink last batch if KEEP mode would overshoot
  let batchSize = BATCH;
  if (KEEP != null) {
    const maxDelete = storeCount - KEEP;
    if (maxDelete <= 0) break;
    batchSize = Math.min(BATCH, maxDelete);
  }

  batchNum++;
  const t0 = Date.now();
  try {
    const res = await runGroovy(deleteBatchScript(batchSize), true);
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
    storeCount = await storeOrderCount();
    matches = await matchCount();
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const batchSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `batch=${batchNum} +orders=${summary.deletedOrders} +entries=${summary.deletedEntries} ` +
        `+discounts=${summary.deletedDiscounts} +cons=${summary.deletedConsignments} +ce=${summary.deletedConsignmentEntries} ` +
        `storeOrders=${storeCount} matching=${matches} batchSec=${batchSec} elapsedSec=${elapsed}`
    );
    if (summary.deletedOrders === 0) {
      emptyStreak++;
      client.hacSession = null;
      if (emptyStreak >= 3) {
        console.error("Repeated empty deletes — stopping.");
        process.exit(3);
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    emptyStreak = 0;
  } catch (e) {
    console.error(`Batch ${batchNum} error:`, e.message || e);
    client.hacSession = null;
    if (BATCH > 500) BATCH = Math.max(500, Math.floor(BATCH / 2));
    await new Promise((r) => setTimeout(r, 10000));
    storeCount = await storeOrderCount();
    matches = await matchCount();
  }
}

console.log(
  `DONE totalOrders=${totalOrders} totalEntries=${totalEntries} totalDiscounts=${totalDiscounts} ` +
    `totalConsignments=${totalConsignments} totalConsignmentEntries=${totalConsignmentEntries} ` +
    `finalStoreOrders=${storeCount} finalMatching=${matches} ` +
    `elapsedSec=${((Date.now() - started) / 1000).toFixed(1)}`
);
process.exit(0);
