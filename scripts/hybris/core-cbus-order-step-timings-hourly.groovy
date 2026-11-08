/**
 * Hourly core_cbus order step-timings report (CREATE + MODIFY).
 *
 * Window: past 1 hour of SUCCEEDED OrderProcess rows for store core_cbus.
 * Outputs CSV (same columns as scripts/export-core-cbus-order-step-timings.mjs),
 * emails it to a configured recipient, and uploads to S3.
 *
 * Schedule via ScriptingJob + CronJob (see companion ImpEx).
 *
 * Optional hybris config (local.properties / CCV2 aspect) — hardcoded fallbacks:
 *   order.timings.report.store=core_cbus
 *   order.timings.report.hoursBack=1
 *   order.timings.report.email.to=a@bayer.com,b@bayer.com  (comma or semicolon list)
 *   order.timings.report.email.from=donot-reply@channelarrow.com
 *   order.timings.report.email.cc=   (optional; same list format)
 *   order.timings.report.skipEmail=false
 *   order.timings.report.skipS3=false
 *   order.timings.report.s3.bucket=channel-us-order-step-timings
 *   order.timings.report.s3.region=us-east-1
 *   order.timings.report.s3.prefix=   (empty = upload at bucket root)
 *
 * S3 credentials: NOT stored in properties. Uploads go through bean
 * bayerAmazonS3Service → BayerAmazonS3IntServiceImpl.getOneDCEs3Client(),
 * which reads Vault secret at Config key onedce.aws.path
 * (d1: secret/explorers_onedce/aws-np, p1: .../aws-prod) and uses vault fields
 * accessKeyId / secretAccessKey. vault.url must already be configured.
 *
 * Email: same path as coreUsOrderMonitorScript —
 *   bayerEmailService + com.bayer.integration.Email (+ EmailAttachment base64).
 *   From address defaults to onedce.general.mailbox.
 */

import com.amazonaws.regions.Regions
import com.amazonaws.services.s3.model.ObjectMetadata
import com.bayer.integration.Email
import com.bayer.integration.EmailAttachment
import de.hybris.platform.servicelayer.search.FlexibleSearchQuery
import de.hybris.platform.processengine.enums.ProcessState
import de.hybris.platform.core.PK
import de.hybris.platform.util.Config

import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.TimeZone
import java.util.UUID
import java.util.regex.Pattern

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
def cfg = { String key, String defVal = '' ->
    def v = Config.getParameter(key)
    (v == null || v.trim().isEmpty()) ? defVal : v.trim()
}
def cfgBool = { String key, boolean defVal ->
    def v = cfg(key, String.valueOf(defVal))
    'true'.equalsIgnoreCase(v) || '1'.equals(v) || 'yes'.equalsIgnoreCase(v)
}
/** Parse comma- and/or semicolon-separated email list into distinct trimmed addresses. */
def parseEmailList = { String raw ->
    if (!raw) return []
    raw.split('[,;]')
        .collect { it?.trim() }
        .findAll { it }
        .unique()
}

// Dedicated report bucket — upload CSV at bucket root (no subfolder by default)
final String DEFAULT_S3_BUCKET = 'channel-us-order-step-timings'
final String DEFAULT_S3_REGION = 'us-east-1'
final String DEFAULT_S3_PREFIX = ''

final String STORE = cfg('order.timings.report.store', 'core_cbus')
final int HOURS_BACK = Integer.parseInt(cfg('order.timings.report.hoursBack', '1'))
final List EMAIL_TO = parseEmailList(cfg('order.timings.report.email.to', 'punit.dwivedi.ext@bayer.com'))
final String EMAIL_FROM = cfg('order.timings.report.email.from', 'donot-reply@channelarrow.com')
final List EMAIL_CC = parseEmailList(cfg('order.timings.report.email.cc', ''))
final String S3_BUCKET = cfg('order.timings.report.s3.bucket', DEFAULT_S3_BUCKET)
final String S3_REGION = cfg('order.timings.report.s3.region', DEFAULT_S3_REGION)
final String S3_PREFIX = cfg('order.timings.report.s3.prefix', DEFAULT_S3_PREFIX)
final String VAULT_AWS_PATH = cfg('onedce.aws.path', '')
final boolean SKIP_EMAIL = cfgBool('order.timings.report.skipEmail', false)
final boolean SKIP_S3 = cfgBool('order.timings.report.skipS3', false)

