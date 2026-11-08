/**
 * Export core_cbus create/modify order timings (last N days) from P1.
 * CREATE: parses OrderCreationChain Step 1-5 from sendOrderToSAP task logs.
 * MODIFY: maps ERP ProcessTaskLog actions into step columns.
 */
import fs from "node:fs";
import path from "node:path";
import { HybrisClient } from "../dist/hybris-client.js";

HybrisClient.REQUEST_TIMEOUT_MS = 900000;

const DAYS = Number(process.env.DAYS || 7);
const LIST_PAGE = Number(process.env.LIST_PAGE || 200);
const BATCH = Number(process.env.BATCH || 25);
const OUT =
  process.env.OUT ||
  path.join(
    process.cwd(),
    "data",
    `core_cbus-order-step-timings-last${DAYS}d.csv`,
  );

const baseUrl = process.env.HYBRIS_BASE_URL;
const username = process.env.HYBRIS_USERNAME || "admin";
const password = process.env.HYBRIS_PASSWORD;
if (!baseUrl || !password) {
  console.error(
    "Set HYBRIS_BASE_URL and HYBRIS_PASSWORD (and optionally HYBRIS_USERNAME) before running.",
  );
  process.exit(1);
}

const client = new HybrisClient({
  baseUrl: baseUrl.replace(/\/$/, ""),
  username,
  password,
  baseSiteId: process.env.HYBRIS_BASE_SITE_ID || "cbus",
  catalogId: process.env.HYBRIS_CATALOG_ID || "cbusProductCatalog",
  catalogVersion: process.env.HYBRIS_CATALOG_VERSION || "Online",
  occPath: process.env.HYBRIS_OCC_PATH || "/monsantocommercewebservices/v2",
  hacPath: process.env.HYBRIS_HAC_PATH !== undefined ? process.env.HYBRIS_HAC_PATH : "",
});

