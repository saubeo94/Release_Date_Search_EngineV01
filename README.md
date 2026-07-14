# Release Date Checker

Internal DX tool: paste rows from the weekly game sync sheet, look up each game's
release date, and copy the dates back — with warnings for games that are **not yet
released** (do not open on MP), removed, or not found.

## How dates are resolved (channel routing)

S5 opens games through provider aggregators — Zenith (currently LATAM) and SS
(currently Asia), with Amb ready to configure. The same game gets a different
release date per channel, and the aggregator prefix in the sync sheet's provider
cell names the channel, so that channel's own source decides each row's date:

- `zen: X` rows → the **Zenith list** answers; provider documents are context.
- `SS: X` / `amb: X` rows → that aggregator's **provider document** (live Google
  Sheet, e.g. the TaDa/JILI release-date docs) answers; Zenith is context.
- When the routed channel has no usable date (e.g. JILI lists a game as
  "Customer Limited"), the other source's date is used and marked as a fallback
  — every result row shows a "from …" tag naming its source.

JILI ≡ TaDa is declared as one brand family (`BRAND_FAMILIES` in `src/App.jsx`):
vendor matching never flags them against each other.

## Data sources

- **Zenith list** priority: uploaded CSV (localStorage, until Clear) → **live
  Airtable** via the `/api/zenith` serverless function (needs the
  `AIRTABLE_TOKEN` env var on Vercel; the token never reaches the browser) →
  bundled `public/gamelist.csv` fallback.
- **Provider documents**: editable link slots (defaults: JILI + TaDa sheets),
  persisted in `localStorage`, fetched client-side from Google Sheets' CSV
  export (sheets must be shared "anyone with the link can view").

## Stack

Vite + React single-page app + one Vercel serverless function (`api/zenith.js`).
CSV parsing in the browser via papaparse.

## Local development

```bash
npm install
npm run dev
```

## Monthly game-list update

With `AIRTABLE_TOKEN` configured, **no monthly update is needed** — Zenith data
is read live. The bundled CSV only serves as the fallback; refresh it
occasionally so the fallback stays reasonable:

1. Export the new CSV from Airtable ("ONEAPI Updated Game List — All Game").
2. Replace `public/gamelist.csv` with the new export.
3. Bump `public/version.json`:

   ```json
   { "updated": "2026-08-01", "source": "ONEAPI July 2026 export" }
   ```

4. Commit and push — Vercel auto-redeploys.

## Deploy

A live instance already runs at **https://release-date-checker.vercel.app**
(deployed from golds5/release-date-checker, with `AIRTABLE_TOKEN` configured).

To host it from this repo instead: import the repo on vercel.com (the Vite
preset handles the build; `api/zenith.js` deploys as a serverless function
automatically) and set the `AIRTABLE_TOKEN` environment variable — same token
as the Streamlit version's secrets, scope `data.records:read` on the ONEAPI
base. Without the token the app still works, using the bundled CSV fallback.
