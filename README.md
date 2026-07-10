# Release date finder

Internal tool for looking up game release dates. Enter a game name, pick the
provider, choose the aggregator (SS or Zenith), and the app fetches the
release date live from the right source:

| Aggregator | Provider | Source |
|---|---|---|
| Zenith | any | Airtable (Zenith game base, via API) |
| SS | JILI | Google Sheet → "Jili game list" tab, release date in column C |
| SS | TaDa | Google Sheet → "game list" tab, release date in column C |
| SS | other | No official source — SlotCatalog search link shown instead |

A "Search SlotCatalog via Google" fallback link is always shown.

## Zenith mirror (recommended way to get live Zenith data)

Instead of an Airtable token, mirror the Zenith Airtable into a Google Sheet
with a free connector, and let the app read the sheet. One-time setup by
someone who is a collaborator on the Zenith base:

1. **Create an empty Google Sheet** (e.g. "Zenith mirror") and set sharing to
   "anyone with the link can view".
2. **Set up the sync** with one of these free tools:
   - **Data Fetcher** (Airtable extension): in the Zenith base, add the Data
     Fetcher extension → create an *export* request → destination: Google
     Sheets → pick your mirror sheet → set a schedule (e.g. daily).
   - **Coupler.io**: new importer → source: Airtable (paste the shared view
     URL) → destination: your Google Sheet → schedule it.
3. **Point the app at the mirror**: in Streamlit Cloud → App → Settings →
   Secrets, add:
   ```toml
   ZENITH_SHEET_ID = "the long id from the sheet URL"
   ZENITH_SHEET_GID = "0"    # the gid= value of the tab, 0 for the first tab
   ```
   Save — the app reboots and Zenith searches now read the mirror.

Source priority for Zenith: mirror sheet → Airtable API token → link to the
shared view. The app automatically shows any column containing
"date" / "release" / "launch" first in the results.

## Deploy online for the team (recommended: Streamlit Community Cloud, free)

1. Push this folder to a GitHub repository (public or private):
   ```bash
   git remote add origin https://github.com/<your-username>/release-date-finder.git
   git push -u origin main
   ```
2. Go to https://share.streamlit.io, sign in with GitHub, click **New app**,
   pick this repo, branch `main`, main file `app.py`, and deploy.
3. **Add the Airtable token** (needed for Zenith lookups):
   - In Airtable: click your avatar → *Builder hub* → *Personal access tokens*
     → create a token with the `data.records:read` scope and access to the
     Zenith base (`appcJn8Ck6R7RTccl`).
   - In Streamlit Cloud: your app → **Settings → Secrets**, paste:
     ```toml
     AIRTABLE_TOKEN = "pat…your token…"
     ```
4. Share the app URL (`https://<app-name>.streamlit.app`) with your team.
   Anyone with the link can use it — no accounts needed.

> Without the token, Zenith searches show a direct link to the shared
> Airtable view instead of live results. SS (Google Sheets) searches work
> with no setup, as long as both sheets are shared as
> "anyone with the link can view".

## Run locally

```bash
pip install -r requirements.txt
cp .streamlit/secrets.toml.example .streamlit/secrets.toml   # add your token
streamlit run app.py
```

## Run in Google Colab (for quick testing only)

```python
!pip install streamlit -q
!git clone https://github.com/<your-username>/release-date-finder.git
%cd release-date-finder
!streamlit run app.py &>/dev/null &
# then use a tunnel (e.g. cloudflared or ngrok) to expose port 8501
```

Colab links die when the notebook stops, so use Streamlit Cloud for the
team-facing version.

## Files

- `app.py` — the Streamlit app
- `game_providers.csv` — provider dropdown list (90 providers)
- `.streamlit/config.toml` — theme (blue primary button, light background)
- `.streamlit/secrets.toml.example` — token template (never commit the real one)
