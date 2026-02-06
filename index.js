// Uncomment next line if you use local .env with dotenv:
require("dotenv").config();

/**
 * BMS Monitor -> Telegram notifier
 *
 * - Polls /bsync every N seconds (default 10s) using multipart form r00=99
 * - Sends Telegram notifications (group supported via TELEGRAM_CHAT_ID)
 * - Notifies:
 *   - Charge started (Bat_Watt > deadband)
 *   - Discharge started (Bat_Watt < -deadband)
 *   - Each 10% boundary crossed up/down while charging/discharging
 * - Endpoint failover:
 *   - If current port fails, tries ports 1010/1030/1040 (configurable)
 *   - Remembers new port in memory (until process restart)
 * - Sends "endpoint unreachable" only after 5 minutes of consecutive failures
 * - More logs: logs every successful poll + detailed failure streak logs
 *
 * Notifications and code comments are in English as requested.
 */

const HOST = process.env.BMS_HOST || "178.212.196.134";
const PATH = process.env.BMS_PATH || "/bsync";

const DEFAULT_PORT = Number(process.env.BMS_PORT || 1020);
const FALLBACK_PORTS = (process.env.BMS_FALLBACK_PORTS || "1010,1030,1040")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n));

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 4_000);

// Deadband to prevent flapping around 0W
const WATT_DEADBAND = Number(process.env.WATT_DEADBAND || 5);

// Send "unreachable" alert only after N ms of consecutive failures
const DOWN_ALERT_AFTER_MS = Number(process.env.DOWN_ALERT_AFTER_MS || 30 * 60 * 1000);

// Logging
const LOG_EVERY_POLL = (process.env.LOG_EVERY_POLL ?? "1") !== "0"; // default ON
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase(); // debug|info|warn|error

// Telegram config
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- runtime state ---
let currentPort = DEFAULT_PORT;

let lastMode = "unknown"; // charge | discharge | idle | unknown
let lastLevel = null; // integer 0..100

// Boundaries notified within the current charge/discharge session
let sessionNotified = new Set();

// Failure streak state
let consecutiveFailures = 0;
let firstFailureAt = null; // ms timestamp when the current failure streak started
let downAlertSent = false;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function nowMs() {
    return Date.now();
}

function fmtMs(ms) {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m < 60) return `${m}m${remS}s`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}h${remM}m`;
}

function log(level, ...args) {
    const order = { debug: 10, info: 20, warn: 30, error: 40 };
    const cur = order[LOG_LEVEL] ?? 20;
    const lvl = order[level] ?? 20;
    if (lvl < cur) return;

    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
    console.log(prefix, ...args);
}

function buildUrl(port) {
    return `http://${HOST}:${port}${PATH}`;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Compute battery level in %.
 * Prefer BMS-provided Batt_SOC if present.
 * Otherwise compute from remaining Ah / total Ah.
 */
function computeLevel(stats) {
    const lvl = toNumber(stats.Batt_SOC);
    if (lvl !== null) return clamp(Math.round(lvl), 0, 100);

    const rcap = toNumber(stats.Bat_RCap);
    const cap = toNumber(stats.Batt_Cap);
    if (rcap !== null && cap !== null && cap > 0) {
        return clamp(Math.round((rcap / cap) * 100), 0, 100);
    }

    return null;
}

/**
 * Detect current mode based on Bat_Watt.
 * Positive => charge, negative => discharge, near 0 => idle.
 */
function detectMode(batWatt) {
    if (batWatt === null) return "unknown";
    if (batWatt > WATT_DEADBAND) return "charge";
    if (batWatt < -WATT_DEADBAND) return "discharge";
    return "idle";
}

/**
 * Get minimal cell voltage from keys "1".."Cel_Coun".
 */
function getMinCellVoltage(stats) {
    const n = Number(stats.Cel_Coun || 0);
    if (!Number.isFinite(n) || n <= 0) return null;

    let min = Infinity;
    for (let i = 1; i <= n; i++) {
        const v = Number(stats[String(i)]);
        if (Number.isFinite(v) && v < min) min = v;
    }
    return min === Infinity ? null : min;
}

/**
 * Format a compact metrics line (power/current/voltage/deltaV/minCell).
 */