def fss = spring.getBean('flexibleSearchService')
def log = org.slf4j.LoggerFactory.getLogger('coreCbusOrderStepTimingsHourly')

Calendar windowEnd = Calendar.getInstance()
Calendar windowStart = Calendar.getInstance()
windowStart.add(Calendar.HOUR_OF_DAY, -HOURS_BACK)
Date since = windowStart.getTime()
Date until = windowEnd.getTime()

def isoUtc = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
isoUtc.setTimeZone(TimeZone.getTimeZone('UTC'))
def fileStamp = new SimpleDateFormat('yyyyMMdd-HHmm')
fileStamp.setTimeZone(TimeZone.getTimeZone('UTC'))
String fileName = "core_cbus-order-step-timings-${fileStamp.format(until)}.csv"
String windowLabel = "${isoUtc.format(since)} → ${isoUtc.format(until)} (UTC)"

log.info("Order timings report starting store={} window={}", STORE, windowLabel)

// ---------------------------------------------------------------------------
// CSV helpers (aligned with Node export)
// ---------------------------------------------------------------------------
final List HEADER = [
    'orderCode', 'sapOrderNumber', 'kind', 'processCode', 'processDefinition', 'processState',
    'cartSubmitAt', 'orderConvertedAt', 'cartToOrderMs',
    'orderCreated', 'modSubmitted', 'processCreated', 'processModified',
    'commercePersistToBpMs', 'bpTriggerToFirstTaskMs', 'processCreatedToFirstErpMs', 'processWallMs',
    'step1_name', 'step1_apiMs', 'step1_wallMs', 'step1_status',
    'step2_name', 'step2_apiMs', 'step2_wallMs', 'step2_status',
    'step3_name', 'step3_apiMs', 'step3_wallMs', 'step3_status',
    'step4_name', 'step4_apiMs', 'step4_wallMs', 'step4_status',
    'step5_name', 'step5_apiMs', 'step5_wallMs', 'step5_status',
    'erpApiMsSum', 'sendOrderToSAP_ms', 'odataBatch_ms', 'lcrDiscount_ms',
    'brandAndSfDiscount_ms', 'prepayFinancing_ms', 'taskActions'
]

def csvEscape = { Object v ->
    if (v == null) return ''
    String s = String.valueOf(v)
    if (s.isEmpty()) return ''
    if (s.contains('"') || s.contains(',') || s.contains('\n') || s.contains('\r')) {
        return '"' + s.replace('"', '""') + '"'
    }
    return s
}

def parseIsoDate = { String s ->
    if (!s) return null
    try {
        // 2026-11-06T22:22:05.713Z or with offset
        String norm = s.trim()
        if (norm.endsWith('Z')) {
            return Date.from(java.time.Instant.parse(norm))
        }
        if (norm.length() >= 19 && norm.charAt(10) == ('T' as char)) {
            return Date.from(java.time.OffsetDateTime.parse(norm).toInstant())
        }
    } catch (ignored) {}
    try {
        def f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX")
        return f.parse(s)
    } catch (ignored) {}
    try {
        def f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
        f.setTimeZone(TimeZone.getTimeZone('UTC'))
        return f.parse(s)
    } catch (ignored) {}
    null
}

