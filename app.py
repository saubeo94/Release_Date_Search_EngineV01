"""Release date finder — search game release dates across SS and Zenith sources."""

import io
import re
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
ZENITH_SHARE_ID = "shrb8FLfCo7RMpy9C"
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


def _cell_to_text(value) -> str:
    """Flatten Airtable cell values (strings, dicts, lists) into display text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, dict):
        for key in ("name", "text", "url", "filename", "value"):
            if key in value and isinstance(value[key], (str, int, float)):
                return str(value[key])
        return str(value)
    if isinstance(value, list):
        return ", ".join(_cell_to_text(v) for v in value)
    return str(value)


@st.cache_data(ttl=600, show_spinner=False)
def fetch_shared_view() -> pd.DataFrame:
    """Read the Zenith *shared view* without a token (self-coded mirror).

    Loads the public share page, extracts the parameters Airtable's own
    front-end uses, then calls the internal readSharedViewData endpoint.
    This endpoint is undocumented — if Airtable changes it, this raises
    and the app falls back to the shared-view link button.
    """
    sess = requests.Session()
    sess.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
        ),
    })
    # Some shares only resolve at the full path, others at the short link —
    # try both.
    page = None
    last_exc = None
    for share_url in (AIRTABLE_SHARED_URL, f"https://airtable.com/{ZENITH_SHARE_ID}"):
        try:
            candidate = sess.get(share_url, timeout=30)
            candidate.raise_for_status()
            page = candidate
            break
        except requests.RequestException as exc:
            last_exc = exc
    if page is None:
        raise RuntimeError(f"Share page could not be loaded: {last_exc}")
    html = page.text

    def find(pattern: str, text: str | None = None) -> str | None:
        m = re.search(pattern, text if text is not None else html)
        return m.group(1) if m else None

    app_id = find(r'"applicationId"\s*:\s*"(app[A-Za-z0-9]+)"') or AIRTABLE_BASE
    page_load_id = find(r'"pageLoadId"\s*:\s*"(pgl[A-Za-z0-9]+)"')

    # Preferred: the ready-made data URL embedded in the page. Airtable
    # JSON-escapes slashes (\u002F), so unescape before matching too.
    unescaped = html.replace("\\u002F", "/").replace("\\u002f", "/").replace("\\/", "/")
    url_path = find(
        r'"(/v0\.3/view/viw[A-Za-z0-9]+/readSharedViewData\?[^"]*)"', unescaped
    )
    if url_path:
        data_url = "https://airtable.com" + url_path
    else:
        # Fallback: rebuild it from its parts.
        access_policy = find(r'accessPolicy=([^&"\\\s]+)', unescaped)
        request_id = find(r'"requestId"\s*:\s*"(req[A-Za-z0-9]+)"', unescaped)
        if not access_policy:
            raise RuntimeError(
                "Could not locate the shared-view data endpoint — Airtable "
                "may have changed the share page format."
            )
        data_url = (
            f"https://airtable.com/v0.3/view/{AIRTABLE_VIEW}/readSharedViewData"
            f"?stringifiedObjectParams=%7B%7D"
            f"&requestId={request_id or ''}&accessPolicy={access_policy}"
        )

    headers = {
        "x-airtable-application-id": app_id,
        "x-airtable-inter-service-client": "webClient",
        "x-requested-with": "XMLHttpRequest",
        "x-time-zone": "UTC",
        "x-user-locale": "en",
        "Referer": page.url,
        "Accept": "application/json",
    }
    if page_load_id:
        headers["x-airtable-page-load-id"] = page_load_id

    resp = sess.get(data_url, headers=headers, timeout=30)
    resp.raise_for_status()
    data = resp.json().get("data", {})
    table = data.get("table", {})
    col_names = {c["id"]: c.get("name", c["id"]) for c in table.get("columns", [])}
    rows = []
    for row in table.get("rows", []):
        cells = row.get("cellValuesByColumnId") or {}
        rows.append({
            col_names.get(cid, cid): _cell_to_text(val) for cid, val in cells.items()
        })
    if not rows:
        raise RuntimeError("Shared view returned no rows.")
    return pd.DataFrame(rows).fillna("")


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


def show_df_hits(df: pd.DataFrame, query: str, source_label: str) -> None:
    """Search a dataframe and render results with date columns first."""
    hits = search_sheet(df, query)
    if hits.empty:
        st.info(f'No match for "{query}" in {source_label}.')
        return
    display = hits.copy()
    date_cols = [
        c for c in display.columns
        if any(w in str(c).lower() for w in ("date", "release", "launch"))
    ]
    if date_cols:
        display = display[date_cols + [c for c in display.columns if c not in date_cols]]
    st.success(f"{len(display)} match(es) found in {source_label}")
    st.dataframe(display, use_container_width=True, hide_index=True)


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
    # Source chain: mirror sheet -> Airtable API token -> shared-view reader
    # -> link to the shared view. First source that works wins.
    if aggregator == "Zenith":
        handled = False
        failures = []

        # 1) Google Sheet mirror (if configured in secrets)
        mirror_id = st.secrets.get("ZENITH_SHEET_ID", "").strip()
        mirror_gid = str(st.secrets.get("ZENITH_SHEET_GID", "0")).strip()
        if mirror_id:
            try:
                with st.spinner("Fetching Zenith mirror sheet…"):
                    df = fetch_sheet(mirror_id, mirror_gid)
                show_df_hits(df, game_name, "the Zenith mirror sheet")
                handled = True
            except requests.RequestException as exc:
                failures.append(f"mirror sheet: {exc}")

        # 2) Airtable API (if a token is configured in secrets)
        if not handled and st.secrets.get("AIRTABLE_TOKEN", ""):
            try:
                with st.spinner("Fetching from Airtable API…"):
                    records = fetch_airtable()
                hits = search_airtable(records, game_name)
                if not hits:
                    st.info(f'No Zenith record matches "{game_name}".')
                for fields in hits[:20]:
                    dates = date_like_fields(fields)
                    title = next(
                        (v for v in fields.values() if isinstance(v, str)), "Match"
                    )
                    with st.container(border=True):
                        st.subheader(title)
                        if dates:
                            for k, v in dates.items():
                                st.metric(k, str(v))
                        with st.expander("All fields"):
                            st.json(fields)
                handled = True
            except (RuntimeError, requests.RequestException) as exc:
                failures.append(f"Airtable API: {exc}")

        # 3) Shared-view reader (no token needed; uses an unofficial endpoint)
        if not handled:
            try:
                with st.spinner("Reading the Zenith shared view…"):
                    df = fetch_shared_view()
                show_df_hits(df, game_name, "the Zenith shared view")
                handled = True
            except (RuntimeError, requests.RequestException, ValueError) as exc:
                failures.append(f"shared view: {exc}")

        # 4) Last resort: hand the user the link
        if not handled:
            st.error(
                "Couldn't fetch Zenith data from any source. "
                + " | ".join(failures)
            )
            st.link_button("Open Zenith Airtable", AIRTABLE_SHARED_URL)

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