function fmtMetricsLine(stats) {
    const v = toNumber(stats.Bat_TVol);
    const a = toNumber(stats.Bat_CurD);
    const w = toNumber(stats.Bat_Watt);
    const dv = toNumber(stats.Cel_DifV);
    const minCell = getMinCellVoltage(stats);

    const parts = [];
    if (w !== null) parts.push(`P ${w >= 0 ? "+" : ""}${w.toFixed(0)} W`);
    if (a !== null) parts.push(`I ${a >= 0 ? "+" : ""}${a.toFixed(1)} A`);
    if (v !== null) parts.push(`V ${v.toFixed(2)} V`);
    if (dv !== null) parts.push(`ΔV ${dv.toFixed(3)} V`);
    if (minCell !== null) parts.push(`Min ${minCell.toFixed(3)} V`);

    return parts.join(" • ");
}

/**
 * "Level 81% (226.8 / 280.0 Ah)"
 */
function fmtLevelLine(stats, level) {
    const rcap = toNumber(stats.Bat_RCap);
    const cap = toNumber(stats.Batt_Cap);

    const levelPart = level !== null ? `Level ${level}%` : `Level ?%`;
    const capPart =
        rcap !== null && cap !== null ? `(${rcap.toFixed(1)} / ${cap.toFixed(1)} Ah)` : "";

    return `${levelPart}  ${capPart}`.trim();
}

function fmtTimeLine(stats) {
    return `🕒 ${stats.datetime || new Date().toISOString()}`;
}

function msgStart(mode, stats, level) {
    const title = mode === "charge" ? "⚡ CHARGE STARTED" : "🔋 DISCHARGE STARTED";
    return [title, fmtLevelLine(stats, level), fmtMetricsLine(stats), fmtTimeLine(stats)].join("\n");
}

function msgThreshold(dir, boundary, stats, level) {
    // dir: "down" | "up"
    const title = dir === "down" ? `📉 LEVEL ↓ ${boundary}%` : `📈 LEVEL ↑ ${boundary}%`;

    const rcap = toNumber(stats.Bat_RCap);
    const cap = toNumber(stats.Batt_Cap);
    const capLine =
        rcap !== null && cap !== null ? `${rcap.toFixed(1)} / ${cap.toFixed(1)} Ah` : fmtLevelLine(stats, level);

    return [title, capLine, fmtMetricsLine(stats), fmtTimeLine(stats)].join("\n");
}

async function sendTelegram(text) {
    if (!TG_TOKEN || !TG_CHAT_ID) {
        log("warn", "Telegram config missing. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
        return;
    }

    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const body = {
        chat_id: TG_CHAT_ID, // group chat_id is usually negative (-100...)
        text,
        disable_web_page_preview: true,
    };

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const t = await res.text().catch(() => "");
        log("error", "Telegram send failed:", res.status, t);
    }
}

async function fetchWithTimeout(url, opts, timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
        clearTimeout(id);
    }
}

