// api/search.js
// Vercel serverless function — replaces the /api/search route in server.cjs
// Deployed automatically at /api/search?q=apple

import https from "https";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "No query provided" });

  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`;
  const options = { headers: { "User-Agent": "Mozilla/5.0" } };

  https.get(url, options, (response) => {
    let data = "";
    response.on("data", (c) => (data += c));
    response.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        const quotes = (parsed?.quotes || [])
          .filter((q) => q.quoteType !== "FUTURE")
          .slice(0, 6)
          .map((q) => ({
            ticker: q.symbol,
            name: q.longname || q.shortname || q.symbol,
            type: q.quoteType,
          }));
        res.status(200).json(quotes);
      } catch {
        res.status(200).json([]);
      }
    });
  }).on("error", () => res.status(200).json([]));
}