def parseHybrisDate = { Object o ->
    if (o == null) return null
    if (o instanceof Date) return (Date) o
    String s = String.valueOf(o).trim()
    if (s.isEmpty()) return null
    if (s.contains('T')) {
        Date iso = parseIsoDate(s)
        if (iso != null) return iso
    }
    // Fri Nov 06 16:22:13 CST 2026
    try {
        return new SimpleDateFormat('EEE MMM dd HH:mm:ss zzz yyyy', Locale.ENGLISH).parse(s)
    } catch (ignored) {}
    try {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").parse(s)
    } catch (ignored) {}
    null
}

def formatTs = { Date d -> d == null ? '' : isoUtc.format(d) }

/** Elapsed ms between two timestamps; empty if missing/negative or > 1h. */
def msBetween = { Date a, Date b ->
    if (a == null || b == null) return ''
    long ms = b.time - a.time
    if (ms < 0 || Math.abs(ms) > 3_600_000L) return ''
    String.valueOf(ms)
}

/** Non-negative elapsed ms between two timestamps. */
def msDur = { Date a, Date b ->
    if (a == null || b == null) return ''
    String.valueOf(Math.max(0L, b.time - a.time))
}

def parseCartSubmitAt = { String msg ->
    if (!msg) return null
    def m = (msg =~ /ZZ1_C2C_SAT_TECID_HDR[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+)/)
    if (!m.find()) {
        m = (msg =~ /(?i)satelliteCreationTechID[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+)/)
        if (!m.find()) return null
    }
    parseIsoDate(m.group(1))
}

def todMs = { String t ->
    if (!t) return null
    def parts = t.split(':')
    if (parts.length < 3) return null
    def secMs = parts[2].split('\\.')
    int h = parts[0] as int
    int m = parts[1] as int
    int s = secMs[0] as int
    int ms = secMs.length > 1 ? (secMs[1] as int) : 0
    h * 3600_000L + m * 60_000L + s * 1000L + ms
}

def parseCreateSteps = { String logMsg ->
    def stepNames = ['', '', '', '', '']
    def stepApi = ['', '', '', '', '']
    def stepWall = ['', '', '', '', '']
    def stepStatus = ['', '', '', '', '']
    long erpApiMsSum = 0
    if (!logMsg) {
        return [stepNames: stepNames, stepApi: stepApi, stepWall: stepWall, stepStatus: stepStatus, erpApiMsSum: erpApiMsSum]
    }
    Integer currentStep = null
    def apiByStep = [:]
    def nameByStep = [:]
    def statusByStep = [:]
    def startTs = [:]
    def endTs = [:]
    def tsRe = Pattern.compile(/(\d{2}:\d{2}:\d{2}\.\d{3})/)

    logMsg.readLines().each { line ->
        def tsM = tsRe.matcher(line)
        String ts = tsM.find() ? tsM.group(1) : null
        def stM = (line =~ /(?i)Step\s+(\d+)\/5\s+\[([^\]]+)\].*STARTING/)
        if (stM.find()) {
            int n = stM.group(1) as int
            currentStep = n
            nameByStep[n] = stM.group(2)
            if (ts) startTs[n] = ts
        }
        def dnM = (line =~ /(?i)Step\s+(\d+)\s+\[([^\]]+)\].*(COMPLETED SUCCESSFULLY|FAILED)/)
        if (dnM.find()) {
            int n = dnM.group(1) as int
            statusByStep[n] = dnM.group(3).toUpperCase().startsWith('COMPLETED') ? 'SUCCESS' : 'FAILED'
            nameByStep[n] = nameByStep[n] ?: dnM.group(2)
            if (ts) endTs[n] = ts
        }
        def tmM = (line =~ /(?i)time taken\s+(\d+)\s+ms/)
        if (tmM.find() && currentStep != null) {
            apiByStep[currentStep] = (apiByStep[currentStep] ?: 0L) + (tmM.group(1) as long)
        }
    }
    (1..5).each { int n ->
        stepNames[n - 1] = nameByStep[n] ?: ''
        if (apiByStep[n] != null) {
            stepApi[n - 1] = String.valueOf(apiByStep[n])
            erpApiMsSum += apiByStep[n]
        }
        stepStatus[n - 1] = statusByStep[n] ?: ''
        Long a = todMs(startTs[n] as String)
        Long b = todMs(endTs[n] as String)
        if (a != null && b != null) {
            long d = b - a
            if (d < 0) d += 24L * 3600_000L
            stepWall[n - 1] = String.valueOf(d)
        }
    }
    [stepNames: stepNames, stepApi: stepApi, stepWall: stepWall, stepStatus: stepStatus, erpApiMsSum: erpApiMsSum]
}

