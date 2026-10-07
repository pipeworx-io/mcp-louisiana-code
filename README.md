# @pipeworx/louisiana-code

Louisiana law by citation — Revised Statutes, Civil Code, Code of Civil
Procedure, Code of Criminal Procedure, Code of Evidence, Children's Code and
the Louisiana Constitution — with each section's enactment and amendment
history parsed out, plus full-text topic search across those code bodies and
a browse of every section in one Revised Statutes title. Keyless, sourced
live from the Louisiana State Legislature.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1704+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `louisiana_statute(citation | doc_id)` — full text of one section:
  `"RS 14:20"`, `"La. R.S. 9:2800.1"`, `"14:20"`, `"CC 2315"`,
  `"La. C.C. art. 2315"`, `"CCP 966"`, `"C.Cr.P. art. 701"`, `"CE 404"`,
  `"CHC 603"`, `"Const. Art. I, §5"` / `"CONST 1:5"`, or the legis.la.gov
  `doc_id` a search result carries. Returns `heading`, `hierarchy` (the
  chapter/title lines above the section), `text`, the trailing `history`
  line ("Added by Acts 1976, No. 655, §1. Amended by Acts 2014, No. 163,
  §1.") parsed into `amendments` (`{year, act, session}`), and
  `last_amended_year`.
- `louisiana_law_search(query, bodies?, limit?)` — full-text search by
  topic/keyword ("vehicular homicide", "security deposit lessor",
  "comparative fault"), optionally narrowed to code bodies (`RS`, `CC`,
  `CCP`, `CCRP`, `CE`, `CHC`, `CONST`, `CA`, `HRULE`, `SRULE`, `JRULE`;
  default all). Relevance-ranked rows with citation, heading, last-modified
  date and `doc_id`, plus the source's `total`.
- `louisiana_title_contents(title, filter?, offset?, limit?)` — every
  section of one Revised Statutes title with its heading and `doc_id`
  (Title 14 has 729, Title 32 has 870), optionally filtered by a word in the
  heading; repealed sections are flagged.

## Auth

Keyless.

## Data sources

- <https://legis.la.gov/Legis/Law.aspx?d=78338> — one section page (that id
  is RS 14:20). Citation in `#ctl00_PageBody_LabelName`, text as `<P>`
  paragraphs in `#ctl00_PageBody_LabelDocument`, last paragraph = history.
- <https://legis.la.gov/Legis/LawSearch.aspx> — the "View a Specific Law"
  form and the text-search form.
- <https://legis.la.gov/Legis/LawSearchList.aspx> — where the search form
  cross-page-posts; renders the result rows.
- <https://legis.la.gov/Legis/Laws_Toc.aspx?folder=75&level=Parent> — the
  Revised Statutes table of contents (one LinkButton postback per title).

### Shape of this source, because it is a WebForms site and not an API

Everything is reachable with plain HTTP — no cookie, no JavaScript, no
CAPTCHA, no Lexis hop — but three of the four routes are form POSTs:

1. **Doc ids are not in citation order.** `d=78337` is RS 14:2, `d=78338`
   is RS 14:20, `d=78339` is RS 14:201 (string-sorted). So a citation
   cannot be computed into a URL; the "View a Specific Law" form does the
   mapping. POST the form's hidden `__VIEWSTATE`/`__EVENTVALIDATION` fields
   plus `ddlLawBodies`, `tbFirstNumber`, `tbSecondNumber` and
   `btnViewLaw=View`; the server answers **302 to `Law.aspx?d=<id>`**. An
   unknown citation re-renders the form with HTTP 200 and no redirect —
   that is the not-found signal (there is no message).
2. **Non-RS bodies need the dropdown's own postback first.** Selecting Civil
   Code etc. is a `__doPostBack('...ddlLawBodies')` that switches the form
   to a single "Article" box; posting the article number against the fresh
   RS-state form is silently ignored. The pack runs that switch once per
   body and caches the resulting hidden fields.
3. **The viewstate is not session-bound.** One GET of the form supplies
   fields that stay valid for repeated POSTs (verified: two different
   citations resolved off the same fields, no cookie ever set). The pack
   caches them per isolate for 30 minutes and refreshes once on a POST that
   comes back without a redirect, so a warm citation lookup is one POST +
   one GET.
4. **Search posts to `LawSearchList.aspx`, not back to the form** (the
   button's `WebForm_PostBackOptions` names it). The per-body checkboxes
   are `cbLaws$0`..`cbLaws$10` (0 CHC, 1 CC, 2 CCP, 3 CCRP, 4 CE, 5 CA,
   6 CONST, 7 HRULE, 8 JRULE, 9 RS, 10 SRULE); **`cbLaws$11` "Select All"
   is client-side JavaScript only** — the server ignores it, so "all
   bodies" means ticking all ten. A single-hit search 302s straight to the
   section page. The list renders the first 100 of N, relevance-sorted,
   and states N ("There are 347 sections of law in this list").
5. **A one-word query that matches too many sections is refused silently**:
   `"tax"` against RS 302s back to the blank form, byte-identical to a fresh
   GET. The pack reports that as `search_rejected` with a hint to add a
   word. The engine ANDs every word; `a or b`, `a not b` and `""exact
   phrase""` (doubled quotes) are its own syntax.
6. **Pages hard-wrap paragraphs with raw newlines.** The history paragraph
   of RS 14:30 spans nine source lines. Split on `<P>` tags, never on
   newlines, or the history line fragments and only its first piece reads
   as history.
7. **Form field names contain `$`.** `URLSearchParams` encodes it as `%24`,
   which is what IIS expects; a body that leaves `$` literal gets the form
   re-rendered with HTTP 200 and nothing else.

### The four capabilities, and the one the source cannot do

| Capability | Status | How |
|---|---|---|
| Topic search | yes | `louisiana_law_search` (the legislature's own full-text engine) |
| Section by citation | yes | `louisiana_statute` (form POST → 302 → section page) |
| Amendment / enactment history | yes | trailing history paragraph, parsed into `amendments` |
| Historical point-in-time version | **no** | legis.la.gov serves the current compiled text only; every section response says so in `historical_version` |

`laws_current_through` on every response is the legislature's own
"updated through the …" line (e.g. "2025 First Extraordinary Session"),
read from the search form.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "louisiana-code": {
      "url": "https://gateway.pipeworx.io/louisiana-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/louisiana-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1704+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/louisiana_statute \
  -H 'Content-Type: application/json' \
  -d '{"citation":"RS 14:20"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/louisiana_statute`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "louisiana-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-louisiana-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-louisiana-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Louisiana Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
