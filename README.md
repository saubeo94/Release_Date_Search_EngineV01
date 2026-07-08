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