def keepActions = [
    'sendOrderToSAP', 'odataBatchStandard', 'odataBatchSplitBill',
    'lcrDiscount', 'brandAndSfDiscount', 'prepayFinancing'
] as Set

def compactLog = { String msg ->
    if (!msg) return ''
    def lines = msg.readLines().findAll { line ->
        line.contains('Step ') || line.contains('time taken') || line.contains('OrderCreationChain') ||
            line.contains('STARTING') || line.contains('COMPLETED') || line.contains('FAILED') ||
            line.contains('Calling S4 API') || line.contains('Calling SalesForce API') ||
            line.contains('SAT_TECID') || line.contains('satelliteCreation') ||
            line.contains('executing for order')
    }
    String c = lines.join('\n')
    c.length() > 14000 ? c.substring(0, 14000) : c
}

def loadTasks = { PK processPk ->
    def lq = new FlexibleSearchQuery(
        'SELECT {actionId},{startDate},{endDate},{returnCode},{logMessages} FROM {ProcessTaskLog} WHERE {process}=?p ORDER BY {startDate} ASC'
    )
    lq.addQueryParameter('p', processPk)
    lq.setResultClassList([String.class, Date.class, Date.class, String.class, String.class])
    fss.search(lq).result.collect { tl ->
        String action = tl[0] ?: ''
        String msg = ''
        if (keepActions.contains(action) && tl[4]) {
            msg = compactLog(String.valueOf(tl[4]))
        }
        [
            action: action,
            start : tl[1] as Date,
            end   : tl[2] as Date,
            rc    : tl[3] ?: '',
            msg   : msg
        ]
    }
}

