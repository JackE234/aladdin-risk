import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── Monte Carlo ─────────────────────────────────────────────────────────────

const SCENARIOS = [
  { id: "base",       label: "Base Case",            icon: "◆", muShock: 0,     sigmaShock: 1.0, color: "#f59e0b" },
  { id: "rate_hike",  label: "Fed Rate Hike +300bps", icon: "↑", muShock: -0.08, sigmaShock: 1.4, color: "#fb923c" },
  { id: "geo_crisis", label: "Geopolitical Crisis",   icon: "⚠", muShock: -0.15, sigmaShock: 2.0, color: "#f87171" },
  { id: "recession",  label: "Global Recession",      icon: "▼", muShock: -0.25, sigmaShock: 2.5, color: "#ef4444" },
  { id: "inflation",  label: "Inflation Surge",       icon: "🔥", muShock: -0.06, sigmaShock: 1.3, color: "#fbbf24" },
  { id: "crash",      label: "Market Crash −40%",     icon: "💥", muShock: -0.40, sigmaShock: 3.0, color: "#dc2626" },
];

const ASSET_COLORS = ["#f59e0b","#34d399","#38bdf8","#a78bfa","#fb923c","#f87171","#fbbf24","#6ee7b7","#93c5fd","#c4b5fd"];

function gaussianRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

const RISK_FREE_RATE = 0.045; // approximate 1Y US treasury yield
// Assumed constant pairwise correlation for diversification benefit.
// ρ=1 (old behaviour) overstates portfolio vol; 0.3 is a reasonable
// conservative estimate for a mixed stock/bond/commodity portfolio.
const ASSUMED_CORRELATION = 0.3;