function makeMultipartBody(fields) {
    // Minimal multipart/form-data builder (no external deps)
    const boundary = "----bmsBoundary" + Math.random().toString(16).slice(2);
    const chunks = [];

    for (const [key, value] of Object.entries(fields)) {
        chunks.push(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
            `${value}\r\n`
        );
    }
    chunks.push(`--${boundary}--\r\n`);

    return {
        body: chunks.join(""),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

async function tryFetchStatsOnPort(port) {
    const url = buildUrl(port);
    const mp = makeMultipartBody({ r00: "99" });

    const res = await fetchWithTimeout(
        url,
        {
            method: "POST",
            headers: { "Content-Type": mp.contentType },
            body: mp.body,
        },
        REQUEST_TIMEOUT_MS
    );

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} on ${url}`);
    }

    return await res.json();
}

async function fetchStatsWithPortFailover() {
    const portsToTry = [currentPort, ...FALLBACK_PORTS.filter((p) => p !== currentPort)];
    let lastErr = null;

    for (const p of portsToTry) {
        try {
            const stats = await tryFetchStatsOnPort(p);

            if (p !== currentPort) {
                const old = currentPort;
                currentPort = p;
                // Inform about port switch
                await sendTelegram(`✅ BMS endpoint recovered. Switched port from ${old} to ${p}.`);
                log("info", `Port switched: ${old} -> ${p}`);
            }

            return stats;
        } catch (err) {
            lastErr = err;
            log("debug", `Port ${p} failed:`, err?.message || err);
        }
    }

    throw lastErr || new Error("All ports failed");
}

function resetSession() {
    sessionNotified = new Set();
}

async function handleCycle(stats) {
    const level = computeLevel(stats);
    const batWatt = toNumber(stats.Bat_Watt);
    const mode = detectMode(batWatt);

    // Log every successful poll (compact)
    if (LOG_EVERY_POLL) {
        const rcap = toNumber(stats.Bat_RCap);
        const cap = toNumber(stats.Batt_Cap);
        const dv = toNumber(stats.Cel_DifV);
        const minCell = getMinCellVoltage(stats);
        log(
            "info",
            `OK port=${currentPort} mode=${mode} level=${level ?? "?"}% watt=${batWatt ?? "?"}W ` +
            `rcap=${rcap ?? "?"}Ah cap=${cap ?? "?"}Ah ΔV=${dv ?? "?"} minCell=${minCell ?? "?"}`
        );
    }

    // Mode change notifications (only for charge/discharge start)
    if (mode !== lastMode) {
        if (mode === "discharge") {
            resetSession();
            await sendTelegram(msgStart("discharge", stats, level));
            log("info", "Discharging started (notified)");
        } else if (mode === "charge") {
            resetSession();
            await sendTelegram(msgStart("charge", stats, level));
            log("info", "Charging started (notified)");
        } else {
            log("info", `Mode changed: ${lastMode} -> ${mode}`);
        }
        lastMode = mode;
    }

    // 10% boundaries notifications
    if (level !== null && lastLevel !== null) {
        if (mode === "discharge") {
            for (let b = 90; b >= 0; b -= 10) {
                if (lastLevel > b && level <= b && !sessionNotified.has(`D${b}`)) {
                    sessionNotified.add(`D${b}`);
                    await sendTelegram(msgThreshold("down", b, stats, level));
                    log("info", `Boundary (discharge) reached: ${b}% (notified)`);
                }
            }
        } else if (mode === "charge") {
            for (let b = 10; b <= 100; b += 10) {
                if (lastLevel < b && level >= b && !sessionNotified.has(`C${b}`)) {
                    sessionNotified.add(`C${b}`);
                    await sendTelegram(msgThreshold("up", b, stats, level));
                    log("info", `Boundary (charge) reached: ${b}% (notified)`);
                }
            }
        }
    }

    lastLevel = level;
}

async function main() {
    log("info", "Starting BMS monitor...");
    log("info", {
        HOST,
        PATH,
        DEFAULT_PORT,
        FALLBACK_PORTS,
        POLL_INTERVAL_MS,
        REQUEST_TIMEOUT_MS,
        WATT_DEADBAND,
        DOWN_ALERT_AFTER_MS,
        LOG_LEVEL,
        LOG_EVERY_POLL,
    });

    // Avoid crashing on unhandled errors
    process.on("unhandledRejection", (err) => log("error", "unhandledRejection:", err));
    process.on("uncaughtException", (err) => log("error", "uncaughtException:", err));

    while (true) {
        try {
            const stats = await fetchStatsWithPortFailover();

            // SUCCESS => reset failure streak
            if (consecutiveFailures > 0) {
                log("warn", `Recovered after ${consecutiveFailures} failures over ${fmtMs(nowMs() - firstFailureAt)}.`);
            }
            consecutiveFailures = 0;
            firstFailureAt = null;

            // If we already sent "down" alert, notify recovery immediately
            if (downAlertSent) {
                downAlertSent = false;
                await sendTelegram(`✅ BMS endpoint is reachable again on port ${currentPort}.`);
            }

            await handleCycle(stats);
        } catch (err) {
            const t = nowMs();

            // FAILURE => update streak
            if (consecutiveFailures === 0) firstFailureAt = t;
            consecutiveFailures += 1;

            const streakMs = t - firstFailureAt;
            const portsTried = [currentPort, ...FALLBACK_PORTS]
                .filter((v, i, a) => a.indexOf(v) === i)
                .join(",");

            log(
                "warn",
                `Fetch failed (#${consecutiveFailures}, streak=${fmtMs(streakMs)}). Tried ports: ${portsTried}. Error:`,
                err?.message || err
            );

            // Send Telegram only after 5 minutes of consecutive failures
            if (!downAlertSent && streakMs >= DOWN_ALERT_AFTER_MS) {
                downAlertSent = true;
                await sendTelegram(
                    `⚠️ BMS endpoint is unreachable for ${fmtMs(streakMs)} (consecutive). ` +
                    `Tried ports: ${portsTried}. Will keep retrying every ${Math.round(POLL_INTERVAL_MS / 1000)}s.`
                );
                log("error", `Down alert sent after streak=${fmtMs(streakMs)}.`);
            }
        }

        await sleep(POLL_INTERVAL_MS);
    }
}

main();
