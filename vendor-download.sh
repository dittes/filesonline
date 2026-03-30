#!/usr/bin/env bash
# Downloads vendor libraries for local/offline hosting.
# Run from project root: bash vendor-download.sh
#
# After running, update import URLs in:
#   assets/js/archives.js   (zip.js, libarchive.js)
#   assets/js/preview.js    (PDF.js, SheetJS, Mammoth)
#   assets/js/export.js     (zip.js)

set -e
VENDOR="assets/vendor"

echo "Downloading vendor libraries for Files Online..."
echo ""

# zip.js (ESM + IIFE builds)
echo "→ zip.js @2.7.52"
mkdir -p "$VENDOR/zip"
curl -sLf "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.52/dist/zip.min.js" \
  -o "$VENDOR/zip/zip.min.js" && echo "  ✓ zip.min.js"

# PDF.js
echo "→ PDF.js @4.4.168"
mkdir -p "$VENDOR/pdfjs"
curl -sLf "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs" \
  -o "$VENDOR/pdfjs/pdf.min.mjs" && echo "  ✓ pdf.min.mjs"
curl -sLf "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs" \
  -o "$VENDOR/pdfjs/pdf.worker.min.mjs" && echo "  ✓ pdf.worker.min.mjs"

# SheetJS
echo "→ SheetJS (xlsx) @0.18.5"
mkdir -p "$VENDOR/sheetjs"
curl -sLf "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js" \
  -o "$VENDOR/sheetjs/xlsx.full.min.js" && echo "  ✓ xlsx.full.min.js"

# Mammoth.js
echo "→ Mammoth.js @1.6.0"
mkdir -p "$VENDOR/mammoth"
curl -sLf "https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js" \
  -o "$VENDOR/mammoth/mammoth.browser.min.js" && echo "  ✓ mammoth.browser.min.js"

# libarchive.js (RAR/7z/tar extraction via WebAssembly)
echo "→ libarchive.js @1.3.0"
mkdir -p "$VENDOR/libarchive"
curl -sLf "https://cdn.jsdelivr.net/npm/libarchive.js@1.3.0/dist/libarchive.js" \
  -o "$VENDOR/libarchive/libarchive.js" && echo "  ✓ libarchive.js"
# The WASM file needs to be served from the same path as libarchive.js
curl -sLf "https://cdn.jsdelivr.net/npm/libarchive.js@1.3.0/dist/wasm-gen/libarchive.wasm" \
  -o "$VENDOR/libarchive/libarchive.wasm" 2>/dev/null \
  && echo "  ✓ libarchive.wasm" \
  || echo "  ⚠ libarchive.wasm not found at CDN path — check npm package for correct path"

echo ""
echo "Done. All vendor files saved to: $VENDOR/"
echo ""
echo "Next steps:"
echo "  1. In assets/js/archives.js, replace CDN URLs with /assets/vendor/zip/zip.min.js"
echo "     and /assets/vendor/libarchive/libarchive.js"
echo "  2. In assets/js/preview.js, replace CDN URLs with local vendor paths"
echo "  3. In assets/js/export.js, replace CDN URLs with /assets/vendor/zip/zip.min.js"
