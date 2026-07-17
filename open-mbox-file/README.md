# MBOX Viewer — files-online.com/open-mbox-file/

A browser-based viewer, search tool, editor, and exporter for `.mbox` email
archives. Part of [Files Online](https://files-online.com). No backend, no
framework, no build step — plain HTML, modern CSS, and vanilla JavaScript ES
modules.

## How to run

The tool is deployed at <https://files-online.com/open-mbox-file/>.

To run locally, serve the **repository root** over HTTP (the page uses
absolute `/assets/...` paths, ES modules, and a module Web Worker):

```sh
cd filesonline
python3 -m http.server 8000
# open http://localhost:8000/open-mbox-file/
```

**`file://` restriction:** opening `index.html` directly from disk does not
work in most browsers — ES modules and Web Workers are blocked by CORS rules
for `file://` origins. Use any static HTTP server as shown above.

Tests: open `/open-mbox-file/tests.html` for the in-browser test runner
(separator detection, `>From` escaping, folded headers, MIME boundaries,
base64/quoted-printable, charsets, attachments, threading, search filters,
export round-trip, malformed messages).

## Browser compatibility

- **Chrome / Edge / Firefox / Safari (current versions):** fully supported.
  Module workers require Firefox ≥ 114, Safari ≥ 15.
- IndexedDB persistence and `navigator.storage.estimate()` degrade
  gracefully when unavailable (e.g. some private-browsing modes).
- Attachment/reading-window previews need popups allowed for the site.

## Privacy model

**Your email archive stays in your browser and is not uploaded.** Parsing,
search, editing, and every export run locally. There is no server, no
analytics, no tracking, and email content is never logged to the console.

- HTML messages are sanitized with DOMPurify and rendered in an `<iframe
  sandbox="">` — scripts, forms, downloads, and popups are blocked.
- Remote images/styles (including tracking pixels) are **blocked by
  default**; a per-message "Load remote content" button restores them after a
  warning, since loading remote content contacts third-party servers.
- `javascript:` and other unsafe URLs are stripped; temporary object URLs are
  revoked when you switch messages.
- Optional persistence writes to the browser's IndexedDB **only after you
  explicitly click "Save locally"** (Settings ⚙). Stored data (messages, read
  state, stars, labels, notes, edits, preferences) is specific to this device
  and browser and can be deleted from the same dialog.

The only network requests the tool makes are lazy CDN loads of two libraries
(DOMPurify for sanitization, zip.js for ZIP export) — never your data.

## Supported MBOX and MIME features

- Standard Unix mbox plus the `mboxo` and `mboxrd` variants; files without an
  extension; multiple archives at once; drag & drop.
- Separator detection on `From ` lines (start-of-file or after a blank line),
  so unescaped `From` sentences inside bodies don't split messages; `>From `
  escaped body lines are unescaped on import and re-escaped on export.
- Headers: folded and repeated headers, RFC 2047 encoded words, RFC 2231
  parameter continuations, address lists, Status/X-Status flags,
  X-Gmail-Labels, custom headers, raw header view.
- MIME: `text/plain`, `text/html`, `multipart/alternative|mixed|related`,
  nested multiparts, base64, quoted-printable, common charsets (via
  `TextDecoder`), inline images by Content-ID, attachments (lazily decoded).
- Threads: grouped by Message-ID / In-Reply-To / References with normalized
  subject fallback — best-effort, since mbox metadata is often incomplete.
- Search: full-text over subject/addresses/body/headers/attachment names/
  labels/notes with `from:` `to:` `cc:` `subject:` `label:` `after:` `before:`
  `has:attachment` `is:read|unread|starred`, `"exact phrases"`, `-negation`.

## How exports work

- **Unedited messages are exported byte-for-byte** from their original raw
  source (`.eml`, ZIP of .eml, `.mbox`).
- **Edited messages are reconstructed**: edited headers/body replace the
  original MIME structure as a simple `text/plain` or `text/html` message
  marked with `X-FO-Edited: true`. Original attachments are not re-attached
  to reconstructed messages; revert the edit to recover the untouched
  original at any time (the source file on disk is never modified).
- MBOX export writes standard separators, escapes body lines beginning with
  `From ` (mboxrd style), and uses consistent line endings.
- CSV export columns: Date, From, To, Cc, Subject, Message-ID, attachment
  count and filenames, read/starred state, labels, source archive.
- PDF export uses the browser's print dialog on a sanitized reading window.

## Why edited messages may lose signature validity

DKIM, S/MIME, and PGP signatures are computed over the exact original bytes
of a message (headers and body). Any modification — even a single character —
changes those bytes, so a reconstructed message can no longer validate
against the original signature. The viewer therefore never claims signature
preservation for edited messages, marks them in the UI, and warns on export.

## Known limitations

- The whole archive's text is held in memory; multi-GB archives depend on
  device RAM (parsing itself is chunked and off-thread).
- Address parsing and signature/quote detection in plain text are heuristics.
- The rich-text HTML editing mode is basic (contentEditable on sanitized
  markup); source mode is authoritative.
- Thread grouping is best-effort; drafts/deleted detection depends on
  Status/X-Mozilla headers being present.
- A "static searchable HTML archive" export is provided as a combined HTML
  document without embedded search.

## Architecture

```
open-mbox-file/index.html     page shell (three-pane app + SEO sections)
open-mbox-file/tests.html     browser test runner
assets/css/mbox-viewer.css    tool styles on shared design tokens
assets/js/mbox/app.js         UI + state glue (entry point)
assets/js/mbox/mbox-parser.js separator detection, From-escaping, mbox writer
assets/js/mbox/mime-parser.js headers, MIME tree, encodings, normalized model
assets/js/mbox/worker.js      module worker: chunked parsing with progress
assets/js/mbox/search.js      query parser + matching
assets/js/mbox/threads.js     conversation grouping
assets/js/mbox/storage.js     IndexedDB persistence (opt-in)
assets/js/mbox/export.js      eml/mbox/csv/json/zip/html exports
assets/js/mbox/demo.js        generated demo archive (no real emails)
assets/js/mbox/tests.js       test suite
```

Parsing logic is UI-independent and shared between the worker and the test
page.
