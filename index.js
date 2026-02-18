// Uncomment next line if you use local .env with dotenv:
require("dotenv").config();

/**
 * BMS Monitor -> Telegram notifier
 *
 * Key fix for "STARTED spam":
 * - Hysteresis:
 *    - Enter charge if W >= ENTER_WATT
 *    - Leave charge -> idle if W < EXIT_WATT
 *    - Enter discharge if W <= -ENTER_WATT
 *    - Leave discharge -> idle if W > -EXIT_WATT
 * - Debounce:
 *    - Require STABLE_POLLS consecutive polls of the next mode before switching
 *
 * Telegram formatting:
 * - Uses HTML parse_mode + <blockquote> for metrics details (quote style).
 */

const HOST = process.env.BMS_HOST || "178.212.196.134";
const PATH = process.env.BMS_PATH || "/bsync";
const BMS_USER = process.env.BMS_USER;
const BMS_PASS = process.env.BMS_PASS;

const DEFAULT_PORT = Number(process.env.BMS_PORT || 1020);
const FALLBACK_PORTS = (process.env.BMS_FALLBACK_PORTS || "1010,1030,1040")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n));

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 4_000);

// --- MODE DETECTION (your request: 50W threshold) ---
const ENTER_WATT = Number(process.env.ENTER_WATT || 50); // enter charge/discharge
const EXIT_WATT = Number(process.env.EXIT_WATT || 30);   // exit to idle (hysteresis)
const STABLE_POLLS = Number(process.env.STABLE_POLLS || 3);

// Send "unreachable" alert only after N ms of consecutive failures
const DOWN_ALERT_AFTER_MS = Number(process.env.DOWN_ALERT_AFTER_MS || 30 * 60 * 1000);

// --- LOGGING ---
const LOG_EVERY_POLL = (process.env.LOG_EVERY_POLL ?? "1") !== "0";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase(); // debug|info|warn|error

// --- TELEGRAM ---
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- runtime state ---
let currentPort = DEFAULT_PORT;

// committed (stable) mode:
let mode = "unknown"; // charge | discharge | idle | unknown
let lastLevel = null; // 0..100

// debounce candidate state:
let candidateMode = "unknown";
let candidateCount = 0;

// boundaries notified within current charge/discharge session
let sessionNotified = new Set();

// failure streak
let consecutiveFailures = 0;
let firstFailureAt = null;
let downAlertSent = false;

