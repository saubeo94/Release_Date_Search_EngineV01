"""Pointer page for the old Streamlit deployment.

The Release Date Checker is now the React app in this repo, hosted on Vercel.
This keeps the old Streamlit URL working as a signpost instead of an error.
"""

import streamlit as st

URL = "https://release-date-checker.vercel.app"

st.set_page_config(page_title="Release Date Checker — moved", page_icon="🎰")
st.title("This tool has moved 🎰")
st.markdown(
    f"The Release Date Checker now lives at\n\n### [{URL}]({URL})\n\n"
    "Same purpose, more features: batch check with aggregator channel routing "
    "(`zen:` / `SS:` / `amb:`), Zenith cross-checked against the provider "
    "documents, live Airtable data, and one-click copy back to the sync sheet.\n\n"
    "Please update your bookmark."
)
st.link_button("Open the new Release Date Checker", URL, type="primary")
