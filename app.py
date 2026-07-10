"""Release date finder — search game release dates across SS and Zenith sources."""

import io
import re
import urllib.parse
from html import unescape

import pandas as pd
import requests
import streamlit as st

# ---------------------------------------------------------------- data sources

SS_SHEETS = {
    # provider (lowercase) -> (spreadsheet id, gid, tab label shown to user)
    "jili": ("1kxsfZ9KFycb63Gkj-jrRleNw0rwHGEdhAGWBLKA-65E", "2092046084", "Jili game list"),
    "tada": ("1YfVQqjWga0txvHm2oU_CGuLJLtXY1qmI2q3kAR0uDeU", "2124566733", "game list"),
}

# Amb aggregator sources — fill in once you have the sheet/source for each
# provider, same shape as SS_SHEETS: "provider": (sheet_id, gid, "tab name").
AMB_SHEETS: dict[str, tuple[str, str, str]] = {}

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


def google_search_url(query: str) -> str:
    return "https://www.google.com/search?q=" + urllib.parse.quote_plus(query)


@st.cache_data(ttl=600, show_spinner=False)
def fetch_ddg(query: str, num: int = 1) -> list[dict]:
    """Best-effort search via DuckDuckGo's HTML endpoint — no API key needed.

    Datacenter IPs (like Streamlit Cloud) may get rate-limited or blocked; on
    any failure this returns an empty list and the caller shows a search link.
    """
    resp = requests.post(
        "https://html.duckduckgo.com/html/",
        data={"q": query},
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
            ),
            "Referer": "https://duckduckgo.com/",
        },
        timeout=30,
    )
    resp.raise_for_status()
    html_text = resp.text

    def strip_tags(s: str) -> str:
        return unescape(re.sub(r"<[^>]+>", "", s)).strip()

    def decode_href(href: str) -> str:
        m = re.search(r"uddg=([^&]+)", href)
        return urllib.parse.unquote(m.group(1)) if m else href

    titles = re.findall(
        r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html_text, re.S
    )
    snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', html_text, re.S)

    results = []
    for i, (href, title_html) in enumerate(titles[:num]):
        link = decode_href(href)
        results.append({
            "title": strip_tags(title_html),
            "link": link,
            "snippet": strip_tags(snippets[i]) if i < len(snippets) else "",
            "display_link": urllib.parse.urlparse(link).netloc,
            "thumbnail": "",
        })
    return results


def first_web_result(phrase: str) -> list[dict]:
    """Get the top result: Google CSE if a key is set, else DuckDuckGo."""
    try:
        return fetch_google_cse(phrase, num=1)
    except RuntimeError:
        return fetch_ddg(phrase, num=1)


def render_result_card(r: dict) -> None:
    """Render one Google result as a card resembling a search snippet."""
    domain = r.get("display_link", "")
    favicon = (
        f"https://www.google.com/s2/favicons?domain={domain}&sz=32"
        if domain else ""
    )
    thumb_html = (
        f'<img src="{r["thumbnail"]}" '
        'style="width:92px;height:92px;object-fit:cover;border-radius:8px;'
        'flex-shrink:0;" />'
        if r.get("thumbnail") else ""
    )
    fav_html = (
        f'<img src="{favicon}" style="width:16px;height:16px;border-radius:50%;" />'
        if favicon else ""
    )
    st.markdown(
        f"""
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;
                    background:#fff;display:flex;gap:14px;align-items:flex-start;
                    margin-bottom:6px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">
              {fav_html}
              <span style="font-size:0.8rem;color:#202124;">{domain}</span>
            </div>
            <a href="{r['link']}" target="_blank"
               style="font-size:1.1rem;color:#1a0dab;text-decoration:none;
                      font-weight:500;display:block;margin:2px 0;">
              {r['title']}
            </a>
            <div style="font-size:0.85rem;color:#4d5156;line-height:1.4;">
              {r['snippet']}
            </div>
          </div>
          {thumb_html}
        </div>
        """,
        unsafe_allow_html=True,
    )