function csvEscape(v) {
  if (v == null || v === "") return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const HEADER = [
  "orderCode",
  "sapOrderNumber",
  "kind",
  "processCode",
  "processDefinition",
  "processState",
  "cartSubmitAt",
  "orderConvertedAt",
  "cartToOrderMs",
  "orderCreated",
  "modSubmitted",
  "processCreated",
  "processModified",
  "commercePersistToBpMs",
  "bpTriggerToFirstTaskMs",
  "processCreatedToFirstErpMs",
  "processWallMs",
  "step1_name",
  "step1_apiMs",
  "step1_wallMs",
  "step1_status",
  "step2_name",
  "step2_apiMs",
  "step2_wallMs",
  "step2_status",
  "step3_name",
  "step3_apiMs",
  "step3_wallMs",
  "step3_status",
  "step4_name",
  "step4_apiMs",
  "step4_wallMs",
  "step4_status",
  "step5_name",
  "step5_apiMs",
  "step5_wallMs",
  "step5_status",
  "erpApiMsSum",
  "sendOrderToSAP_ms",
  "odataBatch_ms",
  "lcrDiscount_ms",
  "brandAndSfDiscount_ms",
  "prepayFinancing_ms",
  "taskActions",
];

async function countProcesses() {
  const script = `
import de.hybris.platform.servicelayer.search.FlexibleSearchQuery
import de.hybris.platform.processengine.enums.ProcessState
def fss = spring.getBean('flexibleSearchService')
def startCal = Calendar.getInstance(); startCal.add(Calendar.DAY_OF_YEAR, -${DAYS}); def since = startCal.getTime()
def q = new FlexibleSearchQuery('SELECT COUNT({op.pk}) FROM {OrderProcess AS op JOIN Order AS o ON {op.order}={o.pk} JOIN BaseStore AS s ON {o.store}={s.pk}} WHERE {s.uid}=?store AND {op.creationtime}>=?since AND {op.state}=?st')
q.addQueryParameter('store','core_cbus'); q.addQueryParameter('since', since); q.addQueryParameter('st', ProcessState.SUCCEEDED)
q.setResultClassList([Long.class])
return String.valueOf(fss.search(q).result[0])
`;
  const r = await client.executeGroovyScript(script, false);
  return Number(r.result);
}

async function listProcessPage(offset, count) {
  const script = `
import de.hybris.platform.servicelayer.search.FlexibleSearchQuery
import de.hybris.platform.processengine.enums.ProcessState
import de.hybris.platform.core.PK
def fss = spring.getBean('flexibleSearchService')
def startCal = Calendar.getInstance(); startCal.add(Calendar.DAY_OF_YEAR, -${DAYS}); def since = startCal.getTime()
def q = new FlexibleSearchQuery('SELECT {op.pk}, {op.code}, {op.processDefinitionName}, {op.creationtime}, {op.modifiedtime}, {o.code}, {o.creationtime}, {o.modificationSubmitted}, {o.modificationSubmitionTime} FROM {OrderProcess AS op JOIN Order AS o ON {op.order}={o.pk} JOIN BaseStore AS s ON {o.store}={s.pk}} WHERE {s.uid}=?store AND {op.creationtime}>=?since AND {op.state}=?st ORDER BY {op.creationtime} DESC')
q.addQueryParameter('store','core_cbus'); q.addQueryParameter('since', since); q.addQueryParameter('st', ProcessState.SUCCEEDED)
q.setResultClassList([PK.class, String.class, String.class, Date.class, Date.class, String.class, Date.class, Date.class, Date.class])
q.setStart(${offset})
q.setCount(${count})
q.setNeedTotal(false)
def procs = fss.search(q).result
def sb = new StringBuilder()
procs.each { r ->
  sb.append([r[0], r[1], r[2], 'SUCCEEDED', r[3], r[4], r[5], r[6], r[7], r[8]].collect { it == null ? '' : String.valueOf(it).replace('\\t',' ').replace('\\n',' ') }.join('\\t')).append('\\n')
}
return sb.toString()
`;
  const res = await client.executeGroovyScript(script, false);
  const text = String(res.result || "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const p = line.split("\t");
      return {
        pk: p[0],
        processCode: p[1],
        defName: p[2] || "",
        state: p[3] || "",
        procCreated: p[4] || "",
        procModified: p[5] || "",
        orderCode: p[6] || "",
        orderCreated: p[7] || "",
        modSubmitted: p[8] || p[9] || "",
        sapOrderNumber: (p[6] || "").startsWith("S2-")
          ? (p[6] || "").slice(3)
          : "",
        kind: (p[2] || "").includes("sap-order-process") ? "CREATE" : "MODIFY",
      };
    });
}