function nowMs() {
    return Date.now();
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function buildUrl(port) {
    return `http://${HOST}:${port}${PATH}`;
}

function resetSession() {
    sessionNotified = new Set();
}

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
 * Hysteresis-based next mode proposal.
 * Uses the current committed mode to decide when to leave it.
 */
function proposeNextMode(currentMode, watt) {
    if (watt === null) return "unknown";

    if (currentMode === "charge") {
        // stay charging unless we fall below EXIT_WATT
        return watt < EXIT_WATT ? "idle" : "charge";
    }
    if (currentMode === "discharge") {
        // stay discharging unless we rise above -EXIT_WATT
        return watt > -EXIT_WATT ? "idle" : "discharge";
    }

    // if idle/unknown: decide whether to enter charge/discharge
    if (watt >= ENTER_WATT) return "charge";
    if (watt <= -ENTER_WATT) return "discharge";
    return "idle";
}

/**
 * Debounce mode switching: require STABLE_POLLS in a row.
 */
function debounceMode(nextMode) {
    if (nextMode === candidateMode) {
        candidateCount += 1;
    } else {
        candidateMode = nextMode;
        candidateCount = 1;
    }

    // only commit switch if stable enough AND different from current mode
    if (candidateCount >= STABLE_POLLS && candidateMode !== mode) {
        const prev = mode;
        mode = candidateMode;
        candidateCount = 0; // reset (optional)
        return { changed: true, prev, current: mode };
    }

    return { changed: false, prev: mode, current: mode };
}

// --- Telegram HTML formatting (quote block) ---
function esc(s) {
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function fmtSigned(n, digits) {
    if (!Number.isFinite(n)) return "?";
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n.toFixed(digits)}`;
}

function buildQuoteLines(stats) {
    const w = toNumber(stats.Bat_Watt);
    const a = toNumber(stats.Bat_CurD);
    const v = toNumber(stats.Bat_TVol);
    const dv = toNumber(stats.Cel_DifV);
    const minCell = getMinCellVoltage(stats);

    return [
        `${w !== null ? fmtSigned(w, 0) : "?"} W`,
        `${a !== null ? fmtSigned(a, 1) : "?"} A`,
        `${v !== null ? v.toFixed(2) : "?"} V`,
        `Δ${dv !== null ? dv.toFixed(3) : "?"} V`,
        `Min ${minCell !== null ? minCell.toFixed(3) : "?"} V`,
    ];
}

function msgModeStarted(currentMode, stats, level) {
    const isCharge = currentMode === "charge";
    const emoji = isCharge ? "⚡" : "🔋";
    const title = isCharge ? "CHARGING" : "DISCHARGING";

    const rcap = toNumber(stats.Bat_RCap);
    const cap = toNumber(stats.Batt_Cap);

    const line1 = `${emoji} <b>${title}</b>`;
    const line2 =
        level !== null && rcap !== null && cap !== null
            ? `<b>${esc(level)}%</b> (${esc(rcap.toFixed(1))} / ${esc(cap.toFixed(1))} Ah)`
            : `<b>Level</b>: ${esc(level ?? "?")}%`;

    const quote = buildQuoteLines(stats).map(esc).join("\n");
    return `${line1}\n${line2}\n\n<blockquote>${quote}</blockquote>`;
}

function msgLevelBoundary(dir, boundary, stats, level) {
    const emoji = dir === "down" ? "📉" : "📈";
    const arrow = dir === "down" ? "↓" : "↑";

    const rcap = toNumber(stats.Bat_RCap);
    const cap = toNumber(stats.Batt_Cap);

    const line1 = `${emoji} <b>LEVEL ${arrow} ${boundary}%</b>`;
    const line2 =
        level !== null && rcap !== null && cap !== null
            ? `<b>${esc(level)}%</b> (${esc(rcap.toFixed(1))} / ${esc(cap.toFixed(1))} Ah)`
            : `<b>Level</b>: ${esc(level ?? "?")}%`;

    const quote = buildQuoteLines(stats).map(esc).join("\n");
    return `${line1}\n${line2}\n\n<blockquote>${quote}</blockquote>`;
}

async function sendTelegram(htmlText) {
    if (!TG_TOKEN || !TG_CHAT_ID) {
        log("warn", "Telegram config missing. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
        return;
    }

    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const body = {
        chat_id: TG_CHAT_ID,
        text: htmlText,
        parse_mode: "HTML",
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

// --- HTTP multipart POST ---
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
    const authHeader =
        BMS_USER && BMS_PASS
            ? "Basic " + Buffer.from(`${BMS_USER}:${BMS_PASS}`).toString("base64")
            : null;

    const res = await fetchWithTimeout(
        url,
        {
            method: "POST",
            headers: {
                "Content-Type": mp.contentType,
                ...(authHeader ? { Authorization: authHeader } : {})
            },
            body: mp.body,
        },
        REQUEST_TIMEOUT_MS
    );

    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
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
                await sendTelegram(`✅ <b>BMS recovered.</b>\nSwitched port ${old} → ${p}`);
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

async function handleCycle(stats) {
    const level = computeLevel(stats);
    const watt = toNumber(stats.Bat_Watt);

    const proposed = proposeNextMode(mode, watt);
    const sw = debounceMode(proposed);

    // success poll logs
    if (LOG_EVERY_POLL) {
        const rcap = toNumber(stats.Bat_RCap);
        const cap = toNumber(stats.Batt_Cap);
        const dv = toNumber(stats.Cel_DifV);
        const minCell = getMinCellVoltage(stats);

        log(
            "info",
            `OK port=${currentPort} mode=${mode} proposed=${proposed} cand=${candidateMode}(${candidateCount}) ` +
            `level=${level ?? "?"}% watt=${watt ?? "?"}W rcap=${rcap ?? "?"}Ah cap=${cap ?? "?"}Ah ΔV=${dv ?? "?"} min=${minCell ?? "?"}`
        );
    }

    // If mode changed (committed), notify only when entering charge/discharge
    if (sw.changed) {
        log("warn", `Mode changed: ${sw.prev} -> ${sw.current} (ENTER=${ENTER_WATT}W EXIT=${EXIT_WATT}W stable=${STABLE_POLLS})`);

        if (sw.current === "charge" || sw.current === "discharge") {
            resetSession();
            await sendTelegram(msgModeStarted(sw.current, stats, level));
        }
    }

    // Boundaries: only while in committed charge/discharge
    if (level !== null && lastLevel !== null) {
        if (mode === "discharge") {
            for (let b = 90; b >= 0; b -= 10) {
                if (lastLevel > b && level <= b && !sessionNotified.has(`D${b}`)) {
                    sessionNotified.add(`D${b}`);
                    await sendTelegram(msgLevelBoundary("down", b, stats, level));
                }
            }
        } else if (mode === "charge") {
            for (let b = 10; b <= 100; b += 10) {
                if (lastLevel < b && level >= b && !sessionNotified.has(`C${b}`)) {
                    sessionNotified.add(`C${b}`);
                    await sendTelegram(msgLevelBoundary("up", b, stats, level));
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
        ENTER_WATT,
        EXIT_WATT,
        STABLE_POLLS,
        DOWN_ALERT_AFTER_MS,
        LOG_LEVEL,
        LOG_EVERY_POLL,
    });

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

            if (downAlertSent) {
                downAlertSent = false;
                await sendTelegram(`✅ <b>BMS endpoint</b> is reachable again on port <b>${currentPort}</b>.`);
            }

            await handleCycle(stats);
        } catch (err) {
            const t = nowMs();

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

            if (!downAlertSent && streakMs >= DOWN_ALERT_AFTER_MS) {
                downAlertSent = true;
                await sendTelegram(
                    `⚠️ <b>BMS endpoint unreachable</b> for <b>${fmtMs(streakMs)}</b> (consecutive).\n` +
                    `Tried ports: <code>${esc(portsTried)}</code>\n` +
                    `Retry: every <b>${Math.round(POLL_INTERVAL_MS / 1000)}s</b>.`
                );
                log("error", `Down alert sent after streak=${fmtMs(streakMs)}.`);
            }
        }

        await sleep(POLL_INTERVAL_MS);
    }
}

main();
