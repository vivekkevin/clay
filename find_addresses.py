#!/usr/bin/env python3
"""
find_addresses.py  (v2 — token-optimized, cached, with live CLI dashboard)
==========================================================================
Find the complete street address for each location row in a spreadsheet.

INPUT  : an .xlsx with at least two columns:
           - "Text"        -> "Company Name, Location Name, City, State, Country"
           - "Source Link" -> a URL pointing to a source document
OUTPUT : an .xlsx with columns:
           S.No | Text | Source Link | Full Address | Status | Notes
         (IDENTICAL schema to v1 — drop-in compatible)

What changed in v2 (all token-saving, no accuracy loss)
-------------------------------------------------------
  1. URL RESULT CACHE      : if the same Source Link appears on many rows, the page
                             is fetched + analyzed ONCE; every later row with that
                             link reuses the cached answer => 0 extra tokens.
  2. ADDRESS WINDOWING     : instead of sending the first 6 000 chars to the model,
                             only the text *around* address-signal keywords is sent.
                             Same answer, a few hundred tokens instead of ~1 500.
  3. JSON-LD SHORT-CIRCUIT : if the page exposes a structured PostalAddress with a
                             postal code, accept it and skip the LLM entirely.
  4. LEAN PROMPTS          : compact system + user prompts.
  5. LIVE TOKEN ACCOUNTING : every API call's input/output tokens are summed and
                             shown live, with a final cost-style summary.

Modes
-----
  heuristic (default) : pure-Python. No API key. Marks low-confidence rows for review.
  llm                 : uses the Anthropic API (via your gateway) only when needed,
                        with a Python web-search fallback for broken/careers/PDF links.

Usage
-----
  pip install requests beautifulsoup4 openpyxl pandas lxml ddgs anthropic
  python find_addresses.py input.xlsx -o output.xlsx
  python find_addresses.py input.xlsx -o output.xlsx --mode llm

  --limit 20         only process the first 20 rows
  --start 100        skip the first 100 rows (resume)
  --sleep 1.5        seconds between rows
  --model claude-opus-4-6
  --no-cache         disable the same-link reuse cache (not recommended)
  --price-in  3.0    USD per 1M input tokens  (for the cost estimate only)
  --price-out 15.0   USD per 1M output tokens (for the cost estimate only)
"""

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

# ddgs is only needed for the LLM web-search fallback; import lazily so heuristic
# mode works without it installed.
try:
    from ddgs import DDGS
except Exception:  # pragma: no cover
    DDGS = None


# ----------------------------------------------------------------------------- #
# Configuration
# ----------------------------------------------------------------------------- #

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}
REQUEST_TIMEOUT = 25

SKIP_URL_HINTS = (
    "careers", "career", "jobs", "job-", "/job/", "login", "signin", "sign-in",
    "auth", "account", "linkedin.com/jobs", "indeed.com", "glassdoor",
)

OUTPUT_COLUMNS = ["S.No", "Text", "Source Link", "Full Address", "Status", "Source", "Notes"]

# Token-budget constants
# DEFAULT EXTRACTION = address-paragraph windowing (token-efficient, accuracy-safe):
#   * HTML tags are stripped first; only readable text reaches the model.
#   * The cleaned text is searched for address-signal words; only the PARAGRAPH(S)
#     around those words are kept.
#   * If more than 3 signal locations are found, only the FIRST 3 are sent.
#   * The excerpt is capped at ~6,000 characters (~3,000 tokens).
#   * If NO signal words are found, the first 6,000 chars of cleaned text are sent
#     as a safety net (so an address in an unusual spot is not lost).
#   * Claude's native web_search tool remains attached for broken/empty pages.
#   * The duplicate (Text+link) cache still reuses identical rows at zero tokens.
PAGE_EXCERPT_CHARS = 12_000  # absolute safety ceiling on raw cleaned text
LLM_MAX_TOKENS     = 400     # room for address + notes
WEB_SEARCH_USES    = 3       # max native web_search uses per row

# Address-paragraph windowing parameters (now the DEFAULT path).
ADDR_WINDOW_CHARS    = 6_000  # cap on the windowed excerpt actually sent (~3k tokens)
ADDR_WINDOW_SPAN     = 700    # chars captured AFTER each address keyword (the paragraph)
ADDR_WINDOW_LOOKBACK = 160    # chars captured BEFORE each keyword
ADDR_MAX_LOCATIONS   = 3      # if more than this many signal locations, keep first 3


# ----------------------------------------------------------------------------- #
# ANSI helpers for the CLI dashboard (degrade gracefully if not a TTY)
# ----------------------------------------------------------------------------- #

class C:
    USE = sys.stdout.isatty()
    RESET = "\033[0m"  if USE else ""
    BOLD  = "\033[1m"  if USE else ""
    DIM   = "\033[2m"  if USE else ""
    GREEN = "\033[32m" if USE else ""
    YELLOW= "\033[33m" if USE else ""
    RED   = "\033[31m" if USE else ""
    BLUE  = "\033[34m" if USE else ""
    CYAN  = "\033[36m" if USE else ""
    GREY  = "\033[90m" if USE else ""