function runMonteCarlo(assets, scenario, nSims = 10000, nDays = 252) {
  if (!assets.length) return null;
  const totalWeight = assets.reduce((s, a) => s + a.weight, 0);
  const norm = assets.map(a => ({ ...a, w: a.weight / totalWeight }));
  const portfolioMu = norm.reduce((s, a) => s + a.w * (a.mu + scenario.muShock * Math.abs(a.mu / 0.1)), 0);

  // Portfolio volatility using constant pairwise correlation assumption:
  // σ_p² = ρ·(Σ wᵢσᵢ)² + (1−ρ)·Σ wᵢ²σᵢ²
  const scaledSigmas = norm.map(a => a.w * a.sigma * scenario.sigmaShock);
  const wSigmaSum  = scaledSigmas.reduce((s, v) => s + v, 0);
  const wSigmaSumSq = scaledSigmas.reduce((s, v) => s + v * v, 0);
  const portfolioSigma = Math.sqrt(
    ASSUMED_CORRELATION * wSigmaSum * wSigmaSum +
    (1 - ASSUMED_CORRELATION) * wSigmaSumSq
  );

  // Daily drift and vol for GBM
  const dMu    = portfolioMu    / 252;
  const dSigma = portfolioSigma / Math.sqrt(252);

  const finalValues  = [];
  const maxDrawdowns = [];
  const paths = [];

  for (let i = 0; i < nSims; i++) {
    let val  = 1.0;
    let peak = 1.0;
    let maxDD = 0;
    const path = i < 14 ? [1.0] : null;
    for (let d = 0; d < nDays; d++) {
      // Correct GBM (log-normal): includes Itô correction −½σ²dt
      // Prevents negative prices and removes upward bias of arithmetic form
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

  // histogram
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

function TickerSearch({ onAdd, existingTickers }) {
  const [query, setQuery]       = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
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
  const [assets, setAssets]     = useState([]);
  const [scenario, setScenario] = useState(SCENARIOS[0]);
  const [results, setResults]   = useState(null);
  const [running, setRunning]   = useState(false);
  const [activeTab, setActiveTab] = useState("paths");
  const [fetchingInit, setFetchingInit] = useState(true);
  const nextId = useRef(1);
  const colorIdx = useRef(0);

  // Load default portfolio on mount
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
      live: true,
    }]);
  }, []);

  const simulate = useCallback(() => {
    if (!assets.length) return;
    setRunning(true);
    setTimeout(() => {
      setResults(runMonteCarlo(assets, scenario));
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
        .tab-btn{background:none;border:none;border-bottom:2px solid transparent;padding:8px 16px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#8b949e;cursor:pointer;transition:all 0.2s;}
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

          {/* Add asset */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.12em", marginBottom: 8 }}>ADD ASSET (LIVE DATA)</div>
            <TickerSearch onAdd={addAsset} existingTickers={assets.map(a => a.ticker)} />
          </div>

          {/* Portfolio */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.12em", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
              <span>PORTFOLIO</span>
              <span style={{ color: totalWeight === 100 ? "#34d399" : "#f59e0b" }}>{totalWeight}% TOTAL</span>
            </div>

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

          {/* Scenarios */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.12em", marginBottom: 8 }}>STRESS TEST SCENARIO</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {SCENARIOS.map(s => (
                <button key={s.id} className="scenario-btn"
                  onClick={() => setScenario(s)}
                  style={scenario.id === s.id ? { borderColor: s.color, color: s.color, background: `${s.color}11` } : {}}
                >
                  <span style={{ marginRight: 8 }}>{s.icon}</span>{s.label}
                  {s.muShock !== 0 && <span style={{ float: "right", opacity: 0.6, fontSize: 10 }}>{fmt(s.muShock)}</span>}
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
                  { label: "MEDIAN RETURN",   value: fmt(results.median),  color: results.median >= 0 ? "#34d399" : "#f87171", sub: "1-YEAR HORIZON" },
                  { label: "MEAN RETURN",     value: fmt(results.mean),    color: results.mean   >= 0 ? "#34d399" : "#f87171", sub: "1-YEAR HORIZON" },
                  { label: "VAR (95%)",       value: fmt(results.var95),   color: "#f87171",  sub: "1-YEAR HORIZON" },
                  { label: "VAR (99%)",       value: fmt(results.var99),   color: "#ef4444",  sub: "1-YEAR HORIZON" },
                  { label: "CVAR (95%)",      value: fmt(results.cvar95),  color: "#dc2626",  sub: "EXPECTED SHORTFALL" },
                  { label: "SHARPE RATIO",    value: results.sharpe.toFixed(2), color: results.sharpe >= 1 ? "#34d399" : results.sharpe >= 0 ? "#f59e0b" : "#f87171", sub: "RF=4.5%" },
                  { label: "MED MAX DRAWDOWN",value: fmt(-results.medianMaxDrawdown), color: "#f87171", sub: "MEDIAN SIMULATION" },
                ].map(m => (
                  <div key={m.label} className="metric-card">
                    <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 6 }}>{m.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: m.color, fontFamily: "'IBM Plex Mono'", textShadow: `0 0 20px ${m.color}55` }}>{m.value}</div>
                    <div style={{ fontSize: 9, color: "#30363d", marginTop: 2 }}>{m.sub}</div>
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
              <div style={{ marginBottom: 16, borderBottom: "1px solid #21262d", display: "flex" }}>
                {[["paths","SIMULATION PATHS"],["distribution","RETURN DISTRIBUTION"],["breakdown","ASSET BREAKDOWN"]].map(([t,l]) => (
                  <button key={t} className={`tab-btn ${activeTab === t ? "active" : ""}`} onClick={() => setActiveTab(t)}>{l}</button>
                ))}
              </div>

              {activeTab === "paths" && (
                <div style={{ height: 300 }}>
                  <div style={{ fontSize: 10, color: "#484f58", marginBottom: 8 }}>14 RANDOM SIMULATION PATHS · CUMULATIVE RETURN (%)</div>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={pathData}>
                      <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#484f58" }} axisLine={{ stroke: "#21262d" }} tickLine={false} label={{ value: "TRADING DAYS", position: "insideBottom", offset: -5, fontSize: 10, fill: "#484f58" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#484f58" }} axisLine={{ stroke: "#21262d" }} tickLine={false} tickFormatter={v => v + "%"} />
                      <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, fontSize: 11 }} formatter={v => [v.toFixed(1) + "%"]} labelFormatter={v => `Day ${v}`} />
                      <ReferenceLine y={0} stroke="#30363d" strokeDasharray="4 4" />
                      {Array(14).fill(0).map((_, i) => (
                        <Line key={i} type="monotone" dataKey={`p${i}`} dot={false} strokeWidth={1.2} stroke={`hsl(${i * 26}, 65%, 58%)`} opacity={0.6} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {activeTab === "distribution" && (
                <div style={{ height: 300 }}>
                  <div style={{ fontSize: 10, color: "#484f58", marginBottom: 8 }}>DISTRIBUTION OF 1-YEAR RETURNS · 10,000 SIMULATIONS</div>
                  <ResponsiveContainer width="100%" height="100%">
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

              {/* Insight strip */}
              <div style={{ marginTop: 18, background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: "14px 18px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 4 }}>INTERPRETATION</div>
                  <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
                    {results.var95 >= 0
                      ? <>In a <span style={{ color: scenario.color }}>{scenario.label}</span> scenario, even the worst 5% of outcomes show a gain of at least <span style={{ color: "#34d399", fontWeight: 600 }}>+{(results.var95 * 100).toFixed(1)}%</span> within 1 year.</>
                      : <>In a <span style={{ color: scenario.color }}>{scenario.label}</span> scenario, there is a 5% chance of losing more than <span style={{ color: "#f87171", fontWeight: 600 }}>{(-results.var95 * 100).toFixed(1)}%</span> within 1 year.</>
                    }
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 4 }}>EXPECTED SHORTFALL</div>
                  <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
                    In the worst 5% of outcomes, the average loss is <span style={{ color: "#ef4444", fontWeight: 600 }}>{(-results.cvar95 * 100).toFixed(1)}%</span>. This is the CVaR (tail risk) measure.
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 4 }}>UPSIDE (90TH PCT)</div>
                  <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
                    Top 10% of outcomes yield <span style={{ color: "#34d399", fontWeight: 600 }}>+{(results.p90 * 100).toFixed(1)}%</span> or better. Median: <span style={{ color: "#34d399", fontWeight: 600 }}>{fmt(results.median)}</span>.
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#484f58", letterSpacing: "0.1em", marginBottom: 4 }}>MAX DRAWDOWN</div>
                  <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
                    The median simulation experiences a peak-to-trough drawdown of <span style={{ color: "#f87171", fontWeight: 600 }}>{(results.medianMaxDrawdown * 100).toFixed(1)}%</span> over the year.
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