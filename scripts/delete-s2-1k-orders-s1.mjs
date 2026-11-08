/**
 * Mass-delete Order + OrderEntry for codes LIKE 'S2-1K%' on s1 via JDBC batches.
 * Usage: node scripts/delete-s2-1k-orders-s1.mjs
 */
import { HybrisClient } from "../dist/hybris-client.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
HybrisClient.REQUEST_TIMEOUT_MS = 600000; // 10 min per HAC call

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
const LIKE = process.env.ORDER_CODE_LIKE || "S2-1K%";
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
    return {
      output: raw.outputText || "",
      result: raw.executionResult,
    };
  } catch (e) {
    const msg = String(e.message || e);
    // Reset HAC session on proxy/auth failures and retry
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

async function remainingCount() {
  const r = await client.executeFlexibleSearch(
    `SELECT COUNT({PK}) FROM {Order} WHERE {code} LIKE '${LIKE}'`,
    1
  );
  return Number(r.resultList?.[0]?.[0] || 0);
}

function deleteBatchScript(batchSize) {
  return `
def jdbc = spring.getBean("jdbcTemplate")
def batch = ${batchSize}
def like = "${LIKE}"
def out = new StringBuilder()

def pks = jdbc.queryForList(
  "SELECT TOP " + batch + " PK FROM orders WHERE p_code LIKE ? ORDER BY PK",
  like
).collect { (it.PK as Long) }

if (!pks) {
  println "deletedOrders=0;deletedEntries=0;done=true"
  return "deletedOrders=0;deletedEntries=0;done=true"
}

def inList = pks.join(",")

// Best-effort related cleanup (ignore missing columns/tables)
[
  "DELETE FROM paymnttrnsctentries WHERE p_paymenttransaction IN (SELECT PK FROM paymenttransactions WHERE p_order IN ("+inList+"))",
  "DELETE FROM paymenttransactions WHERE p_order IN ("+inList+")",
  "DELETE FROM consignmententries WHERE p_consignment IN (SELECT PK FROM consignments WHERE p_order IN ("+inList+"))",
  "DELETE FROM consignments WHERE p_order IN ("+inList+")",
  "DELETE FROM orderhistoryentries WHERE p_order IN ("+inList+")"
].each { sql ->
  try { jdbc.update(sql) } catch (Exception ignored) {}
}

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

// Invalidate caches lightly
try {
  spring.getBean("cacheController").clearCache("*" as String)
} catch (Exception ignored) {
  try { spring.getBean("de.hybris.platform.cache.CacheController") } catch (Exception ignored2) {}
}

def summary = "deletedOrders=" + orders + ";deletedEntries=" + entries + ";done=false"
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
    done: get("done") === "true",
    fail: src.includes("FAIL"),
    raw: src,
  };
}

const started = Date.now();
let totalOrders = 0;
let totalEntries = 0;
let batchNum = 0;

console.log(`Target: ${s1.HYBRIS_BASE_URL}`);
console.log(`Pattern: ${LIKE}  batch=${BATCH}`);
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
      // shrink batch and retry once
      if (BATCH > 200) {
        console.error("Retrying with smaller emergency batch via env not supported mid-run; aborting.");
      }
      process.exit(2);
    }
    totalOrders += summary.deletedOrders;
    totalEntries += summary.deletedEntries;
    remaining = await remainingCount();
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const batchSec = ((Date.now() - t0) / 1000).toFixed(1);
    const rate = totalOrders / ((Date.now() - started) / 1000 || 1);
    const etaSec = rate > 0 ? remaining / rate : 0;
    console.log(
      `batch=${batchNum} +orders=${summary.deletedOrders} +entries=${summary.deletedEntries} ` +
        `remaining=${remaining} batchSec=${batchSec} elapsedSec=${elapsed} ` +
        `rate=${rate.toFixed(1)}/s etaMin=${(etaSec / 60).toFixed(1)}`
    );
    if (summary.deletedOrders === 0) {
      emptyStreak++;
      client.hacSession = null;
      console.warn(
        `Empty delete with remaining=${remaining} (streak=${emptyStreak}). Resetting session.`
      );
      if (emptyStreak >= 3) {
        if (BATCH > 500) {
          BATCH = Math.max(500, Math.floor(BATCH / 2));
          emptyStreak = 0;
          console.warn(`Reducing batch size to ${BATCH} and continuing.`);
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
    if (BATCH > 1000) {
      BATCH = Math.max(1000, Math.floor(BATCH / 2));
      console.warn(`Reducing batch size to ${BATCH} after error.`);
    }
    await new Promise((r) => setTimeout(r, 10000));
    remaining = await remainingCount();
  }
}

console.log(
  `DONE totalOrders=${totalOrders} totalEntries=${totalEntries} elapsedSec=${(
    (Date.now() - started) /
    1000
  ).toFixed(1)}`
);
process.exit(0);
