import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, ScatterChart, Scatter } from "recharts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SCENARIOS = [
  { id: "base",       label: "Base Case",            icon: "◆", muShock: 0,     sigmaShock: 1.0, color: "#f59e0b", desc: "Normal market conditions. No major shocks." },
  { id: "rate_hike",  label: "Fed Rate Hike +300bps", icon: "↑", muShock: -0.08, sigmaShock: 1.4, color: "#fb923c", desc: "Central banks raise rates sharply — bad for bonds, slows growth." },
  { id: "geo_crisis", label: "Geopolitical Crisis",   icon: "⚠", muShock: -0.15, sigmaShock: 2.0, color: "#f87171", desc: "War, sanctions, or major political instability rattles markets." },
  { id: "recession",  label: "Global Recession",      icon: "▼", muShock: -0.25, sigmaShock: 2.5, color: "#ef4444", desc: "Prolonged economic downturn. Growth falls, unemployment rises." },
  { id: "inflation",  label: "Inflation Surge",       icon: "🔥", muShock: -0.06, sigmaShock: 1.3, color: "#fbbf24", desc: "Prices rise faster than expected, eroding purchasing power." },
  { id: "crash",      label: "Market Crash −40%",     icon: "💥", muShock: -0.40, sigmaShock: 3.0, color: "#dc2626", desc: "A sudden severe collapse — think 2008 financial crisis." },
];

const ASSET_COLORS = ["#f59e0b","#34d399","#38bdf8","#a78bfa","#fb923c","#f87171","#fbbf24","#6ee7b7","#93c5fd","#c4b5fd"];
const RISK_FREE_RATE = 0.045;

// ─── Math helpers ─────────────────────────────────────────────────────────────

function gaussianRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Compute n×n correlation matrix from each asset's dailyReturns array
function computeCorrelationMatrix(assets) {
  const n = assets.length;
  if (n < 2) return null;
  const returns = assets.map(a => a.dailyReturns || []);
  if (returns.some(r => r.length < 20)) return null;

  const minLen = Math.min(...returns.map(r => r.length));
  const aligned = returns.map(r => r.slice(r.length - minLen));
  const means = aligned.map(r => r.reduce((s, v) => s + v, 0) / minLen);

  const cov = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < minLen; k++) {
        sum += (aligned[i][k] - means[i]) * (aligned[j][k] - means[j]);
      }
      cov[i][j] = cov[j][i] = sum / (minLen - 1);
    }
  }

  const stds = cov.map((row, i) => Math.sqrt(Math.max(row[i], 1e-12)));
  return cov.map((row, i) =>
    row.map((v, j) => Math.max(-1, Math.min(1, v / (stds[i] * stds[j]))))
  );
}

// Portfolio sigma using the full correlation matrix: σ_p = sqrt(w^T Σ w)
function portfolioSigmaMatrix(weights, sigmas, corrMatrix) {
  const n = weights.length;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      variance += weights[i] * weights[j] * sigmas[i] * sigmas[j] * corrMatrix[i][j];
    }
  }
  return Math.sqrt(Math.max(0, variance));
}

// Efficient frontier via random Dirichlet sampling over the weight simplex
function computeEfficientFrontier(assets, corrMatrix, nSims = 3000) {
  if (assets.length < 2 || !corrMatrix) return [];
  const n = assets.length;
  const mus = assets.map(a => a.mu);
  const sigmas = assets.map(a => a.sigma);

  const points = [];
  for (let s = 0; s < nSims; s++) {
    const raw = Array.from({ length: n }, () => -Math.log(Math.random() + 1e-10));
    const sum = raw.reduce((acc, v) => acc + v, 0);
    const w = raw.map(v => v / sum);
    const mu = w.reduce((acc, wi, i) => acc + wi * mus[i], 0);
    const sigma = portfolioSigmaMatrix(w, sigmas, corrMatrix);
    const sharpe = sigma > 0 ? (mu - RISK_FREE_RATE) / sigma : -Infinity;
    points.push({ mu, sigma, sharpe, weights: w });
  }
  return points;
}

// ─── Monte Carlo ─────────────────────────────────────────────────────────────