@st.cache_data(ttl=600, show_spinner=False)
def fetch_google_cse(query: str, num: int = 1) -> list[dict]:
    """Return top Google results via the Custom Search JSON API (free tier).

    Needs GOOGLE_API_KEY and GOOGLE_CSE_ID in secrets. Raises RuntimeError
    with 'no-key' if not configured, so the caller can fall back to links.
    """
    key = st.secrets.get("GOOGLE_API_KEY", "").strip()
    cx = st.secrets.get("GOOGLE_CSE_ID", "").strip()
    if not key or not cx:
        raise RuntimeError("no-key")
    resp = requests.get(
        "https://www.googleapis.com/customsearch/v1",
        params={"key": key, "cx": cx, "q": query, "num": num},
        timeout=30,
    )
    resp.raise_for_status()
    items = resp.json().get("items", [])
    results = []
    for it in items[:num]:
        pagemap = it.get("pagemap", {}) or {}
        thumb = ""
        if pagemap.get("cse_thumbnail"):
            thumb = pagemap["cse_thumbnail"][0].get("src", "")
        elif pagemap.get("cse_image"):
            thumb = pagemap["cse_image"][0].get("src", "")
        results.append({
            "title": it.get("title", ""),
            "link": it.get("link", ""),
            "snippet": it.get("snippet", ""),
            "display_link": it.get("displayLink", ""),
            "thumbnail": thumb,
        })
    return results


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
      .stButton > button[kind="primary"] { width: auto; padding: 0.4rem 1.4rem; }
      /* Black "Zenith" link button */
      a.zenith-btn {
        display: inline-block;
        background: #111111;
        color: #ffffff !important;
        text-decoration: none !important;
        padding: 0.45rem 1.5rem;
        border-radius: 8px;
        font-weight: 600;
        font-size: 0.95rem;
        line-height: 1.6;
        white-space: nowrap;
      }
      a.zenith-btn:hover { background: #333333; }
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

# --- Aggregator card: SS / Amb radio on the left, black Zenith link on the right
with st.container(border=True):
    left, right = st.columns([2, 1])
    with left:
        aggregator = st.radio("Aggregator", ["SS", "Amb"], horizontal=True)
    with right:
        st.markdown("&nbsp;", unsafe_allow_html=True)  # vertical spacing to align
        st.markdown(
            f'<a class="zenith-btn" href="{AIRTABLE_SHARED_URL}" target="_blank">'
            "Zenith</a>",
            unsafe_allow_html=True,
        )

game_name = st.text_input("Game name", placeholder="e.g. Super Ace")
provider = st.selectbox("Game provider", providers)

if st.button("Search", type="primary"):
    if not game_name.strip():
        st.warning("Enter a game name first.")
        st.stop()

    # -------------------------------------------------------------------- SS
    if aggregator == "SS":
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

    # ------------------------------------------------------------------- Amb
    else:
        key = provider.strip().lower()
        if key not in AMB_SHEETS:
            st.warning(
                f"No Amb source is configured yet for **{provider}**. "
                "Use the internet search below in the meantime."
            )
        else:
            sheet_id, gid, tab = AMB_SHEETS[key]
            try:
                with st.spinner(f"Fetching “{tab}” sheet…"):
                    df = fetch_sheet(sheet_id, gid)
                show_df_hits(df, game_name, f"the Amb {provider} source")
            except requests.RequestException as exc:
                st.error(
                    f"Could not read the Amb source ({exc}). Make sure it is "
                    "shared as “anyone with the link can view”."
                )

    # ------------------------------------------------------- internet section
    with st.container(border=True):
        st.markdown("**Internet**")
        prov = provider.strip()
        name = game_name.strip()
        phrases = [
            f"{name} {prov} release date bigwinboard",
            f"{name} {prov} release date slotcatalog",
            f"{name} {prov} release date",
        ]
        for phrase in phrases:
            try:
                results = first_web_result(phrase)
            except requests.RequestException:
                results = []
            if results:
                render_result_card(results[0])
            else:
                st.markdown(f"*{phrase}*")
                st.link_button("Search on Google", google_search_url(phrase))
