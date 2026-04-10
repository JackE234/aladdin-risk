# ALADDIN — Risk Simulator

A portfolio risk simulator inspired by BlackRock's Aladdin platform. Built with React and deployed on Vercel with serverless API routes.

## Features

### Simulation
- **Monte Carlo simulation** — 10,000 paths using correct log-normal GBM with Itô correction
- **Stress testing** — 6 scenarios: Base Case, Fed Rate Hike (+300bps), Geopolitical Crisis, Global Recession, Inflation Surge, Market Crash (−40%)
- **Risk metrics** — VaR (95%/99%), CVaR (Expected Shortfall), Sharpe Ratio (RF=4.5%), Median Max Drawdown, Mean/Median 1-year return

### Portfolio Analysis
- **Correlation matrix** — computes actual pairwise correlations from 1 year of daily log returns; portfolio volatility uses the full correlation matrix (w^T Σ w) instead of a fixed assumption
- **Efficient frontier** — samples 3,000 random weight combinations across the weight simplex, plots their risk/return, and identifies the max Sharpe ratio portfolio with suggested optimal weights
- **Historical backtest** — replays each asset's actual price performance over the past 12 months with a weighted portfolio line, showing real cumulative returns
- **Asset breakdown** — per-asset risk contribution, scenario-adjusted return and volatility for each holding

### Data & Visualisation
- **Live market data** — fetches real 1-year price history from Yahoo Finance with crumb-based authentication (stocks, ETFs, crypto, indices)
- **Simulation paths** — 14 random GBM paths visualised over the 252-day horizon
- **Return distribution** — histogram of simulated 1-year outcomes with VaR reference line
- **Sparklines** — 30-day price sparkline per asset in the portfolio panel

## Stack

- **Frontend** — React 19, Recharts, IBM Plex Mono
- **Backend** — Vercel serverless functions (Node.js)
- **Data** — Yahoo Finance (crumb-authenticated)
- **Deployment** — Vercel

## Local Development

```bash
npm install
npm run dev
```

The API routes in `/api` require a Vercel-compatible environment. Use the Vercel CLI for full local support:

```bash
npm i -g vercel
vercel dev
```

## How It Works

1. Add any ticker (stocks, ETFs, crypto) to your portfolio — defaults to SPY/AGG/GLD (60/30/10)
2. Set portfolio weights
3. Choose a stress scenario
4. Run the simulation — 10,000 Monte Carlo paths computed in-browser
5. Review metrics across six tabs: Simulation Paths, Distribution, Historical Backtest, Asset Breakdown, Correlations, Efficient Frontier

Portfolio volatility is calculated using the full pairwise correlation matrix derived from each asset's historical daily log returns, giving an accurate diversification benefit.

## API Routes

| Route | Description |
|-------|-------------|
| `GET /api/ticker/[symbol]` | Fetches 1Y price history, annualised return, volatility, daily returns array, and normalised price history |
| `GET /api/search?q=` | Searches tickers by name or symbol |