function runMonteCarlo(assets, scenario, corrMatrix, nSims = 10000, nDays = 252) {
  if (!assets.length) return null;
  const totalWeight = assets.reduce((s, a) => s + a.weight, 0);
  const norm = assets.map(a => ({ ...a, w: a.weight / totalWeight }));

  const portfolioMu = norm.reduce(
    (s, a) => s + a.w * (a.mu + scenario.muShock * Math.abs(a.mu / 0.1)), 0
  );

  const weights = norm.map(a => a.w);
  const sigmas  = norm.map(a => a.sigma * scenario.sigmaShock);

  const portfolioSigma = corrMatrix
    ? portfolioSigmaMatrix(weights, sigmas, corrMatrix)
    : Math.sqrt(
        0.3 * Math.pow(sigmas.reduce((s, sig, i) => s + weights[i] * sig, 0), 2) +
        0.7 * sigmas.reduce((s, sig, i) => s + weights[i] * weights[i] * sig * sig, 0)
      );

  const dMu    = portfolioMu    / 252;
  const dSigma = portfolioSigma / Math.sqrt(252);

  const finalValues  = [];
  const maxDrawdowns = [];
  const paths = [];

  for (let i = 0; i < nSims; i++) {
    let val = 1.0, peak = 1.0, maxDD = 0;
    const path = i < 14 ? [1.0] : null;
    for (let d = 0; d < nDays; d++) {
      val *= Math.exp((dMu - 0.5 * dSigma * dSigma) + dSigma * gaussianRandom());
      if (val > peak) peak = val;
      const dd = (peak - val) / peak;
      if (dd > maxDD) maxDD = dd;
      if (path) path.push(val);
    }
    finalValues.push(val);
    maxDrawdowns.push(maxDD);
    if (path) paths.push(path);
  }

  finalValues.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const pct = (p) => finalValues[Math.floor(nSims * p)] - 1;
  const var95  = pct(0.05);
  const var99  = pct(0.01);
  const cvar95 = finalValues.slice(0, Math.floor(nSims * 0.05)).reduce((s, v) => s + v - 1, 0) / Math.floor(nSims * 0.05);
  const median = pct(0.5);
  const mean   = finalValues.reduce((s, v) => s + v, 0) / nSims - 1;
  const p90    = pct(0.9);
  const medianMaxDrawdown = maxDrawdowns[Math.floor(nSims * 0.5)];
  const sharpe = portfolioSigma > 0 ? (portfolioMu - RISK_FREE_RATE) / portfolioSigma : 0;

  const bins = 40;
  const minV = finalValues[0] - 1, maxV = finalValues[finalValues.length - 1] - 1;
  const bSize = (maxV - minV) / bins;
  const hist = Array(bins).fill(0).map((_, i) => ({ x: minV + i * bSize + bSize / 2, count: 0 }));
  finalValues.forEach(v => { const idx = Math.min(Math.floor((v - 1 - minV) / bSize), bins - 1); hist[idx].count++; });
  const chartPaths = paths.map(p => { const s = []; for (let i = 0; i < p.length; i += 5) s.push(p[i]); return s; });

  return { var95, var99, cvar95, median, mean, p90, medianMaxDrawdown, sharpe, hist, chartPaths, portfolioMu, portfolioSigma };
}

const fmt = (n, d = 1) => ((n >= 0 ? "+" : "") + (n * 100).toFixed(d) + "%");

// ─── Components ───────────────────────────────────────────────────────────────

function Sparkline({ data }) {
  if (!data || data.length < 2) return null;
  const prices = data.map(d => d.p);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const W = 60, H = 24;
  const pts = prices.map((p, i) => `${(i / (prices.length - 1)) * W},${H - ((p - min) / range) * H}`).join(" ");
  const color = prices[prices.length - 1] >= prices[0] ? "#34d399" : "#f87171";
  return (
    <svg width={W} height={H} style={{ display: "block" }}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} />
    </svg>
  );
}

