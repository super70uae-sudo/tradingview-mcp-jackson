import "dotenv/config";
import http from "node:http";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const port = Number(process.env.PORT || process.env.TELEGRAM_WEBHOOK_PORT || 8787);
const slPips = Number(process.env.TELEGRAM_SL_PIPS || 40);
const tp1Pips = Number(process.env.TELEGRAM_TP1_PIPS || 60);
const tp2Pips = Number(process.env.TELEGRAM_TP2_PIPS || 100);
const entryRangePips = Number(process.env.TELEGRAM_ENTRY_RANGE_PIPS || 5);
const roundPrices = String(process.env.TELEGRAM_ROUND_PRICES || "false").toLowerCase() === "true";
const symbolAlias = process.env.TELEGRAM_SYMBOL_ALIAS || "";
const allowedSymbols = (process.env.TELEGRAM_ALLOWED_SYMBOLS || "")
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);

if (!token || !chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseSignal(raw) {
  try {
    const data = JSON.parse(raw);
    return {
      signal: data.signal || "SIGNAL",
      symbol: data.symbol || "unknown",
      displaySymbol: data.display_symbol || data.displaySymbol,
      price: data.price,
      stop: data.stop,
      target: data.target,
      reason: data.reason || "TradingView alert",
    };
  } catch {
    return {
      signal: "SIGNAL",
      symbol: "TradingView",
      reason: raw || "TradingView alert",
    };
  }
}

function formatSignal(signal) {
  const side = String(signal.signal || "SIGNAL").toUpperCase();
  const symbol = signal.displaySymbol || symbolAlias || signal.symbol || "unknown";
  const entry = Number(signal.price);

  if (!Number.isFinite(entry) || !["BUY", "SELL"].includes(side)) {
    return `${side} NOW\n${symbol}\n${signal.reason || "TradingView alert"}`;
  }

  const direction = side === "BUY" ? 1 : -1;
  const entryEnd = entry + direction * entryRangePips;
  const sl = entry - direction * slPips;
  const tp1 = entry + direction * tp1Pips;
  const tp2 = entry + direction * tp2Pips;

  const lines = [
    `${side} NOW ${symbol}`,
    `${formatPrice(entry)} - ${formatPrice(entryEnd)}`,
    "",
    `TP1: ${formatPrice(tp1)}`,
    `TP2: ${formatPrice(tp2)}`,
    "",
    `STOP: ${formatPrice(sl)}`,
  ];
  return lines.join("\n");
}

function formatPrice(value) {
  if (roundPrices) return String(Math.round(value));
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function isAllowedSymbol(signal) {
  if (allowedSymbols.length === 0) return true;
  const candidates = [
    signal.symbol,
    signal.displaySymbol,
  ].filter(Boolean).map((symbol) => String(symbol).toUpperCase());
  return candidates.some((symbol) => allowedSymbols.includes(symbol));
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Telegram send failed: ${response.status} ${detail}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/tradingview") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Not found" }));
      return;
    }

    if (secret && url.searchParams.get("secret") !== secret) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Bad secret" }));
      return;
    }

    const raw = await readBody(req);
    const signal = parseSignal(raw);

    if (!isAllowedSymbol(signal)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, ignored: true, reason: "symbol_not_allowed" }));
      return;
    }

    await sendTelegram(formatSignal(signal));

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
});

server.on("error", (error) => {
  console.error(`Webhook server failed to listen on port ${port}: ${error.message}`);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`Telegram webhook listening on http://localhost:${port}`);
  console.log(`TradingView path: /tradingview?secret=${secret || "no-secret-set"}`);
});