def buildRow = { Map proc, List tasks ->
    boolean isCreate = proc.kind == 'CREATE'
    Date firstTask = null
    Date lastTask = null
    Date firstErp = null
    def actionDurs = [:] as Map
    def apiMsByAction = [:] as Map
    def taskNames = []
    String sendMsg = ''
    StringBuilder allErpMsg = new StringBuilder()

    (tasks ?: []).each { t ->
        taskNames << "${t.action}:${t.rc}"
        Date s = t.start instanceof Date ? t.start : parseHybrisDate(t.start)
        Date e = t.end instanceof Date ? t.end : parseHybrisDate(t.end)
        if (s && (!firstTask || s.before(firstTask))) firstTask = s
        if (e && (!lastTask || e.after(lastTask))) lastTask = e
        if (s && e) {
            actionDurs[t.action] = (actionDurs[t.action] ?: 0L) + (e.time - s.time)
        }
        boolean erpish = keepActions.contains(t.action)
        if (erpish && s && (!firstErp || s.before(firstErp))) firstErp = s
        if (t.msg) {
            allErpMsg.append('\n').append(t.msg)
            long sum = 0
            def mm = (t.msg =~ /(?i)time taken\s+(\d+)\s+ms/)
            while (mm.find()) sum += mm.group(1) as long
            if (sum > 0) apiMsByAction[t.action] = (apiMsByAction[t.action] ?: 0L) + sum
        }
        if (t.action == 'sendOrderToSAP' && t.msg) sendMsg = t.msg
    }

    def stepNames = ['', '', '', '', '']
    def stepApi = ['', '', '', '', '']
    def stepWall = ['', '', '', '', '']
    def stepStatus = ['', '', '', '', '']
    long erpApiMsSum = 0

    if (isCreate) {
        def parsed = parseCreateSteps(sendMsg)
        stepNames = parsed.stepNames
        stepApi = parsed.stepApi
        stepWall = parsed.stepWall
        stepStatus = parsed.stepStatus
        erpApiMsSum = parsed.erpApiMsSum as long
    } else {
        def mapping = [
            ['prepayFinancing', 'Prepay / Brand Financing'],
            ['odataBatchStandard', 'OData Batch Modify (Sales Order)'],
            ['odataBatchSplitBill', 'OData Batch Split Bill'],
            ['lcrDiscount', 'LCR Discount'],
            ['brandAndSfDiscount', 'Brand & SF Discount']
        ]
        mapping.eachWithIndex { pair, idx ->
            String action = pair[0]
            String name = pair[1]
            long durMs = (actionDurs[action] ?: 0L) as long
            long api = (apiMsByAction[action] ?: 0L) as long
            if (durMs > 0 || api > 0) {
                stepNames[idx] = name
                stepWall[idx] = durMs > 0 ? String.valueOf(durMs) : ''
                stepApi[idx] = api > 0 ? String.valueOf(api) : ''
                stepStatus[idx] = 'SUCCESS'
                erpApiMsSum += api
            }
        }
    }

    Date orderCreated = parseHybrisDate(proc.orderCreated)
    Date modSubmitted = parseHybrisDate(proc.modSubmitted)
    Date procCreated = parseHybrisDate(proc.procCreated)

    Date satFromLog = parseCartSubmitAt(sendMsg) ?: parseCartSubmitAt(allErpMsg.toString())
    Date cartSubmitAt = isCreate ? (satFromLog ?: procCreated) : (modSubmitted ?: satFromLog ?: procCreated)
    Date orderConvertedAt = procCreated ?: orderCreated
    String cartToOrderMs = msBetween(cartSubmitAt, orderConvertedAt)
    Date anchor = isCreate ? (cartSubmitAt ?: orderCreated) : (modSubmitted ?: cartSubmitAt ?: orderCreated)
    long odataMs = ((actionDurs.odataBatchStandard ?: 0L) as long) + ((actionDurs.odataBatchSplitBill ?: 0L) as long)

    [
        proc.orderCode, proc.sapOrderNumber, proc.kind, proc.processCode, proc.defName, proc.state,
        formatTs(cartSubmitAt), formatTs(orderConvertedAt), cartToOrderMs,
        proc.orderCreatedStr, proc.modSubmittedStr, proc.procCreatedStr, proc.procModifiedStr,
        msBetween(anchor, procCreated),
        msDur(procCreated, firstTask),
        msDur(procCreated, firstErp),
        msDur(firstTask, lastTask),
        stepNames[0], stepApi[0], stepWall[0], stepStatus[0],
        stepNames[1], stepApi[1], stepWall[1], stepStatus[1],
        stepNames[2], stepApi[2], stepWall[2], stepStatus[2],
        stepNames[3], stepApi[3], stepWall[3], stepStatus[3],
        stepNames[4], stepApi[4], stepWall[4], stepStatus[4],
        erpApiMsSum > 0 ? String.valueOf(erpApiMsSum) : '',
        actionDurs.sendOrderToSAP ? String.valueOf(actionDurs.sendOrderToSAP as long) : '',
        odataMs > 0 ? String.valueOf(odataMs) : '',
        actionDurs.lcrDiscount ? String.valueOf(actionDurs.lcrDiscount as long) : '',
        actionDurs.brandAndSfDiscount ? String.valueOf(actionDurs.brandAndSfDiscount as long) : '',
        actionDurs.prepayFinancing ? String.valueOf(actionDurs.prepayFinancing as long) : '',
        taskNames.join('|')
    ].collect { csvEscape(it) }.join(',')
}

