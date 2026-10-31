#!/bin/sh
# Real files from real tools, on macOS. Run from the repository root. They complement the
# byte-level fixtures from make_fixtures.py with what actual software writes.
cd tests/fixtures || exit 1
TMP=$(mktemp -d)
printf 'Real file produced by a real tool.\n' > "$TMP/a.txt"
sips -s format jp2 sample.png --out real.jp2 >/dev/null 2>&1
sips -s format icns -z 256 256 sample.png --out real.icns >/dev/null 2>&1
sips -s format pict sample.png --out real.pict >/dev/null 2>&1
sips -s format sgi sample.png --out real.sgi >/dev/null 2>&1
sips -s format exr sample.png --out real.exr >/dev/null 2>&1
afconvert -f caff -d LEI16 sample.wav real.caf >/dev/null 2>&1
afconvert -f adts -d aac sample.wav real.aac >/dev/null 2>&1
afconvert -f AIFF -d BEI16 sample.wav real.aiff >/dev/null 2>&1
afconvert -f NeXT -d BEI16 sample.wav real.au >/dev/null 2>&1
compress -c "$TMP/a.txt" > real.Z 2>/dev/null
bzip2 -c "$TMP/a.txt" > real.bz2
plutil -create binary1 real.bplist 2>/dev/null; plutil -insert name -string demo real.bplist 2>/dev/null
plutil -create xml1 real.plist 2>/dev/null; plutil -insert name -string demo real.plist 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP/k.pem" -out real-cert.pem -days 3650 -subj "/CN=Real Test/O=Files Online" >/dev/null 2>&1
openssl x509 -in real-cert.pem -outform der -out real-cert.der >/dev/null 2>&1
openssl pkcs12 -export -inkey "$TMP/k.pem" -in real-cert.pem -out real.p12 -passout pass:test >/dev/null 2>&1
ssh-keygen -q -t ed25519 -N '' -C test@example.com -f "$TMP/id" >/dev/null 2>&1 && cp "$TMP/id.pub" real.pub
hdiutil create -size 1m -fs HFS+ -volname Test -ov "$TMP/d.dmg" >/dev/null 2>&1 && cp "$TMP/d.dmg" real.dmg
mkdir "$TMP/src" && cp "$TMP/a.txt" "$TMP/src/" && hdiutil create -srcfolder "$TMP/src" -volname Test -format UDZO -ov "$TMP/e.dmg" >/dev/null 2>&1 && cp "$TMP/e.dmg" real-compressed.dmg
xar -cf real.xar -C "$TMP" a.txt 2>/dev/null
textutil -convert webarchive -output real.webarchive "$TMP/a.txt" 2>/dev/null
rm -rf "$TMP"