function CorrelationHeatmap({ assets, corrMatrix }) {
  if (!corrMatrix || assets.length < 2) {
    return (
      <div style={{ color: "#484f58", fontSize: 12, padding: "40px 0", textAlign: "center" }}>
        {assets.length < 2 ? "Add at least 2 assets to see correlations." : "Computing correlations…"}
      </div>
    );
  }
  const cellSize = Math.min(90, Math.floor(520 / assets.length));
  return (
    <div>
      <div style={{ fontSize: 10, color: "#484f58", marginBottom: 12, letterSpacing: "0.1em" }}>
        HOW YOUR ASSETS MOVE TOGETHER · BASED ON 1-YEAR DAILY RETURNS
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ width: cellSize }} />
              {assets.map(a => (
                <th key={a.id} style={{ width: cellSize, color: "#f59e0b", fontWeight: 600, fontSize: 10, padding: "4px 8px", textAlign: "center" }}>
                  {a.ticker}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assets.map((row, i) => (
              <tr key={row.id}>
                <td style={{ color: "#f59e0b", fontWeight: 600, fontSize: 10, padding: "4px 8px", whiteSpace: "nowrap" }}>{row.ticker}</td>
                {assets.map((col, j) => {
                  const r = corrMatrix[i][j];
                  const bg = i === j
                    ? "#21262d"
                    : r > 0
                      ? `rgba(245,158,11,${(r * 0.75).toFixed(2)})`
                      : `rgba(248,113,113,${(Math.abs(r) * 0.75).toFixed(2)})`;
                  const textColor = Math.abs(r) > 0.6 && i !== j ? "#000" : "#c9d1d9";
                  return (
                    <td key={col.id} style={{
                      background: bg, textAlign: "center",
                      padding: `${Math.round(cellSize * 0.3)}px ${Math.round(cellSize * 0.15)}px`,
                      color: textColor, fontSize: 11,
                      fontWeight: i === j ? 700 : 400,
                      border: "1px solid #161b22",
                    }}>
                      {r.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 10, color: "#30363d", marginTop: 10, lineHeight: 1.6 }}>
        Numbers range from −1 to +1. <span style={{ color: "#f59e0b" }}>+1 (amber)</span> means two assets always move in the same direction. <span style={{ color: "#f87171" }}>−1 (red)</span> means they move in opposite directions — great for reducing risk. <span style={{ color: "#484f58" }}>0</span> means they move independently.
      </div>
    </div>
  );
}

function FrontierTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const labelColor = d.label === "Current" ? "#38bdf8" : d.label === "Max Sharpe" ? "#34d399" : "#f59e0b";
  return (
    <div style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, padding: "10px 14px", fontSize: 11, fontFamily: "'IBM Plex Mono'", color: "#c9d1d9" }}>
      <div style={{ color: labelColor, fontWeight: 600, fontSize: 10, marginBottom: 6 }}>{d.label?.toUpperCase()}</div>
      <div>Vol: <span style={{ color: "#f59e0b" }}>{d.x?.toFixed(1)}%</span></div>
      <div>Return: <span style={{ color: d.y >= 0 ? "#34d399" : "#f87171" }}>{d.y >= 0 ? "+" : ""}{d.y?.toFixed(1)}%</span></div>
      <div>Sharpe: <span style={{ color: d.sharpe >= 1 ? "#34d399" : d.sharpe >= 0 ? "#f59e0b" : "#f87171" }}>{d.sharpe?.toFixed(2)}</span></div>
    </div>
  );
}

function EfficientFrontierChart({ frontier, currentSigma, currentMu, currentSharpe, assets }) {
  if (!frontier || frontier.length === 0) {
    return (
      <div style={{ color: "#484f58", fontSize: 12, padding: "40px 0", textAlign: "center" }}>
        Add at least 2 assets to compute the efficient frontier.
      </div>
    );
  }

  let maxSharpePoint = frontier[0];
  for (const p of frontier) if (p.sharpe > maxSharpePoint.sharpe) maxSharpePoint = p;

  const frontierData = frontier.map(p => ({ x: +(p.sigma * 100).toFixed(2), y: +(p.mu * 100).toFixed(2), sharpe: +p.sharpe.toFixed(2), label: "Portfolio" }));
  const currentPoint = [{ x: +(currentSigma * 100).toFixed(2), y: +(currentMu * 100).toFixed(2), sharpe: +currentSharpe.toFixed(2), label: "Current" }];
  const optimalPoint = [{ x: +(maxSharpePoint.sigma * 100).toFixed(2), y: +(maxSharpePoint.mu * 100).toFixed(2), sharpe: +maxSharpePoint.sharpe.toFixed(2), label: "Max Sharpe" }];

  return (
    <div>
      <div style={{ fontSize: 10, color: "#484f58", marginBottom: 12, letterSpacing: "0.1em" }}>
        FIND YOUR OPTIMAL PORTFOLIO · 3,000 WEIGHT COMBINATIONS TESTED
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ScatterChart margin={{ top: 10, right: 30, bottom: 40, left: 20 }}>
          <XAxis type="number" dataKey="x" name="Volatility" tick={{ fontSize: 10, fill: "#ffffff" }} axisLine={{ stroke: "#21262d" }} tickLine={false} tickFormatter={v => v + "%"} label={{ value: "ANNUAL VOLATILITY", position: "insideBottom", offset: -20, fontSize: 9, fill: "#484f58" }} />
          <YAxis type="number" dataKey="y" name="Return" tick={{ fontSize: 10, fill: "#ffffff" }} axisLine={{ stroke: "#21262d" }} tickLine={false} tickFormatter={v => v + "%"} label={{ value: "ANNUAL RETURN", angle: -90, position: "insideLeft", offset: 10, fontSize: 9, fill: "#484f58" }} />
          <Tooltip cursor={{ strokeDasharray: "3 3" }} content={FrontierTooltip} wrapperStyle={{ outline: "none" }} />
          <Scatter name="Portfolios" data={frontierData} shape={(p) => <circle cx={p.cx} cy={p.cy} r={2} fill="#f59e0b" opacity={0.25} />} />
          <Scatter name="Current" data={currentPoint} shape={(p) => <circle cx={p.cx} cy={p.cy} r={8} fill="#38bdf8" opacity={1} />} />
          <Scatter name="Max Sharpe" data={optimalPoint} shape={(p) => <circle cx={p.cx} cy={p.cy} r={8} fill="#34d399" opacity={1} />} />
        </ScatterChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 10, color: "#30363d", marginTop: 8, lineHeight: 1.6 }}>
        Each dot is a different way to split your money. Move right = more risk. Move up = more return. The <span style={{ color: "#34d399" }}>green dot</span> is the mathematically optimal split — the best return for the least risk. The <span style={{ color: "#38bdf8" }}>blue dot</span> is where you are now (Sharpe: {currentSharpe.toFixed(2)}).
      </div>
      <div style={{ marginTop: 14, background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: "12px 16px" }}>
        <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 8 }}>OPTIMAL WEIGHTS (MAX SHARPE RATIO)</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {assets.map((a, i) => (
            <div key={a.id} style={{ fontSize: 11 }}>
              <span style={{ color: "#f59e0b", fontWeight: 600 }}>{a.ticker}</span>
              <span style={{ color: "#c9d1d9", marginLeft: 6 }}>{(maxSharpePoint.weights[i] * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10, color: "#8b949e", marginTop: 6 }}>
          Return: <span style={{ color: "#34d399" }}>{fmt(maxSharpePoint.mu)}</span>
          {" · "}Vol: <span style={{ color: "#f59e0b" }}>{fmt(maxSharpePoint.sigma)}</span>
        </div>
      </div>
    </div>
  );
}

function TickerSearch({ onAdd, existingTickers }) {
  const [query, setQuery]             = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState("");
  const debounce = useRef(null);

  const search = (q) => {
    if (!q || q.length < 1) { setSuggestions([]); return; }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        setSuggestions(data);
      } catch { setSuggestions([]); }
    }, 300);
  };

  const fetchTicker = async (ticker) => {
    if (existingTickers.includes(ticker.toUpperCase())) { setError("Already in portfolio"); return; }
    setLoading(true); setError(""); setSuggestions([]);
    try {
      const r = await fetch(`/api/ticker/${encodeURIComponent(ticker)}`);
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      const data = await r.json();
      onAdd(data);
      setQuery("");
    } catch (e) { setError(e.message || "Not found"); }
    setLoading(false);
  };

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="inp"
          placeholder="Search ticker or name… (AAPL, BTC-USD)"
          value={query}
          onChange={e => { setQuery(e.target.value); search(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && query && fetchTicker(query.trim())}
          style={{ flex: 1 }}
        />
        <button className="run-btn" onClick={() => query && fetchTicker(query.trim())} disabled={loading} style={{ padding: "8px 14px", fontSize: 11 }}>
          {loading ? <span className="spinner">◌</span> : "FETCH"}
        </button>
      </div>
      {error && <div style={{ color: "#f87171", fontSize: 10, marginTop: 4 }}>{error}</div>}
      {suggestions.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, zIndex: 99, overflow: "hidden", marginTop: 2 }}>
          {suggestions.map(s => (
            <div key={s.ticker} onClick={() => { setQuery(s.ticker); setSuggestions([]); fetchTicker(s.ticker); }}
              style={{ padding: "8px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #21262d", transition: "background 0.1s" }}
              onMouseEnter={e => e.currentTarget.style.background = "#161b22"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <div>
                <span style={{ color: "#f59e0b", fontSize: 12, fontWeight: 600 }}>{s.ticker}</span>
                <span style={{ color: "#8b949e", fontSize: 11, marginLeft: 8 }}>{s.name}</span>
              </div>
              <span style={{ fontSize: 9, color: "#30363d" }}>{s.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [assets, setAssets]         = useState([]);
  const [scenario, setScenario]     = useState(SCENARIOS[0]);
  const [results, setResults]       = useState(null);
  const [corrMatrix, setCorrMatrix] = useState(null);
  const [frontier, setFrontier]     = useState(null);
  const [running, setRunning]       = useState(false);
  const [activeTab, setActiveTab]   = useState("paths");
  const [fetchingInit, setFetchingInit] = useState(true);
  const nextId    = useRef(1);
  const colorIdx  = useRef(0);

  useEffect(() => {
    const defaults = ["SPY", "AGG", "GLD"];
    const weights  = [60, 30, 10];
    Promise.all(
      defaults.map((t, i) =>
        fetch(`/api/ticker/${t}`)
          .then(r => r.json())
          .then(data => ({ ...data, weight: weights[i] }))
          .catch(() => null)
      )
    ).then(results => {
      const valid = results.filter(Boolean);
      if (valid.length) {
        setAssets(valid.map(d => ({
          id: nextId.current++,
          ticker: d.ticker,
          name: d.name,
          mu: d.annualizedReturn,
          sigma: d.annualizedVolatility,
          weight: d.weight,
          color: ASSET_COLORS[colorIdx.current++ % ASSET_COLORS.length],
          currentPrice: d.currentPrice,
          priceChange1Y: d.priceChange1Y,
          sparkline: d.sparkline,
          dailyReturns: d.dailyReturns || [],
          priceHistory: d.priceHistory || [],
          live: true,
        })));
      }
      setFetchingInit(false);
    });
  }, []);

  const addAsset = useCallback((data) => {
    setAssets(prev => [...prev, {
      id: nextId.current++,
      ticker: data.ticker,
      name: data.name,
      mu: data.annualizedReturn,
      sigma: data.annualizedVolatility,
      weight: 10,
      color: ASSET_COLORS[colorIdx.current++ % ASSET_COLORS.length],
      currentPrice: data.currentPrice,
      priceChange1Y: data.priceChange1Y,
      sparkline: data.sparkline,
      dailyReturns: data.dailyReturns || [],
      priceHistory: data.priceHistory || [],
      live: true,
    }]);
  }, []);

  const simulate = useCallback(() => {
    if (!assets.length) return;
    setRunning(true);
    setTimeout(() => {
      const corr  = computeCorrelationMatrix(assets);
      const front = computeEfficientFrontier(assets, corr);
      const mc    = runMonteCarlo(assets, scenario, corr);
      setCorrMatrix(corr);
      setFrontier(front);
      setResults(mc);
      setRunning(false);
    }, 50);
  }, [assets, scenario]);

  useEffect(() => { if (assets.length > 0) simulate(); }, [assets, scenario]);

  const totalWeight = assets.reduce((s, a) => s + a.weight, 0);
  const removeAsset = (id) => setAssets(prev => prev.filter(a => a.id !== id));
  const updateWeight = (id, w) => setAssets(prev => prev.map(a => a.id === id ? { ...a, weight: Math.max(1, Math.min(100, Number(w))) } : a));

  const pathData = results?.chartPaths?.[0]?.map((_, i) => {
    const obj = { day: i * 5 };
    results.chartPaths.forEach((p, pi) => { obj[`p${pi}`] = p[i] !== undefined ? +(p[i] * 100 - 100).toFixed(2) : null; });
    return obj;
  }) || [];

  const backtestData = (() => {
    if (assets.length === 0 || assets.some(a => !a.priceHistory || a.priceHistory.length < 5)) return [];
    const minLen = Math.min(...assets.map(a => a.priceHistory.length));
    return Array.from({ length: minLen }, (_, dayIdx) => {
      const obj = { day: dayIdx };
      assets.forEach((a, i) => { obj[`asset_${i}`] = +((a.priceHistory[dayIdx] - 1) * 100).toFixed(2); });
      obj.portfolio = +assets.reduce((s, a, _i) =>
        s + (a.weight / totalWeight) * (a.priceHistory[dayIdx] - 1) * 100, 0
      ).toFixed(2);
      return obj;
    });
  })();

  return (
    <div style={{ fontFamily: "'IBM Plex Mono','Courier New',monospace", background: "#080c10", minHeight: "100vh", color: "#c9d1d9" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=IBM+Plex+Sans:wght@300;400;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:6px;}::-webkit-scrollbar-track{background:#0d1117;}::-webkit-scrollbar-thumb{background:#21262d;border-radius:3px;}
        .metric-card{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:16px;transition:border-color 0.2s;}
        .metric-card:hover{border-color:#30363d;}
        .scenario-btn{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px 12px;cursor:pointer;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#8b949e;transition:all 0.2s;text-align:left;width:100%;}
        .scenario-btn:hover{border-color:#30363d;color:#c9d1d9;}
        .run-btn{background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;border:none;border-radius:6px;padding:10px 24px;font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:12px;cursor:pointer;letter-spacing:0.05em;transition:all 0.2s;}
        .run-btn:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(245,158,11,0.3);}
        .run-btn:disabled{opacity:0.5;cursor:not-allowed;transform:none;}
        .tab-btn{background:none;border:none;border-bottom:2px solid transparent;padding:8px 14px;font-family:'IBM Plex Mono',monospace;font-size:10px;color:#8b949e;cursor:pointer;transition:all 0.2s;white-space:nowrap;}
        .tab-btn.active{color:#f59e0b;border-bottom-color:#f59e0b;}
        .tab-btn:hover{color:#c9d1d9;}
        .asset-row{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px 12px;transition:border-color 0.2s;margin-bottom:6px;}
        .asset-row:hover{border-color:#30363d;}
        .w-input{background:#161b22;border:1px solid #30363d;border-radius:4px;color:#f59e0b;font-family:'IBM Plex Mono',monospace;font-size:12px;width:52px;padding:3px 6px;text-align:right;}
        .w-input:focus{outline:none;border-color:#f59e0b;}
        .del-btn{background:none;border:none;color:#30363d;cursor:pointer;font-size:14px;padding:2px 4px;transition:color 0.2s;}
        .del-btn:hover{color:#ef4444;}
        .inp{background:#161b22;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-family:'IBM Plex Mono',monospace;font-size:12px;padding:8px 10px;width:100%;}
        .inp:focus{outline:none;border-color:#f59e0b;}
        .scanline{position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.025) 2px,rgba(0,0,0,0.025) 4px);z-index:50;}
        @keyframes spin{to{transform:rotate(360deg);}}
        .spinner{animation:spin 1s linear infinite;display:inline-block;}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
        .fade-in{animation:fadeIn 0.3s ease;}
        .live-dot{width:6px;height:6px;background:#34d399;border-radius:50%;display:inline-block;animation:pulse 2s infinite;}
        @keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(52,211,153,0.4);}50%{opacity:0.8;box-shadow:0 0 0 4px rgba(52,211,153,0);}}
      `}</style>
      <div className="scanline" />

      {/* Header */}
      <div style={{ borderBottom: "1px solid #21262d", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#0d1117" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 34, height: 34, background: "linear-gradient(135deg,#f59e0b,#92400e)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'IBM Plex Mono'", fontWeight: 700, fontSize: 15, color: "#000" }}>A</div>
          <div>
            <div style={{ fontFamily: "'IBM Plex Sans'", fontWeight: 700, fontSize: 15, color: "#f0f6fc", letterSpacing: "-0.02em" }}>
              ALADDIN <span style={{ color: "#f59e0b", fontSize: 9, fontFamily: "'IBM Plex Mono'", fontWeight: 400, letterSpacing: "0.1em", verticalAlign: "middle" }}>RISK SIMULATOR</span>
            </div>
            <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.05em" }}>ASSET · LIABILITY · DEBT · DERIVATIVE INVESTMENT NETWORK</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 20, fontSize: 11, alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="live-dot" />
            <span style={{ color: "#34d399", fontSize: 10 }}>LIVE DATA</span>
          </div>
          {[["SIMULATIONS","10,000"],["HORIZON","252D"],["SOURCE","YAHOO FINANCE"]].map(([l,v]) => (
            <div key={l} style={{ textAlign: "right" }}>
              <div style={{ color: "#484f58", fontSize: 9 }}>{l}</div>
              <div style={{ color: "#f59e0b", fontWeight: 600, fontSize: 11 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "310px 1fr", minHeight: "calc(100vh - 65px)" }}>

        {/* Left Panel */}
        <div style={{ borderRight: "1px solid #21262d", padding: "16px", background: "#080c10", overflowY: "auto" }}>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.12em", marginBottom: 8 }}>ADD ASSET (LIVE DATA)</div>
            <TickerSearch onAdd={addAsset} existingTickers={assets.map(a => a.ticker)} />
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.12em", marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
              <span>PORTFOLIO</span>
              <span style={{ color: totalWeight === 100 ? "#34d399" : "#f59e0b" }}>{totalWeight}% TOTAL</span>
            </div>
            <div style={{ fontSize: 9, color: "#30363d", marginBottom: 8 }}>Weights don't need to add to 100 — they're automatically normalised.</div>

            {fetchingInit && assets.length === 0 && (
              <div style={{ color: "#484f58", fontSize: 11, padding: "12px 0", textAlign: "center" }}>
                <span className="spinner">◌</span> Loading live prices...
              </div>
            )}

            {assets.map((asset) => {
              const pct = totalWeight > 0 ? ((asset.weight / totalWeight) * 100).toFixed(1) : 0;
              const changeColor = asset.priceChange1Y >= 0 ? "#34d399" : "#f87171";
              return (
                <div key={asset.id} className="asset-row">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: asset.color, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600 }}>{asset.ticker}</span>
                        <span style={{ fontSize: 10, color: "#8b949e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{asset.name}</span>
                      </div>
                    </div>
                    <button className="del-btn" onClick={() => removeAsset(asset.id)}>×</button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontSize: 10 }}>
                      {asset.currentPrice && <span style={{ color: "#c9d1d9" }}>${asset.currentPrice} </span>}
                      {asset.priceChange1Y !== undefined && <span style={{ color: changeColor }}>{asset.priceChange1Y >= 0 ? "+" : ""}{asset.priceChange1Y.toFixed(1)}% 1Y</span>}
                    </div>
                    <Sparkline data={asset.sparkline} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <div style={{ flex: 1, fontSize: 10, color: "#484f58" }}>
                      ret: <span style={{ color: "#34d399" }}>{fmt(asset.mu)}</span> · vol: <span style={{ color: "#f59e0b" }}>{fmt(asset.sigma)}</span>
                    </div>
                    <span style={{ fontSize: 10, color: "#8b949e" }}>{pct}%</span>
                    <input className="w-input" type="number" value={asset.weight} onChange={e => updateWeight(asset.id, e.target.value)} />
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.12em", marginBottom: 8 }}>STRESS TEST SCENARIO</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {SCENARIOS.map(s => (
                <button key={s.id} className="scenario-btn"
                  onClick={() => setScenario(s)}
                  style={scenario.id === s.id ? { borderColor: s.color, color: s.color, background: `${s.color}11` } : {}}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span><span style={{ marginRight: 8 }}>{s.icon}</span>{s.label}</span>
                    {s.muShock !== 0 && <span style={{ opacity: 0.6, fontSize: 10 }}>{fmt(s.muShock)}</span>}
                  </div>
                  <div style={{ fontSize: 9, color: scenario.id === s.id ? s.color : "#484f58", marginTop: 2, fontWeight: 400 }}>{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <button className="run-btn" style={{ width: "100%" }} onClick={simulate} disabled={running || assets.length === 0}>
            {running ? <><span className="spinner">◌</span> SIMULATING...</> : "▶ RUN SIMULATION"}
          </button>
        </div>

        {/* Right Panel */}
        <div style={{ padding: "20px", overflowY: "auto" }}>
          {results ? (
            <div className="fade-in">
              {/* Metrics */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 10, marginBottom: 18 }}>
                {[
                  { label: "MEDIAN RETURN",    value: fmt(results.median),  color: results.median >= 0 ? "#34d399" : "#f87171", desc: "The middle outcome — half your simulations did better than this" },
                  { label: "MEAN RETURN",      value: fmt(results.mean),    color: results.mean   >= 0 ? "#34d399" : "#f87171", desc: "The average return across all 10,000 simulated years" },
                  { label: "VAR (95%)",        value: fmt(results.var95),   color: "#f87171",  desc: "Your 1-in-20 bad year — 5% chance of losing at least this much" },
                  { label: "VAR (99%)",        value: fmt(results.var99),   color: "#ef4444",  desc: "Your 1-in-100 bad year — a rare but severe loss scenario" },
                  { label: "CVAR (95%)",       value: fmt(results.cvar95),  color: "#dc2626",  desc: "When bad things happen, this is the average loss in the worst 5% of years" },
                  { label: "SHARPE RATIO",     value: results.sharpe.toFixed(2), color: results.sharpe >= 1 ? "#34d399" : results.sharpe >= 0 ? "#f59e0b" : "#f87171", desc: "Return per unit of risk. Above 1 is good. Negative means the risk isn't worth it" },
                  { label: "MAX DRAWDOWN",     value: fmt(-results.medianMaxDrawdown), color: "#f87171", desc: "The typical worst peak-to-trough dip during the year before recovering" },
                ].map(m => (
                  <div key={m.label} className="metric-card">
                    <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 6 }}>{m.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: m.color, fontFamily: "'IBM Plex Mono'", textShadow: `0 0 20px ${m.color}55` }}>{m.value}</div>
                    <div style={{ fontSize: 9, color: "#484f58", marginTop: 4, lineHeight: 1.4 }}>{m.desc}</div>
                  </div>
                ))}
              </div>

              {scenario.id !== "base" && (
                <div style={{ background: `${scenario.color}15`, border: `1px solid ${scenario.color}40`, borderRadius: 8, padding: "10px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 20 }}>{scenario.icon}</span>
                  <div>
                    <div style={{ color: scenario.color, fontSize: 11, fontWeight: 600 }}>{scenario.label}</div>
                    <div style={{ color: "#8b949e", fontSize: 10 }}>Return shock: {fmt(scenario.muShock)} · Vol multiplier: {scenario.sigmaShock}× · Effective annual vol: {fmt(results.portfolioSigma)}</div>
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div style={{ marginBottom: 16, borderBottom: "1px solid #21262d", display: "flex", overflowX: "auto" }}>
                {[
                  ["paths",        "SIMULATION PATHS"],
                  ["distribution", "DISTRIBUTION"],
                  ["backtest",     "HISTORICAL BACKTEST"],
                  ["breakdown",    "ASSET BREAKDOWN"],
                  ["correlation",  "CORRELATIONS"],
                  ["frontier",     "EFFICIENT FRONTIER"],
                ].map(([t, l]) => (
                  <button key={t} className={`tab-btn ${activeTab === t ? "active" : ""}`} onClick={() => setActiveTab(t)}>{l}</button>
                ))}
              </div>

              {activeTab === "paths" && (
                <div>
                  <div style={{ fontSize: 10, color: "#484f58", marginBottom: 2 }}>14 RANDOM SIMULATION PATHS · CUMULATIVE RETURN (%)</div>
                  <div style={{ fontSize: 10, color: "#30363d", marginBottom: 8 }}>Each line is one possible future for your portfolio. The spread shows how uncertain outcomes are — wide spread means higher risk.</div>
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={pathData}>
                      <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#484f58" }} axisLine={{ stroke: "#21262d" }} tickLine={false} label={{ value: "TRADING DAYS", position: "insideBottom", offset: -5, fontSize: 10, fill: "#484f58" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#484f58" }} axisLine={{ stroke: "#21262d" }} tickLine={false} tickFormatter={v => v + "%"} />
                      <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, fontSize: 11 }} formatter={v => [v.toFixed(1) + "%"]} labelFormatter={v => `Day ${v}`} />
                      <ReferenceLine y={0} stroke="#30363d" strokeDasharray="4 4" />
                      {Array(14).fill(0).map((_, i) => (
                        <Line key={i} type="monotone" dataKey={`p${i}`} dot={false} strokeWidth={1.2} stroke={`hsl(${i * 26}, 65%, 58%)`} opacity={0.6} connectNulls={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {activeTab === "distribution" && (
                <div>
                  <div style={{ fontSize: 10, color: "#484f58", marginBottom: 2 }}>DISTRIBUTION OF 1-YEAR RETURNS · 10,000 SIMULATIONS</div>
                  <div style={{ fontSize: 10, color: "#30363d", marginBottom: 8 }}>The taller the bar, the more likely that return. The red line marks your VaR — losses to the left of it happen only 5% of the time.</div>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={results.hist} barCategoryGap="0%">
                      <XAxis dataKey="x" tick={{ fontSize: 9, fill: "#484f58" }} axisLine={{ stroke: "#21262d" }} tickLine={false} tickFormatter={v => (v * 100).toFixed(0) + "%"} interval={4} />
                      <YAxis tick={{ fontSize: 9, fill: "#484f58" }} axisLine={{ stroke: "#21262d" }} tickLine={false} />
                      <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, fontSize: 11 }} formatter={(v, n, p) => [`${v} simulations`, `${(p.payload.x * 100).toFixed(1)}%`]} labelFormatter={() => ""} />
                      <ReferenceLine x={results.var95} stroke="#f87171" strokeDasharray="4 4" label={{ value: "VaR 95%", fill: "#f87171", fontSize: 9 }} />
                      <Bar dataKey="count" fill="#f59e0b" opacity={0.7} radius={[1, 1, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {activeTab === "backtest" && (
                <div>
                  <div style={{ fontSize: 10, color: "#484f58", marginBottom: 2 }}>HISTORICAL PERFORMANCE · PAST 12 MONTHS · CUMULATIVE RETURN (%)</div>
                  <div style={{ fontSize: 10, color: "#30363d", marginBottom: 8 }}>How your portfolio actually performed over the last year. The gold line is the blended portfolio — coloured lines show each individual asset.</div>
                  {backtestData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={backtestData}>
                        <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#484f58" }} axisLine={{ stroke: "#21262d" }} tickLine={false} label={{ value: "TRADING DAYS", position: "insideBottom", offset: -5, fontSize: 10, fill: "#484f58" }} />
                        <YAxis tick={{ fontSize: 10, fill: "#484f58" }} axisLine={{ stroke: "#21262d" }} tickLine={false} tickFormatter={v => v + "%"} />
                        <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, fontSize: 11 }} formatter={v => [v.toFixed(1) + "%"]} labelFormatter={v => `Day ${v}`} />
                        <ReferenceLine y={0} stroke="#30363d" strokeDasharray="4 4" />
                        {assets.map((a, i) => (
                          <Line key={a.id} type="monotone" dataKey={`asset_${i}`} dot={false} strokeWidth={1} stroke={a.color} opacity={0.5} name={a.ticker} />
                        ))}
                        <Line type="monotone" dataKey="portfolio" dot={false} strokeWidth={2.5} stroke="#f59e0b" name="Portfolio" />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div style={{ color: "#484f58", fontSize: 12, padding: "40px 0", textAlign: "center" }}>Historical price data not available.</div>
                  )}
                  {backtestData.length > 0 && (
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10, fontSize: 10 }}>
                      {assets.map((a, i) => (
                        <span key={a.id} style={{ color: a.color }}>● {a.ticker}: {backtestData[backtestData.length - 1][`asset_${i}`] >= 0 ? "+" : ""}{backtestData[backtestData.length - 1][`asset_${i}`].toFixed(1)}%</span>
                      ))}
                      <span style={{ color: "#f59e0b", fontWeight: 600 }}>● Portfolio: {backtestData[backtestData.length - 1].portfolio >= 0 ? "+" : ""}{backtestData[backtestData.length - 1].portfolio.toFixed(1)}%</span>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "breakdown" && (
                <div style={{ display: "grid", gap: 10 }}>
                  {assets.map(asset => {
                    const w = asset.weight / totalWeight;
                    const adjMu    = asset.mu    + scenario.muShock    * Math.abs(asset.mu / 0.1);
                    const adjSigma = asset.sigma * scenario.sigmaShock;
                    const riskContrib = w * adjSigma;
                    const maxRisk = Math.max(...assets.map(a => (a.weight / totalWeight) * a.sigma * scenario.sigmaShock));
                    return (
                      <div key={asset.id} style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: "12px 16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ width: 10, height: 10, borderRadius: "50%", background: asset.color }} />
                            <span style={{ color: "#f59e0b", fontWeight: 600, fontSize: 12 }}>{asset.ticker}</span>
                            <span style={{ color: "#8b949e", fontSize: 11 }}>{asset.name}</span>
                            {asset.live && <span style={{ fontSize: 9, color: "#34d399", background: "#34d39915", border: "1px solid #34d39940", borderRadius: 3, padding: "1px 5px" }}>LIVE</span>}
                          </div>
                          <span style={{ fontSize: 12, color: "#f59e0b" }}>{(w * 100).toFixed(1)}%</span>
                        </div>
                        <div style={{ display: "flex", gap: 20, fontSize: 10, marginBottom: 8 }}>
                          {asset.currentPrice && <span style={{ color: "#484f58" }}>PRICE: <span style={{ color: "#c9d1d9" }}>${asset.currentPrice}</span></span>}
                          <span style={{ color: "#484f58" }}>ADJ RETURN: <span style={{ color: adjMu >= 0 ? "#34d399" : "#f87171" }}>{fmt(adjMu)}</span></span>
                          <span style={{ color: "#484f58" }}>ADJ VOL: <span style={{ color: "#f59e0b" }}>{fmt(adjSigma)}</span></span>
                        </div>
                        <div style={{ height: 4, background: "#21262d", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${(riskContrib / maxRisk) * 100}%`, background: `linear-gradient(90deg,${asset.color}77,${asset.color})`, borderRadius: 2, transition: "width 0.5s" }} />
                        </div>
                        <div style={{ fontSize: 9, color: "#30363d", marginTop: 3 }}>RISK CONTRIBUTION (WEIGHTED VOL)</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {activeTab === "correlation" && (
                <CorrelationHeatmap assets={assets} corrMatrix={corrMatrix} />
              )}

              {activeTab === "frontier" && (
                <EfficientFrontierChart
                  frontier={frontier}
                  currentSigma={results.portfolioSigma}
                  currentMu={results.portfolioMu}
                  currentSharpe={results.sharpe}
                  assets={assets}
                />
              )}

              {/* Insight strip */}
              <div style={{ marginTop: 18, background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: "14px 18px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 4 }}>WHAT COULD GO WRONG?</div>
                  <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
                    {results.var95 >= 0
                      ? <>In a <span style={{ color: scenario.color }}>{scenario.label}</span> scenario, you're likely to make money — even the worst 1-in-20 outcomes show a gain of <span style={{ color: "#34d399", fontWeight: 600 }}>+{(results.var95 * 100).toFixed(1)}%</span>.</>
                      : <>In a <span style={{ color: scenario.color }}>{scenario.label}</span> scenario, there's a 1-in-20 chance of losing more than <span style={{ color: "#f87171", fontWeight: 600 }}>{(-results.var95 * 100).toFixed(1)}%</span> of your portfolio in a year.</>
                    }
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 4 }}>IF THINGS GET REALLY BAD</div>
                  <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
                    In the worst 5% of years, you'd lose an average of <span style={{ color: "#ef4444", fontWeight: 600 }}>{(-results.cvar95 * 100).toFixed(1)}%</span>. This is your tail risk — the damage when markets truly break down.
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 4 }}>BEST CASE UPSIDE</div>
                  <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
                    In the best 1-in-10 years, you'd gain <span style={{ color: "#34d399", fontWeight: 600 }}>+{(results.p90 * 100).toFixed(1)}%</span> or more. The most likely outcome (median) is <span style={{ color: "#34d399", fontWeight: 600 }}>{fmt(results.median)}</span>.
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 4 }}>STOMACH THE DIP</div>
                  <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
                    In a typical year, your portfolio could temporarily drop <span style={{ color: "#f87171", fontWeight: 600 }}>{(results.medianMaxDrawdown * 100).toFixed(1)}%</span> from its peak before recovering. Can you hold through that?
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 400, color: "#30363d", fontSize: 13 }}>
              {fetchingInit || running ? <><span className="spinner" style={{ marginRight: 8 }}>◌</span> LOADING LIVE DATA...</> : "ADD ASSETS TO BEGIN"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
