"""Release date finder — search game release dates across SS and Zenith sources."""

import io
import urllib.parse

import pandas as pd
import requests
import streamlit as st

# ---------------------------------------------------------------- data sources

SS_SHEETS = {
    # provider (lowercase) -> (spreadsheet id, gid, tab label shown to user)
    "jili": ("1kxsfZ9KFycb63Gkj-jrRleNw0rwHGEdhAGWBLKA-65E", "2092046084", "Jili game list"),
    "tada": ("1YfVQqjWga0txvHm2oU_CGuLJLtXY1qmI2q3kAR0uDeU", "2124566733", "game list"),
}

AIRTABLE_BASE = "appcJn8Ck6R7RTccl"
AIRTABLE_TABLE = "tblsnoI1fwUkVfg73"
AIRTABLE_VIEW = "viwJ2rBmrvjE5YGoG"
AIRTABLE_SHARED_URL = (
    "https://airtable.com/appcJn8Ck6R7RTccl/shrb8FLfCo7RMpy9C/"
    "tblsnoI1fwUkVfg73/viwJ2rBmrvjE5YGoG"
)

RELEASE_DATE_COLUMN = 2  # column C in both SS sheets


# ------------------------------------------------------------------- fetchers

@st.cache_data(ttl=600, show_spinner=False)
def fetch_sheet(sheet_id: str, gid: str) -> pd.DataFrame:
    """Download a public Google Sheet tab as a DataFrame."""
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return pd.read_csv(io.StringIO(resp.text), dtype=str).fillna("")


@st.cache_data(ttl=600, show_spinner=False)
def fetch_airtable() -> list[dict]:
    """Download all records from the Zenith Airtable view (needs API token)."""
    token = st.secrets.get("AIRTABLE_TOKEN", "")
    if not token:
        raise RuntimeError("missing-token")
    url = f"https://api.airtable.com/v0/{AIRTABLE_BASE}/{AIRTABLE_TABLE}"
    headers = {"Authorization": f"Bearer {token}"}
    records, offset = [], None
    while True:
        params = {"view": AIRTABLE_VIEW, "pageSize": 100}
        if offset:
            params["offset"] = offset
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        records.extend(payload.get("records", []))
        offset = payload.get("offset")
        if not offset:
            return records


# -------------------------------------------------------------------- helpers

def search_sheet(df: pd.DataFrame, query: str) -> pd.DataFrame:
    """Case-insensitive substring match across every column."""
    q = query.strip().lower()
    mask = df.apply(lambda col: col.str.lower().str.contains(q, na=False)).any(axis=1)
    return df[mask]


def search_airtable(records: list[dict], query: str) -> list[dict]:
    q = query.strip().lower()
    hits = []
    for rec in records:
        fields = rec.get("fields", {})
        for value in fields.values():
            if isinstance(value, str) and q in value.lower():
                hits.append(fields)
                break
    return hits


def date_like_fields(fields: dict) -> dict:
    return {
        k: v for k, v in fields.items()
        if any(w in k.lower() for w in ("date", "release", "launch"))
    }


def slotcatalog_link(query: str) -> str:
    return (
        "https://www.google.com/search?q="
        + urllib.parse.quote_plus(f"site:slotcatalog.com {query}")
    )


# ------------------------------------------------------------------------- ui

st.set_page_config(page_title="Release date finder", page_icon="🎰", layout="centered")

st.markdown(
    """
    <style>
      .stButton > button[kind="primary"] { width: 100%; }
      div[data-testid="stHorizontalBlock"] { gap: 0.5rem; }
    </style>
    """,
    unsafe_allow_html=True,
)

st.title("Release date finder")
st.caption("Search a game's release date directly from the aggregator sources.")

providers = (
    pd.read_csv("game_providers.csv", encoding="utf-8-sig")["Provider"]
    .dropna().str.strip().tolist()
)

game_name = st.text_input("Game name", placeholder="e.g. Lucky Jaguar")
provider = st.selectbox("Game provider", providers)
aggregator = st.radio("Aggregator", ["SS", "Zenith"], horizontal=True)