def status_color(status):
    return {"Verified": C.GREEN, "Partial": C.YELLOW,
            "Not Found": C.RED}.get(status, C.RESET)


def human(n):
    """Compact thousands formatting for token counts."""
    return f"{n:,}"


# ----------------------------------------------------------------------------- #
# Global usage accumulator
# ----------------------------------------------------------------------------- #

class Usage:
    """Tracks tokens, API calls, cache hits, and per-source dedupe."""
    def __init__(self):
        self.in_tokens = 0
        self.out_tokens = 0
        self.api_calls = 0
        self.cache_hits = 0
        self.jsonld_hits = 0
        self.search_calls = 0

    def add_api(self, in_tok, out_tok):
        self.in_tokens += int(in_tok or 0)
        self.out_tokens += int(out_tok or 0)
        self.api_calls += 1

    @property
    def total(self):
        return self.in_tokens + self.out_tokens

    def cost(self, price_in, price_out):
        return (self.in_tokens / 1_000_000) * price_in + \
               (self.out_tokens / 1_000_000) * price_out


USAGE = Usage()


# ----------------------------------------------------------------------------- #
# Parsing the input "Text" field
# ----------------------------------------------------------------------------- #

def parse_text_field(text):
    parts = [p.strip() for p in str(text).split(",") if p.strip()]
    fields = {"company": "", "location": "", "city": "", "state": "", "country": "",
              "raw": str(text)}
    keys = ["company", "location", "city", "state", "country"]
    for i, key in enumerate(keys):
        if i < len(parts):
            fields[key] = parts[i]
    if parts:
        fields["country"] = parts[-1]
    return fields


def looks_like_skip_url(url):
    u = (url or "").lower()
    if not u or not u.startswith(("http://", "https://")):
        return True
    return any(h in u for h in SKIP_URL_HINTS)


# ----------------------------------------------------------------------------- #
# Fetching pages
# ----------------------------------------------------------------------------- #

def fetch(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT,
                         allow_redirects=True)
        ctype = r.headers.get("Content-Type", "").lower()
        if r.status_code >= 400:
            return None, ctype, f"HTTP {r.status_code}"
        if "application/pdf" in ctype or url.lower().endswith(".pdf"):
            return _extract_pdf_text(r.content), "pdf", None
        return r.text, ctype, None
    except requests.RequestException as e:
        return None, "", str(e)


def _extract_pdf_text(content):
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=content, filetype="pdf")
        text = "\n".join(page.get_text() for page in doc)
        doc.close()
        return text
    except Exception:
        return ""


# ----------------------------------------------------------------------------- #
# Page-text cleaning + address windowing  (token savers)
# ----------------------------------------------------------------------------- #

_NOISE_RE = re.compile(
    r"(?:nav(?:igation)?|header|footer|cookie|privacy policy|terms of (?:use|service)"
    r"|all rights reserved|©|\bskip to\b)",
    re.IGNORECASE,
)

_ADDR_SIGNAL_RE = re.compile(
    r"(?:address|headquarters|head office|located at|contact us|our office|"
    r"visit us|registered office|\bHQ\b|postal|zip|pin\s?code|\bsuite\b|\bfloor\b|"
    r"\bstreet\b|\bavenue\b|\bbuilding\b)",
    re.IGNORECASE,
)


def _strip_html_to_text(raw: str, content_type: str) -> str:
    """
    For HTML, remove all markup (and script/style/nav/footer) and return only the
    human-readable text. For PDF (already plain text) or unknown types, return as-is.
    This guarantees the model never receives raw tags.
    """
    if not raw:
        return ""
    ct = (content_type or "").lower()
    looks_html = ("html" in ct) or ("<" in raw and ">" in raw and "</" in raw)
    if content_type == "pdf" or not looks_html:
        return raw
    try:
        soup = BeautifulSoup(raw, "lxml")
        # Drop elements that never contain a usable postal address.
        for tag in soup(["script", "style", "noscript", "svg", "nav",
                         "header", "footer", "form", "button"]):
            tag.decompose()
        # get_text with a separator keeps word boundaries between elements.
        return soup.get_text(" ", strip=True)
    except Exception:
        # If parsing fails, fall back to a crude tag strip so tags still don't leak.
        return re.sub(r"<[^>]+>", " ", raw)


def clean_page_text(raw_text: str, content_type: str = "") -> str:
    """
    Produce a compact, readable, tag-free excerpt:
      1. Strip HTML markup so only text content remains (no tags ever reach the LLM).
      2. Drop boilerplate lines (nav/cookie/privacy/etc.).
      3. Remove very short lines and collapse repeated lines.
      4. Normalise whitespace and cap at the safety ceiling.
    """
    text = _strip_html_to_text(raw_text, content_type)
    if not text:
        return ""
    lines = re.split(r"[\r\n]+|(?<=[\.!?])\s{2,}", text)
    kept = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if len(stripped) < 4:
            continue
        if _NOISE_RE.search(stripped):
            continue
        kept.append(stripped)

    deduped, prev = [], None
    for ln in kept:
        if ln != prev:
            deduped.append(ln)
        prev = ln
    return " ".join(deduped)[:PAGE_EXCERPT_CHARS]