function parseCreateSteps(logMsg) {
  const stepNames = ["", "", "", "", ""];
  const stepApi = ["", "", "", "", ""];
  const stepWall = ["", "", "", "", ""];
  const stepStatus = ["", "", "", "", ""];
  if (!logMsg) return { stepNames, stepApi, stepWall, stepStatus, erpApiMsSum: 0 };

  const lines = String(logMsg).split(/\n/);
  let currentStep = null;
  const apiByStep = {};
  const nameByStep = {};
  const statusByStep = {};
  const startTs = {};
  const endTs = {};
  const tsRe = /(\d{2}:\d{2}:\d{2}\.\d{3})/;

  for (const line of lines) {
    const tsM = line.match(tsRe);
    const ts = tsM ? tsM[1] : null;
    const stM = line.match(/Step\s+(\d+)\/5\s+\[([^\]]+)\].*STARTING/i);
    if (stM) {
      const n = Number(stM[1]);
      currentStep = n;
      nameByStep[n] = stM[2];
      if (ts) startTs[n] = ts;
    }
    const dnM = line.match(
      /Step\s+(\d+)\s+\[([^\]]+)\].*(COMPLETED SUCCESSFULLY|FAILED)/i,
    );
    if (dnM) {
      const n = Number(dnM[1]);
      statusByStep[n] = dnM[3].toUpperCase().startsWith("COMPLETED")
        ? "SUCCESS"
        : "FAILED";
      nameByStep[n] = nameByStep[n] || dnM[2];
      if (ts) endTs[n] = ts;
    }
    const tmM = line.match(/time taken\s+(\d+)\s+ms/i);
    if (tmM && currentStep != null) {
      apiByStep[currentStep] = (apiByStep[currentStep] || 0) + Number(tmM[1]);
    }
  }

  const todMs = (t) => {
    if (!t) return null;
    const [h, m, rest] = t.split(":");
    const [s, ms] = rest.split(".");
    return +h * 3600 * 1000 + +m * 60 * 1000 + +s * 1000 + +ms;
  };

  let erpApiMsSum = 0;
  for (let n = 1; n <= 5; n++) {
    stepNames[n - 1] = nameByStep[n] || "";
    if (apiByStep[n] != null) {
      stepApi[n - 1] = String(apiByStep[n]);
      erpApiMsSum += apiByStep[n];
    }
    stepStatus[n - 1] = statusByStep[n] || "";
    const a = todMs(startTs[n]);
    const b = todMs(endTs[n]);
    if (a != null && b != null) {
      let d = b - a;
      if (d < 0) d += 24 * 3600 * 1000;
      stepWall[n - 1] = String(d);
    }
  }
  return { stepNames, stepApi, stepWall, stepStatus, erpApiMsSum };
}