if st.button("Search", type="primary"):
    if not game_name.strip():
        st.warning("Enter a game name first.")
        st.stop()

    # ---------------------------------------------------------------- Zenith
    if aggregator == "Zenith":
        records = None
        mirror_id = st.secrets.get("ZENITH_SHEET_ID", "").strip()
        mirror_gid = str(st.secrets.get("ZENITH_SHEET_GID", "0")).strip()

        # 1) preferred: the Google Sheet mirror kept in sync by a connector
        if mirror_id:
            try:
                with st.spinner("Fetching Zenith mirror sheet…"):
                    df = fetch_sheet(mirror_id, mirror_gid)
            except requests.RequestException as exc:
                st.error(
                    f"Could not read the Zenith mirror sheet ({exc}). Make sure "
                    "it is shared as “anyone with the link can view”."
                )
                st.link_button("Open Zenith Airtable", AIRTABLE_SHARED_URL)
                st.stop()

            hits = search_sheet(df, game_name)
            if hits.empty:
                st.info(f'No match for "{game_name}" in the Zenith mirror.')
            else:
                display = hits.copy()
                date_cols = [
                    c for c in display.columns
                    if any(w in c.lower() for w in ("date", "release", "launch"))
                ]
                st.success(f"{len(display)} match(es) found")
                if date_cols:
                    ordered = date_cols + [c for c in display.columns if c not in date_cols]
                    display = display[ordered]
                st.dataframe(display, use_container_width=True, hide_index=True)
            records = []  # mirror handled the search; skip the API path below

        # 2) fallback: Airtable API (needs token)
        if records is None:
            try:
                with st.spinner("Fetching from Airtable…"):
                    records = fetch_airtable()
            except RuntimeError:
                st.error(
                    "Zenith is not configured yet. Add `ZENITH_SHEET_ID` (mirror "
                    "sheet) or `AIRTABLE_TOKEN` in the app's secrets (see README). "
                    "Until then, check the shared view directly:"
                )
                st.link_button("Open Zenith Airtable", AIRTABLE_SHARED_URL)
                st.stop()
            except requests.RequestException as exc:
                st.error(f"Airtable request failed: {exc}")
                st.link_button("Open Zenith Airtable", AIRTABLE_SHARED_URL)
                st.stop()

        # display Airtable API results (skipped when the mirror handled it)
        if not mirror_id:
            hits = search_airtable(records, game_name)
            if not hits:
                st.info(f'No Zenith record matches "{game_name}".')
            for fields in hits[:20]:
                dates = date_like_fields(fields)
                title = next((v for v in fields.values() if isinstance(v, str)), "Match")
                with st.container(border=True):
                    st.subheader(title)
                    if dates:
                        for k, v in dates.items():
                            st.metric(k, str(v))
                    with st.expander("All fields"):
                        st.json(fields)

    # -------------------------------------------------------------------- SS
    else:
        key = provider.strip().lower()
        if key not in SS_SHEETS:
            st.warning(
                f"No SS sheet is configured for **{provider}** — only JILI and "
                "TaDa have SS sources. Try the internet search below."
            )
        else:
            sheet_id, gid, tab = SS_SHEETS[key]
            try:
                with st.spinner(f"Fetching “{tab}” sheet…"):
                    df = fetch_sheet(sheet_id, gid)
            except requests.RequestException as exc:
                st.error(
                    f"Could not read the Google Sheet ({exc}). Make sure it is "
                    "shared as “anyone with the link can view”."
                )
                st.stop()

            hits = search_sheet(df, game_name)
            if hits.empty:
                st.info(f'No match for "{game_name}" in the {provider} sheet.')
            else:
                display = hits.copy()
                if len(display.columns) > RELEASE_DATE_COLUMN:
                    display = display.rename(
                        columns={display.columns[RELEASE_DATE_COLUMN]: "Release date"}
                    )
                st.success(f"{len(display)} match(es) found")
                st.dataframe(display, use_container_width=True, hide_index=True)

    # ---------------------------------------------------------- fallback card
    with st.container(border=True):
        st.markdown("**Internet**  \nIf not found in official sources, search here.")
        st.link_button("Search SlotCatalog via Google", slotcatalog_link(game_name))