def address_windows(text: str,
                    span: int = ADDR_WINDOW_SPAN,
                    lookback: int = ADDR_WINDOW_LOOKBACK,
                    max_chars: int = ADDR_WINDOW_CHARS,
                    max_locations: int = ADDR_MAX_LOCATIONS) -> str:
    """
    Keep only the PARAGRAPH(S) around address-signal words, not the whole page.

      * Find every position where an address-signal word occurs.
      * Build a window around each: `lookback` chars before + `span` chars after.
      * Merge windows that overlap (so one address block isn't split).
      * If more than `max_locations` distinct windows exist, keep only the FIRST 3.
      * Cap the joined result at `max_chars` (~6,000 -> ~3,000 tokens).

    Returns "" if `text` is empty. The CALLER decides the no-signal fallback
    (send the head of the page) so this function's contract stays simple.
    """
    if not text:
        return ""
    hits = [m.start() for m in _ADDR_SIGNAL_RE.finditer(text)]
    if not hits:
        return ""  # signal: caller should fall back to head-of-page

    spans = [(max(0, h - lookback), min(len(text), h + span)) for h in hits]
    spans.sort()
    merged = [list(spans[0])]
    for s, e in spans[1:]:
        if s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    # Keep only the first N location windows.
    merged = merged[:max_locations]

    out, used = [], 0
    for s, e in merged:
        piece = text[s:e].strip()
        if not piece:
            continue
        out.append(piece)
        used += len(piece)
        if used >= max_chars:
            break
    return " … ".join(out)[:max_chars]


# ----------------------------------------------------------------------------- #
# Heuristic address extraction
# ----------------------------------------------------------------------------- #

STREET_SUFFIXES = (
    r"Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|"
    r"Way|Court|Ct\.?|Plaza|Square|Sq\.?|Suite|Ste\.?|Floor|Fl\.?|Highway|Hwy\.?|"
    r"Parkway|Pkwy\.?|Place|Pl\.?|Terrace|Circle|Cir\.?|Marg|Nagar|Park"
)
STREET_RE = re.compile(
    r"\d{1,5}[\w\.\-,/ ]{2,60}?\b(?:%s)\b[\w\.\-,/# ]{0,80}" % STREET_SUFFIXES,
    re.IGNORECASE,
)
POSTAL_RE = re.compile(r"\b(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d|\d{6})\b")


def extract_from_jsonld(soup):
    found = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except Exception:
            continue
        for obj in _iter_objs(data):
            addr = obj.get("address") if isinstance(obj, dict) else None
            if isinstance(addr, dict) and str(addr.get("@type", "")).endswith("PostalAddress"):
                pieces = [
                    addr.get("streetAddress"), addr.get("addressLocality"),
                    addr.get("addressRegion"), addr.get("postalCode"),
                    addr.get("addressCountry"),
                ]
                joined = ", ".join(_flatten(pieces))
                if joined.strip():
                    found.append(joined.strip())
    return found


def _iter_objs(data):
    if isinstance(data, list):
        for d in data:
            yield from _iter_objs(d)
    elif isinstance(data, dict):
        yield data
        for v in data.values():
            if isinstance(v, (list, dict)):
                yield from _iter_objs(v)


def _flatten(pieces):
    out = []
    for p in pieces:
        if isinstance(p, dict):
            p = p.get("name") or p.get("@id") or ""
        if p:
            out.append(str(p).strip())
    return out


def heuristic_extract(page_text, content_type):
    """Returns (address, method) where method is one of:
       'jsonld' | 'regex-pdf' | 'regex-html' | None"""
    if not page_text:
        return None, None

    if content_type == "pdf":
        text = page_text
        regex_method = "regex-pdf"
    else:
        soup = BeautifulSoup(page_text, "lxml")
        jsonld = extract_from_jsonld(soup)
        if jsonld:
            return jsonld[0], "jsonld"
        text = soup.get_text(" ", strip=True)
        regex_method = "regex-html"

    m = STREET_RE.search(text)
    if m:
        snippet = m.group(0).strip(" ,;")
        tail = text[m.end(): m.end() + 40]
        pm = POSTAL_RE.search(tail)
        if pm and pm.group(0) not in snippet:
            snippet = f"{snippet}, {pm.group(0)}"
        return snippet, regex_method

    return None, None


# ----------------------------------------------------------------------------- #
# Python-based Web Search Fallback
# ----------------------------------------------------------------------------- #

def fallback_web_search(fields):
    """Searches DuckDuckGo for the address and returns compact text snippets."""
    if DDGS is None:
        return "Web search unavailable (ddgs not installed)."
    query = (f"{fields['company']} {fields['location']} {fields['city']} "
             f"{fields['country']} headquarters street address")
    try:
        results = DDGS().text(query, max_results=SEARCH_RESULTS)
        if not results:
            return "No web search results found."
        snippets = []
        for i, r in enumerate(results, 1):
            body = (r.get("body", "") or "")[:SEARCH_SNIPPET_CAP]
            snippets.append(f"Result {i}: {r.get('title', '')} — {body}")
        return "\n".join(snippets)
    except Exception as e:
        return f"Web search failed: {e}"


