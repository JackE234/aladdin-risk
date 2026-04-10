// api/ticker/[symbol].js
import https from "https";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let _crumb = null;
let _cookie = null;
let _crumbExpiry = 0;

function httpsGet(url, options) {
  return new Promise((resolve, reject) => {
    https.get(url, options, resolve).on("error", reject);
  });
}

function readBody(res) {
  return new Promise((resolve) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => resolve(data));
  });
}

async function getCrumb() {
  if (_crumb && Date.now() < _crumbExpiry) return { crumb: _crumb, cookie: _cookie };

  const homeRes = await httpsGet("https://finance.yahoo.com/", {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  homeRes.resume();

  const rawCookies = homeRes.headers["set-cookie"] || [];
  const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");

  const crumbRes = await httpsGet("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, "Cookie": cookie },
  });
  const crumb = (await readBody(crumbRes)).trim();

  if (crumb && crumb.length < 50) {
    _crumb = crumb;
    _cookie = cookie;
    _crumbExpiry = Date.now() + 3_600_000;
  }

  return { crumb: _crumb || "", cookie: _cookie || "" };
}

async function fetchYahooData(ticker) {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - 365 * 24 * 60 * 60;

  const { crumb, cookie } = await getCrumb();
  const crumbParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : "";

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=1d&period1=${startTime}&period2=${endTime}&includePrePost=false${crumbParam}`;

  const res = await httpsGet(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "application/json",
      ...(cookie ? { "Cookie": cookie } : {}),
    },
  });
  const raw = await readBody(res);

  const parsed = JSON.parse(raw);
  const result = parsed?.chart?.result?.[0];
  if (!result) throw new Error("Ticker not found");

  const closes =
    result.indicators?.adjclose?.[0]?.adjclose ||
    result.indicators?.quote?.[0]?.close;
  const meta = result.meta;

  if (!closes || closes.length < 20) throw new Error("Not enough data");

  const prices = closes.filter((p) => p !== null && p !== undefined);

  const logReturns = [];
  for (let i = 1; i < prices.length; i++) {
    logReturns.push(Math.log(prices[i] / prices[i - 1]));
  }

  const meanDailyReturn = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const annualizedReturn = meanDailyReturn * 252;

  const variance =
    logReturns.reduce((s, r) => s + Math.pow(r - meanDailyReturn, 2), 0) /
    (logReturns.length - 1);
  const annualizedVolatility = Math.sqrt(variance * 252);

  const high52 = Math.max(...prices);
  const low52 = Math.min(...prices);
  const currentPrice = prices[prices.length - 1];
  const priceChange1Y = (currentPrice / prices[0] - 1) * 100;
  const sparkline = prices.slice(-30).map((p, i) => ({ i, p: +p.toFixed(2) }));

  // Historical price series normalised to 1.0 at start (for backtest)
  const histPrices = prices.slice(-252);
  const priceHistory = histPrices.map(p => +(p / histPrices[0]).toFixed(6));

  // Daily log returns for correlation matrix computation
  const dailyReturns = logReturns.slice(-251);

  return {
    ticker: ticker.toUpperCase(),
    name: meta?.longName || meta?.shortName || ticker.toUpperCase(),
    currency: meta?.currency || "USD",
    currentPrice: +currentPrice.toFixed(2),
    annualizedReturn: +annualizedReturn.toFixed(4),
    annualizedVolatility: +annualizedVolatility.toFixed(4),
    high52: +high52.toFixed(2),
    low52: +low52.toFixed(2),
    priceChange1Y: +priceChange1Y.toFixed(2),
    dataPoints: prices.length,
    sparkline,
    priceHistory,
    dailyReturns,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol || symbol.length > 20) {
    return res.status(400).json({ error: "Invalid ticker" });
  }

  try {
    const data = await fetchYahooData(symbol);
    res.status(200).json(data);
  } catch (err) {
    res.status(404).json({ error: err.message || "Ticker not found" });
  }
}
