# ALADDIN — Risk Simulator

A portfolio risk simulator inspired by BlackRock's Aladdin platform. Built with React and deployed on Vercel with serverless API routes.

## Features

- **Live market data** — fetches real price history from Yahoo Finance (stocks, ETFs, crypto, indices)
- **Monte Carlo simulation** — 10,000 paths using correct log-normal GBM with Itô correction
- **Stress testing** — 6 scenarios: Base Case, Fed Rate Hike, Geopolitical Crisis, Global Recession, Inflation Surge, Market Crash
- **Risk metrics** — VaR (95%/99%), CVaR, Sharpe Ratio, Median Max Drawdown, Mean/Median return
- **Portfolio breakdown** — per-asset risk contribution with scenario-adjusted return and volatility
- **Return distribution** — histogram of simulated 1-year outcomes with VaR reference line
- **Simulation paths** — 14 random GBM paths visualised over the 252-day horizon

## Stack

- **Frontend** — React, Recharts, IBM Plex Mono
- **Backend** — Vercel serverless functions (Node.js)
- **Data** — Yahoo Finance public API
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

1. Add any ticker (stocks, ETFs, crypto) to your portfolio
2. Set portfolio weights
3. Choose a stress scenario
4. Run the simulation — 10,000 Monte Carlo paths are computed in-browser
5. Review VaR, CVaR, Sharpe, and drawdown metrics

Portfolio volatility is calculated using a constant pairwise correlation assumption (ρ=0.3) to account for diversification benefit rather than assuming perfect correlation between assets.

## API Routes

| Route | Description |
|-------|-------------|
| `GET /api/ticker/[symbol]` | Fetches 1Y price history, annualised return, and volatility for a given ticker |
| `GET /api/search?q=` | Searches tickers by name or symbol |