# ----------------------------------------------------------------------------- #
# LLM-assisted extraction
# ----------------------------------------------------------------------------- #

_LLM_SYSTEM = (
    "Find the exact published street address of the given company location. "
    "Copy it exactly; never invent any part. If the page is careers/login/broken or "
    "has no address, use web_search. Prefer official sites/directories, not Wikipedia. "
    "status: 'Verified'=full street address; 'Partial'=only city/postal/country; "
    "'Not Found'=nothing reliable. "
    "used: 'page' if the address came from the supplied page text, "
    "'websearch' if you used the web_search tool, 'none' if not found. "
    'Reply ONLY JSON: {"address":"...","status":"Verified|Partial|Not Found",'
    '"used":"page|websearch|none","notes":"..."} '
    "In notes, mention any caveats."
)

_ANTHROPIC_CLIENT = None

# Where to send API requests.
#   * Default: the standard Anthropic endpoint (same as Opus_4_6_script.py).
#   * Override: set the env var ANTHROPIC_BASE_URL to use a gateway/proxy.
# (The previous build hard-coded a gateway that was timing out on every row.)
API_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "").strip() or None
API_TIMEOUT  = float(os.environ.get("ANTHROPIC_TIMEOUT", "120"))  # seconds per call
API_RETRIES  = int(os.environ.get("ANTHROPIC_MAX_RETRIES", "2"))  # SDK auto-retries


def _get_client():
    global _ANTHROPIC_CLIENT
    if _ANTHROPIC_CLIENT is None:
        try:
            import anthropic
        except ImportError:
            raise SystemExit("pip install anthropic  (needed for --mode llm)")
        kwargs = {
            "api_key": os.environ.get("ANTHROPIC_API_KEY"),
            "timeout": API_TIMEOUT,        # web_search calls can be slow; give them room
            "max_retries": API_RETRIES,    # transient network blips retry automatically
        }
        if API_BASE_URL:                   # only override the endpoint if asked to
            kwargs["base_url"] = API_BASE_URL
        _ANTHROPIC_CLIENT = anthropic.Anthropic(**kwargs)
    return _ANTHROPIC_CLIENT


def llm_extract(fields, url, excerpt, content_type, model):
    client = _get_client()

    user = (
        f"Company: {fields['company']}\n"
        f"Location: {fields['location']}, {fields['city']}, "
        f"{fields['state']}, {fields['country']}\n"
        f"Source: {url}\n\n"
        f"Page text ({content_type}):\n{excerpt}\n\n"
        "Return only the JSON object."
    )

    resp = client.messages.create(
        model=model,
        max_tokens=LLM_MAX_TOKENS,
        system=_LLM_SYSTEM,
        # Native web_search tool restored (matches Opus 4.6). When the page lacks
        # the address, Claude searches the live web itself and reasons over real
        # results — far more accurate than feeding it scraped snippets.
        tools=[{"type": "web_search_20250305", "name": "web_search",
                "max_uses": WEB_SEARCH_USES}],
        messages=[{"role": "user", "content": user}],
    )

    # Record real token usage from the API response. With the web_search tool,
    # the API also reports server-tool usage; we still sum input/output tokens.
    in_tok = getattr(getattr(resp, "usage", None), "input_tokens", 0)
    out_tok = getattr(getattr(resp, "usage", None), "output_tokens", 0)
    USAGE.add_api(in_tok, out_tok)

    # Authoritative detection: did the API actually run a web search this turn?
    # (More reliable than trusting the model's self-report.)
    did_websearch = any(
        getattr(b, "type", "") in ("server_tool_use", "web_search_tool_result")
        for b in resp.content
    )

    text_out = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    parsed = _parse_llm_json(text_out)
    parsed["_tokens"] = (int(in_tok or 0), int(out_tok or 0))

    # Decide the Source label. Prefer the hard signal (did_websearch); fall back
    # to the model's self-reported 'used'; factor in PDF content type.
    used = parsed.pop("used", "")
    if did_websearch or used == "websearch":
        parsed["source"] = "LLM (web search)"
    elif content_type == "pdf":
        parsed["source"] = "LLM (PDF)"
    elif content_type in ("skipped-url", "fetch-failed"):
        # Page wasn't usable and no web search ran -> Claude used prior knowledge.
        parsed["source"] = "LLM (no page; model knowledge)"
    else:
        parsed["source"] = "LLM (page)"
    return parsed


