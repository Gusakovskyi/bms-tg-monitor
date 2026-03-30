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

function envNumber(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

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

// --- MODE DETECTION ---
const ENTER_WATT = envNumber("ENTER_WATT") ?? 50;
const EXIT_WATT = envNumber("EXIT_WATT") ?? 30;
const STABLE_POLLS = envNumber("STABLE_POLLS") ?? 3;

// Send "unreachable" alert only after N ms of consecutive failures
const DOWN_ALERT_AFTER_MS = Number(process.env.DOWN_ALERT_AFTER_MS || 30 * 60 * 1000);

// --- LOGGING ---
const LOG_EVERY_POLL = (process.env.LOG_EVERY_POLL ?? "1") !== "0";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase(); // debug|info|warn|error

// --- TELEGRAM ---
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_THREAD_ID = envNumber("TELEGRAM_THREAD_ID");
const TG_UPDATES_TIMEOUT_SEC = envNumber("TG_UPDATES_TIMEOUT_SEC") ?? 5;

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
let telegramUpdateOffset = null;
let activeStatsFetch = null;
let telegramBotUsername = null;
let telegramBotUserId = null;

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

function normalizeTelegramUsername(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim().replace(/^@+/, "").toLowerCase();
    return normalized || null;
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

function modeLabel(currentMode) {
    if (currentMode === "charge") return "CHARGING";
    if (currentMode === "discharge") return "DISCHARGING";
    if (currentMode === "idle") return "IDLE";
    return "UNKNOWN";
}

function statusEmoji(currentMode) {
    if (currentMode === "charge") return "⚡";
    if (currentMode === "discharge") return "🔋";
    return "ℹ️";
}

function resolveStatusMode(stats) {
    const watt = toNumber(stats.Bat_Watt);
    if (mode !== "unknown") return mode;
    return proposeNextMode("idle", watt);
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

function msgStatusSnapshot(stats) {
    const level = computeLevel(stats);
    const currentMode = resolveStatusMode(stats);
    const rcap = toNumber(stats.Bat_RCap);
    const cap = toNumber(stats.Batt_Cap);
    const quote = buildQuoteLines(stats).map(esc).join("\n");

    const line1 = `${statusEmoji(currentMode)} <b>BMS STATUS</b>`;
    const line2 = `<b>${modeLabel(currentMode)}</b> on port <b>${esc(currentPort)}</b>`;
    const line3 =
        level !== null && rcap !== null && cap !== null
            ? `<b>${esc(level)}%</b> (${esc(rcap.toFixed(1))} / ${esc(cap.toFixed(1))} Ah)`
            : `<b>Level</b>: ${esc(level ?? "?")}%`;

    return `${line1}\n${line2}\n${line3}\n\n<blockquote>${quote}</blockquote>`;
}

async function telegramApi(method, body, timeoutMs = 10_000) {
    if (!TG_TOKEN) throw new Error("Telegram bot token is not configured");

    const url = `https://api.telegram.org/bot${TG_TOKEN}/${method}`;
    const res = await fetchWithTimeout(
        url,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
        timeoutMs
    );

    if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${t}`.trim());
    }

    const payload = await res.json();
    if (!payload?.ok) {
        throw new Error(`Telegram ${method} returned ok=false`);
    }

    return payload.result;
}

async function sendTelegram(htmlText, opts = {}) {
    if (!TG_TOKEN || !TG_CHAT_ID) {
        log("warn", "Telegram config missing. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
        return;
    }

    const body = {
        chat_id: opts.chatId ?? TG_CHAT_ID,
        text: htmlText,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(opts.messageThreadId !== undefined
            ? { message_thread_id: opts.messageThreadId }
            : TG_THREAD_ID !== null
                ? { message_thread_id: TG_THREAD_ID }
                : {}),
        ...(opts.replyToMessageId !== undefined
            ? {
                reply_to_message_id: opts.replyToMessageId,
                allow_sending_without_reply: true,
            }
            : {}),
    };

    try {
        await telegramApi("sendMessage", body);
    } catch (err) {
        log("error", "Telegram send failed:", err?.message || err);
    }
}

function isStatusCommand(text) {
    if (typeof text !== "string") return false;
    const normalized = text.trim();
    return /^\/status(?:@\w+)?$/i.test(normalized);
}

function isAllowedTelegramMessage(message) {
    if (!message?.chat) return false;
    if (String(message.chat.id) !== String(TG_CHAT_ID)) return false;
    if (TG_THREAD_ID !== null && message.message_thread_id !== TG_THREAD_ID) return false;
    return true;
}

function messageMentionsBot(message) {
    if (!telegramBotUsername) return false;

    const text = typeof message?.text === "string" ? message.text : "";
    const entities = Array.isArray(message?.entities) ? message.entities : [];

    const byEntity = entities.some((entity) => {
        if (entity?.type === "mention") {
            const mention = text.slice(entity.offset, entity.offset + entity.length);
            return normalizeTelegramUsername(mention) === telegramBotUsername;
        }

        if (entity?.type === "text_mention") {
            return telegramBotUserId !== null && entity.user?.id === telegramBotUserId;
        }

        return false;
    });

    if (byEntity) return true;

    // Fallback for clients/updates where mention entities are missing.
    const escaped = telegramBotUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`@${escaped}(?!\\w)`, "i").test(text);
}

function stripOwnMentions(text) {
    if (typeof text !== "string" || !telegramBotUsername) return text?.trim?.() || "";
    const escaped = telegramBotUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`@${escaped}`, "ig"), " ").replace(/\s+/g, " ").trim();
}

function isMentionStatusRequest(message) {
    if (!messageMentionsBot(message)) return false;

    const cleaned = stripOwnMentions(message.text).replace(/^[,\s:;-]+|[,\s:;-]+$/g, "").trim();
    if (cleaned === "") return true;

    const normalized = cleaned.toLowerCase().trim();
    return normalized === "status" ||
        normalized === "/status" ||
        normalized === "статус";
}

function isReplyStatusRequest(message) {
    return telegramBotUserId !== null &&
        message?.reply_to_message?.from?.id === telegramBotUserId &&
        isStatusCommand(message.text);
}

function shouldHandleStatusRequest(message) {
    return isStatusCommand(message?.text) ||
        isMentionStatusRequest(message) ||
        isReplyStatusRequest(message);
}

function normalizeLogText(value, maxLen = 240) {
    if (typeof value !== "string") return null;
    const compact = value.replace(/\s+/g, " ").trim();
    if (compact === "") return null;
    return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

function detectTelegramMessageKind(message) {
    if (typeof message?.text === "string") return "text";
    if (typeof message?.caption === "string") return "caption";
    if (message?.photo) return "photo";
    if (message?.sticker) return "sticker";
    if (message?.document) return "document";
    if (message?.voice) return "voice";
    if (message?.video) return "video";
    return "other";
}

function logIncomingTelegramUpdate(update) {
    const message = update?.message;
    if (!message) {
        log("info", "Telegram incoming update without message:", {
            updateId: update?.update_id ?? null,
        });
        return;
    }

    const textPreview = normalizeLogText(message.text ?? message.caption);
    const fromDisplay = message.from?.username
        ? `@${message.from.username}`
        : message.from?.id ?? null;

    log("info", "Telegram incoming message:", {
        updateId: update?.update_id ?? null,
        messageId: message.message_id ?? null,
        chatId: message.chat?.id ?? null,
        chatType: message.chat?.type ?? null,
        threadId: message.message_thread_id ?? null,
        from: fromDisplay,
        messageKind: detectTelegramMessageKind(message),
        text: textPreview,
    });
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

async function fetchStatsShared() {
    if (!activeStatsFetch) {
        activeStatsFetch = (async () => {
            try {
                return await fetchStatsWithPortFailover();
            } finally {
                activeStatsFetch = null;
            }
        })();
    }

    return await activeStatsFetch;
}

function triedPortsList() {
    return [currentPort, ...FALLBACK_PORTS]
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(",");
}

async function respondWithStatus(message) {
    try {
        const stats = await fetchStatsShared();
        await sendTelegram(msgStatusSnapshot(stats), {
            chatId: message.chat.id,
            messageThreadId: message.message_thread_id,
            replyToMessageId: message.message_id,
        });
    } catch (err) {
        await sendTelegram(
            `⚠️ <b>Status check failed.</b>\n` +
            `Tried ports: <code>${esc(triedPortsList())}</code>\n` +
            `Error: <code>${esc(err?.message || err)}</code>`,
            {
                chatId: message.chat.id,
                messageThreadId: message.message_thread_id,
                replyToMessageId: message.message_id,
            }
        );
    }
}

async function bootstrapTelegramIdentity() {
    const me = await telegramApi("getMe", {}, 10_000);
    telegramBotUsername = normalizeTelegramUsername(me?.username);
    telegramBotUserId = Number.isFinite(me?.id) ? me.id : null;

    log(
        "info",
        `Telegram bot identity: username=@${telegramBotUsername || "unknown"} id=${telegramBotUserId ?? "unknown"}`
    );
}

async function bootstrapTelegramOffset() {
    const updates = await telegramApi(
        "getUpdates",
        { timeout: 0, allowed_updates: ["message"] },
        10_000
    );

    telegramUpdateOffset = updates.length > 0
        ? updates[updates.length - 1].update_id + 1
        : 0;

    if (updates.length > 0) {
        log("info", `Skipping ${updates.length} pending Telegram update(s) on startup.`);
    }
}

async function telegramLoop() {
    if (!TG_TOKEN || !TG_CHAT_ID) {
        log("warn", "Telegram command loop disabled: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
        return;
    }

    while (true) {
        try {
            if (telegramUpdateOffset === null) {
                await bootstrapTelegramIdentity();
                await bootstrapTelegramOffset();
                log("info", "Telegram command loop started. Use /status, mention the bot, or reply with /status.");
            }

            const updates = await telegramApi(
                "getUpdates",
                {
                    offset: telegramUpdateOffset ?? undefined,
                    timeout: TG_UPDATES_TIMEOUT_SEC,
                    allowed_updates: ["message"],
                },
                (TG_UPDATES_TIMEOUT_SEC + 5) * 1000
            );

            for (const update of updates) {
                telegramUpdateOffset = update.update_id + 1;
                logIncomingTelegramUpdate(update);

                const message = update?.message;
                if (!isAllowedTelegramMessage(message)) continue;
                if (!shouldHandleStatusRequest(message)) continue;

                log("info", `Telegram status request received from chat=${message.chat.id} message=${message.message_id}.`);
                await respondWithStatus(message);
            }
        } catch (err) {
            log("warn", "Telegram command loop error:", err?.message || err);
            await sleep(5_000);
        }
    }
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

async function monitorLoop() {
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
        TG_THREAD_ID,
        TG_UPDATES_TIMEOUT_SEC,
    });

    while (true) {
        try {
            const stats = await fetchStatsShared();

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
            const portsTried = triedPortsList();

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

async function main() {
    process.on("unhandledRejection", (err) => log("error", "unhandledRejection:", err));
    process.on("uncaughtException", (err) => log("error", "uncaughtException:", err));

    await Promise.all([
        monitorLoop(),
        telegramLoop(),
    ]);
}

main();