async function enrichBatch(batch) {
  const pks = batch.map((b) => b.pk);
  const script = `
import de.hybris.platform.servicelayer.search.FlexibleSearchQuery
import de.hybris.platform.core.PK
def fss = spring.getBean('flexibleSearchService')
def pks = [${pks.map((pk) => `PK.parse('${pk}')`).join(", ")}]
def out = new StringBuilder()
def keep = ['sendOrderToSAP','odataBatchStandard','odataBatchSplitBill','lcrDiscount','brandAndSfDiscount','prepayFinancing'] as Set
pks.each { pk ->
  def lq = new FlexibleSearchQuery('SELECT {actionId},{startDate},{endDate},{returnCode},{logMessages} FROM {ProcessTaskLog} WHERE {process}=?p ORDER BY {startDate} ASC')
  lq.addQueryParameter('p', pk)
  lq.setResultClassList([String.class, Date.class, Date.class, String.class, String.class])
  def logs = fss.search(lq).result
  out.append('PK=').append(pk).append('\\n')
  logs.each { tl ->
    def action = tl[0] ?: ''
    def s = tl[1] ? String.valueOf(tl[1]) : ''
    def e = tl[2] ? String.valueOf(tl[2]) : ''
    def rc = tl[3] ?: ''
    def msg = tl[4] ?: ''
    def compact = ''
    if (keep.contains(action) && msg) {
      compact = msg.readLines().findAll { line ->
        line.contains('Step ') || line.contains('time taken') || line.contains('OrderCreationChain') || line.contains('STARTING') || line.contains('COMPLETED') || line.contains('FAILED') || line.contains('Calling S4 API') || line.contains('Calling SalesForce API') || line.contains('SAT_TECID') || line.contains('satelliteCreation') || line.contains('executing for order')
      }.collect { it.replace('\\t',' ').replace('|','/') }.join(' || ')
      if (compact.length() > 14000) compact = compact.substring(0, 14000)
    }
    out.append('T|').append(action).append('|').append(s).append('|').append(e).append('|').append(rc).append('|').append(compact).append('\\n')
  }
  out.append('END\\n')
}
return out.toString()
`;
  const res = await client.executeGroovyScript(script, false);
  const text = String(res.result || "");
  const byPk = {};
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("PK=")) {
      cur = line.slice(3);
      byPk[cur] = [];
      continue;
    }
    if (line === "END" || !cur) continue;
    if (!line.startsWith("T|")) continue;
    const parts = line.split("|");
    byPk[cur].push({
      action: parts[1] || "",
      start: parts[2] || "",
      end: parts[3] || "",
      rc: parts[4] || "",
      msg: (parts.slice(5).join("|") || "").replace(/ \|\| /g, "\n"),
    });
  }
  return byPk;
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse ZZ1_C2C_SAT_TECID_HDR / ISO timestamps stamped at cart submit. */
function parseCartSubmitAt(msg) {
  if (!msg) return null;
  const m =
    msg.match(
      /ZZ1_C2C_SAT_TECID_HDR[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+)/,
    ) ||
    msg.match(
      /satelliteCreationTechID[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+)/i,
    );
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatTs(d) {
  if (!d) return "";
  return d.toISOString();
}

function msBetween(a, b) {
  if (!a || !b) return "";
  const ms = b.getTime() - a.getTime();
  if (ms < 0 || Math.abs(ms) > 3600_000) return "";
  return String(ms);
}

function msDur(a, b) {
  if (!a || !b) return "";
  return String(Math.max(0, b.getTime() - a.getTime()));
}

function buildRow(proc, tasks) {
  const isCreate = proc.kind === "CREATE";
  let firstTask = null;
  let lastTask = null;
  let firstErp = null;
  const actionDurs = {};
  const apiMsByAction = {};
  const taskNames = [];
  let sendMsg = "";
  let allErpMsg = "";

  for (const t of tasks || []) {
    taskNames.push(`${t.action}:${t.rc}`);
    const s = parseDate(t.start);
    const e = parseDate(t.end);
    if (s && (!firstTask || s < firstTask)) firstTask = s;
    if (e && (!lastTask || e > lastTask)) lastTask = e;
    if (s && e) actionDurs[t.action] = (actionDurs[t.action] || 0) + (e - s);
    const erpish = [
      "sendOrderToSAP",
      "odataBatchStandard",
      "odataBatchSplitBill",
      "lcrDiscount",
      "brandAndSfDiscount",
      "prepayFinancing",
    ].includes(t.action);
    if (erpish && s && (!firstErp || s < firstErp)) firstErp = s;
    if (t.msg) {
      allErpMsg += `\n${t.msg}`;
      let sum = 0;
      for (const m of t.msg.matchAll(/time taken\s+(\d+)\s+ms/gi)) sum += Number(m[1]);
      if (sum > 0) apiMsByAction[t.action] = (apiMsByAction[t.action] || 0) + sum;
    }
    if (t.action === "sendOrderToSAP" && t.msg) sendMsg = t.msg;
  }

  let stepNames = ["", "", "", "", ""];
  let stepApi = ["", "", "", "", ""];
  let stepWall = ["", "", "", "", ""];
  let stepStatus = ["", "", "", "", ""];
  let erpApiMsSum = 0;

  if (isCreate) {
    const parsed = parseCreateSteps(sendMsg);
    stepNames = parsed.stepNames;
    stepApi = parsed.stepApi;
    stepWall = parsed.stepWall;
    stepStatus = parsed.stepStatus;
    erpApiMsSum = parsed.erpApiMsSum;
  } else {
    const mapping = [
      ["prepayFinancing", "Prepay / Brand Financing"],
      ["odataBatchStandard", "OData Batch Modify (Sales Order)"],
      ["odataBatchSplitBill", "OData Batch Split Bill"],
      ["lcrDiscount", "LCR Discount"],
      ["brandAndSfDiscount", "Brand & SF Discount"],
    ];
    mapping.forEach(([action, name], idx) => {
      if ((actionDurs[action] || 0) > 0 || (apiMsByAction[action] || 0) > 0) {
        stepNames[idx] = name;
        stepWall[idx] = (actionDurs[action] || 0) > 0 ? String(actionDurs[action]) : "";
        stepApi[idx] = (apiMsByAction[action] || 0) > 0 ? String(apiMsByAction[action]) : "";
        stepStatus[idx] = "SUCCESS";
        erpApiMsSum += apiMsByAction[action] || 0;
      }
    });
  }

  const orderCreated = parseDate(proc.orderCreated);
  const modSubmitted = parseDate(proc.modSubmitted);
  const procCreated = parseDate(proc.procCreated);

  // Cart submit → Order conversion in Commerce Cloud
  // CREATE: ZZ1_C2C_SAT_TECID_HDR stamped at place-order; order is converted when BP is created.
  // MODIFY: modificationSubmitted (else processCreated) is modify-cart submit.
  const satFromLog = parseCartSubmitAt(sendMsg) || parseCartSubmitAt(allErpMsg);
  const cartSubmitAt = isCreate
    ? satFromLog || procCreated
    : modSubmitted || satFromLog || procCreated;
  const orderConvertedAt = procCreated || orderCreated;
  const cartToOrderMs = msBetween(cartSubmitAt, orderConvertedAt);

  const anchor = isCreate ? cartSubmitAt || orderCreated : modSubmitted || cartSubmitAt || orderCreated;
  const odataMs =
    (actionDurs.odataBatchStandard || 0) + (actionDurs.odataBatchSplitBill || 0);

  return [
    proc.orderCode,
    proc.sapOrderNumber,
    proc.kind,
    proc.processCode,
    proc.defName,
    proc.state,
    formatTs(cartSubmitAt),
    formatTs(orderConvertedAt),
    cartToOrderMs,
    proc.orderCreated,
    proc.modSubmitted,
    proc.procCreated,
    proc.procModified,
    msBetween(anchor, procCreated),
    msDur(procCreated, firstTask),
    msDur(procCreated, firstErp),
    msDur(firstTask, lastTask),
    stepNames[0],
    stepApi[0],
    stepWall[0],
    stepStatus[0],
    stepNames[1],
    stepApi[1],
    stepWall[1],
    stepStatus[1],
    stepNames[2],
    stepApi[2],
    stepWall[2],
    stepStatus[2],
    stepNames[3],
    stepApi[3],
    stepWall[3],
    stepStatus[3],
    stepNames[4],
    stepApi[4],
    stepWall[4],
    stepStatus[4],
    erpApiMsSum > 0 ? String(erpApiMsSum) : "",
    actionDurs.sendOrderToSAP ? String(actionDurs.sendOrderToSAP) : "",
    odataMs > 0 ? String(odataMs) : "",
    actionDurs.lcrDiscount ? String(actionDurs.lcrDiscount) : "",
    actionDurs.brandAndSfDiscount ? String(actionDurs.brandAndSfDiscount) : "",
    actionDurs.prepayFinancing ? String(actionDurs.prepayFinancing) : "",
    taskNames.join("|"),
  ]
    .map(csvEscape)
    .join(",");
}

const total = await countProcesses();
console.log(`Total succeeded processes (last ${DAYS}d): ${total}`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.createWriteStream(OUT);
out.write(HEADER.join(",") + "\n");

let written = 0;
for (let offset = 0; offset < total; offset += LIST_PAGE) {
  const page = await listProcessPage(offset, LIST_PAGE);
  console.log(`Listed offset=${offset} got=${page.length}`);
  for (let i = 0; i < page.length; i += BATCH) {
    const batch = page.slice(i, i + BATCH);
    let byPk;
    try {
      byPk = await enrichBatch(batch);
    } catch (e) {
      console.error(`Batch failed at ${written}: ${e.message}; retrying...`);
      await new Promise((r) => setTimeout(r, 2500));
      byPk = await enrichBatch(batch);
    }
    for (const proc of batch) {
      out.write(buildRow(proc, byPk[proc.pk] || []) + "\n");
      written++;
    }
    if (written % 100 === 0 || written === total) {
      console.log(`Wrote ${written}/${total}`);
    }
  }
  if (page.length === 0) break;
}
out.end();
await new Promise((resolve) => out.on("finish", resolve));
console.log(`Done rows=${written} -> ${OUT}`);