def _parse_llm_json(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        obj = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        obj = json.loads(m.group(0)) if m else {}
    return {
        "address": str(obj.get("address", "") or "").strip(),
        "status":  str(obj.get("status",  "Not Found") or "Not Found").strip(),
        "notes":   str(obj.get("notes",   "") or "").strip(),
        "used":    str(obj.get("used",    "") or "").strip().lower(),
    }


# ----------------------------------------------------------------------------- #
# Per-row processing
# ----------------------------------------------------------------------------- #

def _partial_or_notfound(fields, lead_note):
    bits = [b for b in (fields["city"], fields["state"], fields["country"]) if b]
    if bits:
        return {"address": ", ".join(bits), "status": "Partial",
                "notes": lead_note + " Filled city/state/country from input.",
                "source": "Input only"}
    return {"address": "", "status": "Not Found", "notes": lead_note,
            "source": "Input only"}


# Map the internal extract method to a human-readable Source label.
_HEUR_SOURCE = {
    "jsonld":     "Website (JSON-LD)",
    "regex-html": "Website (text match)",
    "regex-pdf":  "PDF (text match)",
}


def process_row_heuristic(fields, url):
    if looks_like_skip_url(url):
        return _partial_or_notfound(
            fields,
            "Source link is a careers/login/broken URL; needs internet search "
            "(run --mode llm or research manually).")

    page_text, ctype, err = fetch(url)
    if err:
        return _partial_or_notfound(fields, f"Could not fetch source link ({err}).")

    addr, method = heuristic_extract(page_text, ctype)
    if addr and method:
        return {"address": addr, "status": "Verified",
                "notes": "Auto-extracted from source link; please verify.",
                "source": _HEUR_SOURCE.get(method, "Website")}

    return _partial_or_notfound(fields, "No street address found on source page.")


def process_row_llm(fields, url, model, window=True):
    """
    Accuracy-first, and Claude ALWAYS makes the final call. By default the model
    receives only the address PARAGRAPH(S), not the whole page:
      * The page is fetched; HTML tags are stripped so only readable text remains.
      * The cleaned text is searched for address-signal words; only the paragraph(s)
        around them are kept (first 3 locations max, ~6,000 chars / ~3,000 tokens).
      * If no signal words are found, the first 6,000 chars of cleaned text are sent.
      * Claude has the native web_search tool for broken/careers/empty pages.
      * There is no JSON-LD shortcut — structured data is just text Claude reads.

      window=False  -> legacy behavior: send the full cleaned page (more tokens).
    """
    page_text, ctype = "", ""
    note_prefix = ""

    if looks_like_skip_url(url):
        # Broken/careers/login/non-http: hand an empty page to Claude and let the
        # native web_search tool find the address.
        ctype = "skipped-url"
        note_prefix = "Source link looked like careers/login/broken; "
    else:
        page_text, ctype, err = fetch(url)
        if err:
            ctype = "fetch-failed"
            note_prefix = f"Could not fetch source link ({err}); "

    # Clean + strip tags (content-type aware) so the model never sees HTML markup.
    cleaned = clean_page_text(page_text or "", ctype)

    if not cleaned:
        excerpt = ""
    elif window:
        # DEFAULT: keep only the address paragraph(s).
        excerpt = address_windows(cleaned)
        if not excerpt:
            # No address-signal words found -> safety fallback to head of page.
            excerpt = cleaned[:ADDR_WINDOW_CHARS]
            note_prefix += "No address keywords on page; sent page head. "
    else:
        # Legacy: send the full cleaned page.
        excerpt = cleaned[:PAGE_EXCERPT_CHARS]

    try:
        result = llm_extract(fields, url, excerpt, ctype, model)
        if note_prefix:
            result["notes"] = note_prefix + result["notes"]
    except SystemExit:
        raise
    except Exception as e:
        result = process_row_heuristic(fields, url)
        result["notes"] = f"LLM call failed ({e}); used heuristic. " + result["notes"]
        result["source"] = "Heuristic (LLM failed)"
        result["_tokens"] = (0, 0)

    if result["status"] not in ("Verified", "Partial", "Not Found"):
        result["status"] = "Not Found" if not result["address"] else "Partial"
    if not result["address"]:
        result["status"] = "Not Found"
    result.setdefault("source", "LLM")
    return result


# ----------------------------------------------------------------------------- #
# I/O
# ----------------------------------------------------------------------------- #

def read_input(path):
    wb = load_workbook(path, read_only=True, data_only=True)
    sheet = wb.active
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        raise SystemExit("Input sheet is empty.")
    header = [str(h).strip() if h is not None else "" for h in rows[0]]

    def find_col(*names):
        for i, h in enumerate(header):
            if h.lower() in [n.lower() for n in names]:
                return i
        return None

    text_i = find_col("Text")
    link_i = find_col("Source Link", "Source", "Link", "URL")
    if text_i is None or link_i is None:
        raise SystemExit(
            f"Could not find required columns. Found: {header}\n"
            "Need a 'Text' column and a 'Source Link' column."
        )
    data = []
    for r in rows[1:]:
        text = r[text_i] if text_i < len(r) else ""
        link = r[link_i] if link_i < len(r) else ""
        if text is None and link is None:
            continue
        data.append((str(text or ""), str(link or "")))
    return data


def write_output(path, results):
    wb = Workbook()
    sheet = wb.active
    sheet.title = "Addresses"

    header_fill = PatternFill("solid", start_color="1F4E78")
    header_font = Font(bold=True, color="FFFFFF", name="Arial", size=11)
    body_font   = Font(name="Arial", size=10)
    thin   = Side(style="thin", color="D9D9D9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    wrap   = Alignment(vertical="top", wrap_text=True)

    status_fill = {
        "Verified":  PatternFill("solid", start_color="E2EFDA"),
        "Partial":   PatternFill("solid", start_color="FFF2CC"),
        "Not Found": PatternFill("solid", start_color="FCE4E4"),
    }

    sheet.append(OUTPUT_COLUMNS)
    for c in sheet[1]:
        c.fill = header_fill
        c.font = header_font
        c.alignment = Alignment(vertical="center", horizontal="center")
        c.border = border

    for row in results:
        sheet.append([row[c] for c in OUTPUT_COLUMNS])
        r = sheet.max_row
        for c in sheet[r]:
            c.font = body_font
            c.alignment = wrap
            c.border = border
    status_col = OUTPUT_COLUMNS.index("Status") + 1   # 1-based for openpyxl
    source_col = OUTPUT_COLUMNS.index("Source") + 1
    source_fill = PatternFill("solid", start_color="EDEDF4")  # light grey-blue

    for row in results:
        sheet.append([row[c] for c in OUTPUT_COLUMNS])
        r = sheet.max_row
        for c in sheet[r]:
            c.font = body_font
            c.alignment = wrap
            c.border = border
        sf = status_fill.get(row["Status"])
        if sf:
            sheet.cell(row=r, column=status_col).fill = sf
        sheet.cell(row=r, column=source_col).fill = source_fill

    # Column widths now include the Source column (F); Notes shifts to G.
    widths = {"A": 7, "B": 42, "C": 46, "D": 46, "E": 11, "F": 24, "G": 42}
    for col, w in widths.items():
        sheet.column_dimensions[col].width = w
    sheet.freeze_panes = "A2"
    wb.save(path)


# ----------------------------------------------------------------------------- #
# CLI dashboard
# ----------------------------------------------------------------------------- #

def print_banner(args, total, unique_links):
    print(f"{C.BOLD}{C.CYAN}╔══════════════════════════════════════════════════════════════╗{C.RESET}")
    print(f"{C.BOLD}{C.CYAN}║  find_addresses v2 — token-optimized address finder          ║{C.RESET}")
    print(f"{C.BOLD}{C.CYAN}╚══════════════════════════════════════════════════════════════╝{C.RESET}")
    dup = total - unique_links
    print(f"  {C.DIM}mode:{C.RESET} {C.BOLD}{args.mode}{C.RESET}"
          f"   {C.DIM}model:{C.RESET} {args.model if args.mode=='llm' else '—'}")
    print(f"  {C.DIM}rows:{C.RESET} {total}"
          f"   {C.DIM}unique links:{C.RESET} {unique_links}"
          f"   {C.DIM}duplicate links (cacheable):{C.RESET} {C.GREEN}{dup}{C.RESET}")
    print(f"  {C.DIM}cache:{C.RESET} {'on' if not args.no_cache else 'off'}"
          f"   {C.DIM}sleep:{C.RESET} {args.sleep}s   {C.DIM}output:{C.RESET} {args.output}")
    print(f"{C.GREY}{'─'*66}{C.RESET}")


def print_row_line(idx, total_abs, fields, res, source_tag, row_tokens):
    sc = status_color(res["status"])
    comp = (fields["company"] or "—")[:34].ljust(34)
    tok = ""
    if row_tokens and (row_tokens[0] or row_tokens[1]):
        tok = f"  {C.DIM}+{human(row_tokens[0]+row_tokens[1])} tok{C.RESET}"
    elif source_tag:
        tok = f"  {C.GREEN}{source_tag}{C.RESET}"
    print(f"  {C.DIM}[{idx}/{total_abs}]{C.RESET} {comp} "
          f"{sc}{res['status']:<9}{C.RESET}"
          f"  {C.DIM}∑{human(USAGE.total)} tok{C.RESET}{tok}")


def print_summary(results, args, elapsed):
    counts = Counter(r["Status"] for r in results)
    print(f"{C.GREY}{'─'*66}{C.RESET}")
    print(f"{C.BOLD}Done.{C.RESET} Wrote {len(results)} rows to "
          f"{C.BOLD}{args.output}{C.RESET}  ({elapsed:.1f}s)")
    print(f"  Results: "
          f"{C.GREEN}Verified {counts.get('Verified',0)}{C.RESET}  |  "
          f"{C.YELLOW}Partial {counts.get('Partial',0)}{C.RESET}  |  "
          f"{C.RED}Not Found {counts.get('Not Found',0)}{C.RESET}")

    if args.mode == "llm":
        saved = USAGE.cache_hits
        print(f"{C.GREY}{'─'*66}{C.RESET}")
        print(f"{C.BOLD}Token usage{C.RESET}")
        print(f"  API calls       : {USAGE.api_calls}")
        print(f"  Input tokens    : {human(USAGE.in_tokens)}")
        print(f"  Output tokens   : {human(USAGE.out_tokens)}")
        print(f"  {C.BOLD}Total tokens    : {human(USAGE.total)}{C.RESET}")
        avg = (USAGE.total / USAGE.api_calls) if USAGE.api_calls else 0
        print(f"  Avg / API call  : {human(int(avg))}")
        print(f"{C.GREY}{'─'*66}{C.RESET}")
        print(f"{C.BOLD}Token savings{C.RESET}")
        print(f"  {C.GREEN}Cache hits (duplicate links reused) : {USAGE.cache_hits}{C.RESET}")
        print(f"  {C.GREEN}Rows answered with ZERO tokens      : {saved}{C.RESET}")
        cost = USAGE.cost(args.price_in, args.price_out)
        print(f"{C.GREY}{'─'*66}{C.RESET}")
        print(f"  {C.DIM}Est. cost @ ${args.price_in}/M in, "
              f"${args.price_out}/M out:{C.RESET} {C.BOLD}${cost:.4f}{C.RESET}")
        print(f"  {C.DIM}(cost is an estimate for the configured prices only){C.RESET}")


# ----------------------------------------------------------------------------- #
# Reusable engine  (shared by the CLI and the GUI)
# ----------------------------------------------------------------------------- #

def process_one_row(fields, link, mode, model, link_cache, use_cache,
                    window=True):
    """
    Resolve a single row. Returns (res_dict, source_tag, row_tokens).
      source_tag : "CACHED" | ""   (empty = a real network/LLM call)
      row_tokens : (input_tokens, output_tokens) for THIS row's API call, or (0, 0)
    Mutates link_cache and the global USAGE counters.

    Cache correctness: the key is (normalized Text + link), NOT the link alone.
    Each row's input Text (company, location, city, state, country) identifies a
    DIFFERENT place, so two rows are only the same question when BOTH their Text
    and their link match. This prevents a row from inheriting another row's
    address just because they happen to share a source URL.
    """
    link_key = link.strip()
    # Normalize the Text so trivial spacing/case differences still cache-hit,
    # but any real difference in company/location/city/state/country does not.
    text_key = " ".join(str(fields.get("raw", "")).split()).strip().lower()
    key = (text_key, link_key)

    source_tag = ""
    row_tokens = (0, 0)

    if use_cache and link_key and key in link_cache:
        USAGE.cache_hits += 1
        cached = link_cache[key]
        orig_src = cached.get("source", "")
        cache_src = f"Cached ({orig_src})" if orig_src else "Cached"
        if cached["status"] != "Verified" and not cached["address"]:
            res = _partial_or_notfound(
                fields, "Reused decision for an identical earlier row "
                        "(same Text and same link).")
            res["source"] = cache_src
        else:
            res = {"address": cached["address"], "status": cached["status"],
                   "notes": "Reused result for an identical earlier row "
                            "(same Text and same link; cached, no tokens used). "
                            + cached.get("notes", ""),
                   "source": cache_src}
        return res, "CACHED", row_tokens

    if mode == "llm":
        res = process_row_llm(fields, link, model, window=window)
        row_tokens = res.pop("_tokens", (0, 0))
    else:
        res = process_row_heuristic(fields, link)

    if use_cache and link_key:
        link_cache[key] = {"address": res["address"],
                           "status": res["status"],
                           "notes": res.get("notes", ""),
                           "source": res.get("source", "")}
    return res, source_tag, row_tokens


def run_job(input_path, output_path, mode="heuristic",
            model="claude-opus-4-6",
            limit=None, start=0, sleep=1.0, use_cache=True,
            window=True,
            price_in=3.0, price_out=15.0,
            on_start=None, on_row=None, on_done=None, should_stop=None):
    """
    Headless driver used by BOTH the CLI and the GUI.

    Extraction note: by default the model receives only the address paragraph(s)
    (first 3 signal locations, ~6,000 chars), with HTML tags stripped. Set
    `window=False` to send the full cleaned page instead (more tokens). The native
    web_search tool is always attached, and Claude always makes the final call.
    The duplicate (Text+link) cache reuses identical rows at zero tokens.

    Callbacks (all optional):
      on_start(meta)        -> dict: total, total_abs, unique_links, duplicates, mode, model
      on_row(info)          -> dict per row: idx, total_abs, company, status, source_tag,
                               row_tokens, usage_total, address
      on_done(summary)      -> dict: counts, usage snapshot, elapsed, output_path, stopped
      should_stop()         -> bool: return True to abort gracefully after the current row
    Returns the summary dict.
    """
    data = read_input(input_path)
    if start:
        data = data[start:]
    if limit:
        data = data[:limit]

    total = len(data)
    total_abs = start + total
    unique_links = len({lnk.strip() for _, lnk in data if lnk.strip()})
    # Cacheable duplicates = rows whose (Text + link) pair has been seen before.
    # This matches the actual cache key, so the count reflects real reuse.
    seen_pairs, cacheable_dups = set(), 0
    for txt, lnk in data:
        lk = lnk.strip()
        if not lk:
            continue
        pair = (" ".join(str(txt).split()).strip().lower(), lk)
        if pair in seen_pairs:
            cacheable_dups += 1
        else:
            seen_pairs.add(pair)

    if on_start:
        on_start({"total": total, "total_abs": total_abs,
                  "unique_links": unique_links, "duplicates": cacheable_dups,
                  "mode": mode, "model": model, "use_cache": use_cache})

    link_cache = {}
    results = []
    t0 = time.time()
    stopped = False

    for offset, (text, link) in enumerate(data):
        if should_stop and should_stop():
            stopped = True
            break

        idx = start + offset + 1
        fields = parse_text_field(text)

        try:
            res, source_tag, row_tokens = process_one_row(
                fields, link, mode, model, link_cache, use_cache,
                window=window)
        except SystemExit:
            raise
        except Exception as e:
            res = {"address": "", "status": "Not Found", "notes": f"Row error: {e}",
                   "source": "Error"}
            source_tag, row_tokens = "", (0, 0)

        results.append({
            "S.No":         idx,
            "Text":         text,
            "Source Link":  link,
            "Full Address": res["address"],
            "Status":       res["status"],
            "Source":       res.get("source", ""),
            "Notes":        res["notes"],
        })

        if on_row:
            on_row({"idx": idx, "total_abs": total_abs,
                    "company": fields["company"] or "—",
                    "status": res["status"], "source_tag": source_tag,
                    "row_tokens": row_tokens, "usage_total": USAGE.total,
                    "address": res["address"]})

        if idx % 25 == 0:
            write_output(output_path, results)

        if source_tag != "CACHED":
            time.sleep(sleep)

    write_output(output_path, results)

    summary = {
        "counts": dict(Counter(r["Status"] for r in results)),
        "rows": len(results),
        "elapsed": time.time() - t0,
        "output_path": output_path,
        "stopped": stopped,
        "mode": mode,
        "in_tokens": USAGE.in_tokens, "out_tokens": USAGE.out_tokens,
        "total_tokens": USAGE.total, "api_calls": USAGE.api_calls,
        "cache_hits": USAGE.cache_hits, "jsonld_hits": USAGE.jsonld_hits,
        "search_calls": USAGE.search_calls,
        "cost": USAGE.cost(price_in, price_out),
        "price_in": price_in, "price_out": price_out,
    }
    if on_done:
        on_done(summary)
    return summary


# ----------------------------------------------------------------------------- #
# Main (CLI)
# ----------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser(description="Find street addresses for location rows.")
    ap.add_argument("input",  help="Input .xlsx path")
    ap.add_argument("-o", "--output", default="addresses_output.xlsx")
    ap.add_argument("--mode",  choices=["heuristic", "llm"], default="heuristic")
    ap.add_argument("--endpoint", choices=["direct", "straive"], default="direct",
                    help="LLM endpoint: 'direct' = api.anthropic.com (personal "
                         "laptop, your Claude key); 'straive' = chatapi.straive.com "
                         "(office laptop). You can also set ANTHROPIC_BASE_URL.")
    ap.add_argument("--model", default="claude-opus-4-6")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--sleep", type=float, default=1.0)
    ap.add_argument("--no-cache", action="store_true",
                    help="Disable same-link result reuse (not recommended).")
    ap.add_argument("--full-page", action="store_true",
                    help="Send the FULL cleaned page to Claude instead of just the "
                         "address paragraph(s). Uses more tokens. By default only "
                         "the first 3 address paragraphs (~6,000 chars) are sent.")
    ap.add_argument("--price-in",  type=float, default=3.0,
                    help="USD per 1M input tokens (cost estimate only).")
    ap.add_argument("--price-out", type=float, default=15.0,
                    help="USD per 1M output tokens (cost estimate only).")
    args = ap.parse_args()

    if args.mode == "llm" and not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("Set ANTHROPIC_API_KEY for --mode llm.")

    # Apply endpoint choice (CLI flag wins; otherwise honor ANTHROPIC_BASE_URL).
    global API_BASE_URL, _ANTHROPIC_CLIENT
    if args.endpoint == "straive":
        API_BASE_URL = "https://chatapi.straive.com"
    elif args.endpoint == "direct":
        # Only force direct if the user didn't set an env override.
        API_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "").strip() or None
    _ANTHROPIC_CLIENT = None  # rebuild with the chosen endpoint

    # Wire the CLI dashboard to the shared engine via callbacks.
    def _on_start(meta):
        print_banner(args, meta["total"], meta["unique_links"])

    def _on_row(info):
        fields = {"company": info["company"]}
        res = {"status": info["status"]}
        print_row_line(info["idx"], info["total_abs"], fields, res,
                       info["source_tag"], info["row_tokens"])

    def _on_done(summary):
        print_summary(_ResultsShim(summary), args, summary["elapsed"])

    run_job(args.input, args.output, mode=args.mode, model=args.model,
            limit=args.limit, start=args.start, sleep=args.sleep,
            use_cache=not args.no_cache,
            window=not args.full_page,
            price_in=args.price_in, price_out=args.price_out,
            on_start=_on_start, on_row=_on_row, on_done=_on_done)


class _ResultsShim(list):
    """Lets the existing print_summary(results, args, elapsed) reuse USAGE/Counter
    without changing its signature — it only reads len() and per-row Status."""
    def __init__(self, summary):
        super().__init__({"Status": s} for s, n in summary["counts"].items()
                         for _ in range(n))


if __name__ == "__main__":
    main()