// ---------------------------------------------------------------------------
// Query processes in window
// ---------------------------------------------------------------------------
def listQ = new FlexibleSearchQuery('''
SELECT {op.pk}, {op.code}, {op.processDefinitionName}, {op.creationtime}, {op.modifiedtime},
       {o.code}, {o.creationtime}, {o.modificationSubmitionTime}
FROM {OrderProcess AS op JOIN Order AS o ON {op.order}={o.pk} JOIN BaseStore AS s ON {o.store}={s.pk}}
WHERE {s.uid}=?store AND {op.creationtime}>=?since AND {op.creationtime}<?until AND {op.state}=?st
ORDER BY {op.creationtime} ASC
''')
listQ.addQueryParameter('store', STORE)
listQ.addQueryParameter('since', since)
listQ.addQueryParameter('until', until)
listQ.addQueryParameter('st', ProcessState.SUCCEEDED)
listQ.setResultClassList([
    PK.class, String.class, String.class, Date.class, Date.class,
    String.class, Date.class, Date.class
])
listQ.setNeedTotal(false)

def processes = fss.search(listQ).result
log.info("Found {} succeeded OrderProcess rows in window", processes.size())

StringBuilder csv = new StringBuilder()
csv.append(HEADER.join(',')).append('\n')
int written = 0

processes.each { r ->
    PK pk = r[0] as PK
    String defName = r[2] ?: ''
    String orderCode = r[5] ?: ''
    Date procCreated = r[3] as Date
    Date procModified = r[4] as Date
    Date orderCreated = r[6] as Date
    Date modSubmitted = r[7] as Date
    Map proc = [
        pk               : pk,
        processCode      : r[1] ?: '',
        defName          : defName,
        state            : 'SUCCEEDED',
        procCreated      : procCreated,
        procModified     : procModified,
        orderCode        : orderCode,
        orderCreated     : orderCreated,
        modSubmitted     : modSubmitted,
        procCreatedStr   : procCreated ? String.valueOf(procCreated) : '',
        procModifiedStr  : procModified ? String.valueOf(procModified) : '',
        orderCreatedStr  : orderCreated ? String.valueOf(orderCreated) : '',
        modSubmittedStr  : modSubmitted ? String.valueOf(modSubmitted) : '',
        sapOrderNumber   : orderCode.startsWith('S2-') ? orderCode.substring(3) : '',
        kind             : defName.contains('sap-order-process') ? 'CREATE' : 'MODIFY'
    ]
    def tasks = loadTasks(pk)
    csv.append(buildRow(proc, tasks)).append('\n')
    written++
}

byte[] csvBytes = csv.toString().getBytes(StandardCharsets.UTF_8)
log.info("CSV built rows={} bytes={} file={}", written, csvBytes.length, fileName)

def results = [rows: written, fileName: fileName, email: 'skipped', s3: 'skipped']

// ---------------------------------------------------------------------------
// Email via bayerEmailService (same path as coreUsOrderMonitorScript)
// ---------------------------------------------------------------------------
def sendEmail = {
    if (SKIP_EMAIL) {
        results.email = 'skipped-by-config'
        return
    }
    if (!EMAIL_TO) {
        results.email = 'skipped-no-to'
        log.warn('order.timings.report.email.to not set — skipping email')
        return
    }

    List recipients = new ArrayList<>(EMAIL_TO)
    EMAIL_CC.each { if (it && !recipients.contains(it)) recipients.add(it) }

    try {
        def configurationService = spring.getBean('configurationService')
        def bayerEmailService = spring.getBean('bayerEmailService')
        def env = configurationService.getConfiguration().getString('env', '')
        def from = configurationService.getConfiguration().getString('onedce.general.mailbox')
        if (!from) {
            from = EMAIL_FROM
        }

        String subject = "Order step timings — last ${HOURS_BACK}h — ${fileStamp.format(until)} UTC"
        if (env && !'PRD'.equalsIgnoreCase(env)) {
            subject = '[NON-PROD] ' + subject
        }

        // Inline-styled fragment only (bayerEmailService embeds into an existing template)
        String body = """\
<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;">
<div style="font-size:16px;font-weight:bold;margin-bottom:8px;">Order step timings report</div>
<div style="font-size:13px;line-height:1.6;">
Store: <strong>${STORE}</strong><br/>
Window: ${windowLabel}<br/>
Rows: <strong>${written}</strong><br/>
Attachment: ${fileName}<br/>
All durations are in ms (cartToOrderMs, ERP step api/wall, etc.).
</div>
</div>
""".stripIndent()

        EmailAttachment attachment = new EmailAttachment()
        attachment.setFileName(fileName)
        attachment.setEncoding('base64')
        attachment.setSource(Base64.getEncoder().encodeToString(csvBytes))

        Email email = new Email()
        email.setFromEmail(from)
        email.setSubject(subject)
        email.setEmailList(recipients)
        email.setBody(body)
        email.setAttachments([attachment])

        bayerEmailService.sendEmail(email, 'core_cbus', UUID.randomUUID().toString())
        results.email = "SENT to ${recipients.join(', ')}"
        log.info('Email: {}', results.email)
    } catch (Exception e) {
        results.email = "FAILED: ${e.message}"
        log.error('Email: {}', results.email, e)
    }
}

// ---------------------------------------------------------------------------
// S3 upload via bayerAmazonS3Service (Vault credentials from onedce.aws.path)
// ---------------------------------------------------------------------------
def uploadS3 = {
    if (SKIP_S3) {
        results.s3 = 'skipped-by-config'
        return
    }
    if (!S3_BUCKET) {
        results.s3 = 'skipped-no-bucket'
        log.warn('order.timings.report.s3.bucket not set — skipping S3')
        return
    }
    if (!S3_REGION) {
        results.s3 = 'skipped-no-region'
        log.warn('order.timings.report.s3.region not set — skipping S3')
        return
    }
    if (!VAULT_AWS_PATH) {
        results.s3 = 'skipped-no-vault-path'
        log.warn('onedce.aws.path not set — cannot load AWS credentials from Vault')
        return
    }

    // Object key = optional prefix + fileName (empty prefix => bucket root)
    String prefix = S3_PREFIX ?: ''
    if (prefix && !prefix.endsWith('/')) prefix = prefix + '/'
    String objectKey = prefix + fileName
    results.vaultPath = VAULT_AWS_PATH

    try {
        // Use Vault-backed S3 client directly (avoids MalformedXML when prefix is empty)
        def intSvc = spring.getBean('bayerAmazonS3IntService')
        def m = intSvc.getClass().getDeclaredMethod('getOneDCEs3Client', Regions)
        m.accessible = true
        def s3 = m.invoke(intSvc, Regions.fromName(S3_REGION))

        def meta = new ObjectMetadata()
        meta.setContentLength(csvBytes.length as long)
        meta.setContentType('text/csv')
        s3.putObject(S3_BUCKET, objectKey, new ByteArrayInputStream(csvBytes), meta)

        String uri = "s3://${S3_BUCKET}/${objectKey}"
        results.s3 = uri
        log.info('Uploaded via Vault S3 client (vault={}): {}', VAULT_AWS_PATH, uri)
    } catch (Throwable t) {
        results.s3 = "error-vault-s3:${t.message}"
        log.error('S3 upload via Vault failed (path={}): {}', VAULT_AWS_PATH, t.message, t)
    }
}

try {
    sendEmail()
} catch (Throwable t) {
    results.email = "error:${t.message}"
    log.error('Email failed: {}', t.message, t)
}

try {
    uploadS3()
} catch (Throwable t) {
    results.s3 = "error:${t.message}"
    log.error('S3 failed: {}', t.message, t)
}

String summary = "OK rows=${results.rows} file=${results.fileName} email=${results.email} s3=${results.s3} window=${windowLabel}"
log.info(summary)
return summary
