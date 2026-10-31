#!/usr/bin/env python3
# Builds test files for the inspector's less common formats, written byte by byte from each
# format's specification. These prove the parsers read what the spec says; real files from
# real tools are the better test where the machine can produce them (see make_fixtures.sh).
import json, os, struct, zlib, io, zipfile
OUT = os.path.join(os.path.dirname(__file__), 'fixtures')
def w(name, data):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode())

# Images
w('t.qoi', b'qoif' + struct.pack('>II', 640, 480) + bytes([4, 0]) + b'\0' * 16)
w('t.dds', b'DDS ' + struct.pack('<IIIIIII', 124, 0x1007, 300, 400, 0, 0, 5) + b'\0' * 44 + struct.pack('<II', 32, 4) + b'DXT5' + b'\0' * 40)
w('t.exr', struct.pack('<I', 20000630) + bytes([2, 0, 0, 0]) + b'displayWindow\0box2i\0' + struct.pack('<iiiii', 16, 0, 0, 1919, 1079) + b'compression\0compression\0' + struct.pack('<i', 1) + bytes([3]) + b'\0' + b'\0' * 8)
w('t.xcf', b'gimp xcf v011\0' + struct.pack('>III', 800, 600, 0) + b'\0' * 32)
w('t.pcx', bytes([10, 5, 1, 8]) + struct.pack('<HHHH', 0, 0, 99, 49) + b'\0' * 53 + bytes([3]) + b'\0' * 60)
w('t.hdr', b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 720 +X 1280\n' + b'\0' * 16)
w('t.icns', b'icns' + struct.pack('>I', 8 + 8 + 16) + b'ic07' + struct.pack('>I', 16) + b'\0' * 8 + b'ic08' + struct.pack('>I', 8))
w('t.jp2', b'\0\0\0\x0cjP  \r\n\x87\n' + b'\0\0\0\x14ftypjp2 \0\0\0\0jp2 ' + b'\0\0\0\x2djp2h' + b'\0\0\0\x16ihdr' + struct.pack('>IIHBBBB', 300, 500, 3, 7, 7, 0, 0) + b'\0' * 16)
w('t.fits', b''.join(f'{c:<80}'.encode() for c in ['SIMPLE  =                    T', 'BITPIX  =                   16', 'NAXIS   =                    2', 'NAXIS1  =                  100', 'NAXIS2  =                  200', "OBJECT  = 'M31     '", "TELESCOP= 'Hubble  '", 'END']) + b' ' * 2240)
w('t.emf', struct.pack('<IIiiiiiiii', 1, 108, 0, 0, 10, 10, 0, 0, 2100, 2970) + b' EMF' + struct.pack('<IIIHHIII', 0x10000, 100, 7, 1, 0, 11, 92, 0) + b'\0' * 20 + 'Report\0Tool'.encode('utf-16le'))
w('t.dng', b'II*\0' + struct.pack('<I', 8) + struct.pack('<H', 3) + struct.pack('<HHII', 0x100, 4, 1, 6000) + struct.pack('<HHII', 0x101, 4, 1, 4000) + struct.pack('<HHI', 0x10f, 2, 5) + struct.pack('<I', 50) + struct.pack('<I', 0) + b'\0' * 6 + b'Acme\0')

# Audio
w('t.au', b'.snd' + struct.pack('>IIIII', 32, 16000, 3, 8000, 1) + b'hello\0\0\0' + b'\0' * 16000)
w('t.ac3', bytes([0x0b, 0x77, 0, 0, 0x08 << 1 & 0x3f, 0x40, 0x40]) + b'\0' * 32)
w('t.amr', b'#!AMR\n' + b'\0' * 32)
w('t.caf', b'caff' + struct.pack('>HH', 1, 0) + b'desc' + struct.pack('>q', 32) + struct.pack('>d', 44100.0) + b'lpcm' + struct.pack('>IIIII', 0, 4, 1, 2, 16) + b'data' + struct.pack('>q', 0))
w('t.xm', b'Extended Module: ' + b'Space Theme'.ljust(20, b'\0') + bytes([0x1a]) + b'\0' * 64)
w('t.s3m', b'Cave Song'.ljust(28, b'\0') + b'\x1a\x10\0\0' + b'\0' * 12 + b'SCRM' + b'\0' * 32)
w('t.sid', b'PSID' + struct.pack('>HHHHHHH', 2, 124, 0, 0, 0, 3, 1) + b'\0' * 4 + b'Commando'.ljust(32, b'\0') + b'Rob Hubbard'.ljust(32, b'\0') + b'1985'.ljust(32, b'\0'))
w('t.dsf', b'DSD ' + struct.pack('<QQQ', 28, 1000, 0) + b'fmt ' + struct.pack('<QIIIIIIQI', 52, 1, 0, 2, 2, 2822400, 1, 2822400 * 60, 4096) + b'\0' * 8)

# Video
def box(t, b): return struct.pack('>I', 8 + len(b)) + t + b
tkhd = bytes(4) + bytes(72) + struct.pack('>II', 1920 << 16, 1080 << 16)
mdhd = bytes(4) + bytes(16) + struct.pack('>H', ((ord('d') - 96) << 10) | ((ord('e') - 96) << 5) | (ord('u') - 96)) + bytes(2)
vtrak = box(b'trak', box(b'tkhd', tkhd) + box(b'mdia', box(b'mdhd', mdhd) + box(b'hdlr', bytes(8) + b'vide' + bytes(12)) + box(b'minf', box(b'stbl', box(b'stsd', bytes(8) + struct.pack('>I', 86) + b'avc1' + bytes(70))))))
atrak = box(b'trak', box(b'tkhd', bytes(84)) + box(b'mdia', box(b'hdlr', bytes(8) + b'soun' + bytes(12)) + box(b'minf', box(b'stbl', box(b'stsd', bytes(8) + struct.pack('>I', 36) + b'mp4a' + bytes(16) + struct.pack('>HH', 2, 16) + bytes(4) + struct.pack('>I', 48000 << 16))))))
mvhd = bytes(4) + struct.pack('>II', 3786912000, 3786912060) + struct.pack('>II', 1000, 5000) + bytes(80)
w('t.tracks.mp4', box(b'ftyp', b'isom\0\0\0\0isom') + box(b'moov', box(b'mvhd', mvhd) + vtrak + atrak))
def el(i, b):
    n = len(b)
    return bytes.fromhex(i) + bytes([0x40 | (n >> 8), n & 255]) + b
tr1 = el('AE', el('83', b'\x01') + el('86', b'V_VP9') + el('E0', el('B0', b'\x05\0') + el('BA', b'\x02\xd0')))
tr2 = el('AE', el('83', b'\x02') + el('86', b'A_OPUS') + el('22B59C', b'pol') + el('E1', el('B5', struct.pack('>f', 48000.0)) + el('9F', b'\x02')))
info = el('1549A966', el('2AD7B1', b'\x0f\x42\x40') + el('4489', struct.pack('>d', 90500.0)) + el('7BA9', b'Holiday') + el('4D80', b'libebml') + el('5741', b'mkvmerge'))
seg = info + el('1654AE6B', tr1 + tr2)
w('t.tracks.mkv', el('1A45DFA3', el('4282', b'matroska')) + bytes.fromhex('18538067') + bytes([0x40 | (len(seg) >> 8), len(seg) & 255]) + seg)
w('t.ivf', b'DKIF' + struct.pack('<HH', 0, 32) + b'AV01' + struct.pack('<HHIII', 640, 360, 30, 1, 900) + b'\0' * 4)
w('t.y4m', b'YUV4MPEG2 W320 H240 F25:1 Ip A1:1 C420\nFRAME\n')
w('t.swf', b'FWS' + bytes([10]) + struct.pack('<I', 100) + bytes([0x78, 0x00, 0x05, 0xdc, 0x00, 0x00, 0x96, 0x00, 0x00]) + bytes([0, 24]) + struct.pack('<H', 120) + b'\0' * 8)

# Archives and disks
vhd = bytearray(512); vhd[0:8] = b'conectix'; vhd[28:32] = b'qemu'; vhd[48:56] = struct.pack('>Q', 2 ** 30); vhd[60:64] = struct.pack('>I', 2)
w('t.vhd', bytes(4096) + bytes(vhd))
w('t.qcow2', b'QFI\xfb' + struct.pack('>I', 3) + bytes(16) + struct.pack('>Q', 10 * 2 ** 30) + bytes(32))
w('t.wim', b'MSWIM\0\0\0' + struct.pack('<IIIII', 208, 0x10d00, 0, 32768, 1) + bytes(16) + struct.pack('<HHI', 1, 1, 3) + bytes(100))
w('t.squashfs', b'hsqs' + struct.pack('<IIIIHHHHHH', 1200, 0, 131072, 10, 4, 17, 0, 0, 4, 0) + bytes(64))
w('t.lz4', bytes([0x04, 0x22, 0x4d, 0x18]) + bytes(16))
w('t.Z', bytes([0x1f, 0x9d, 0x90]) + bytes(16))
w('t.pack', b'PACK' + struct.pack('>II', 2, 1234) + bytes(32))

# Data
pcap = struct.pack('<IHHiIII', 0xa1b2c3d4, 2, 4, 0, 0, 65535, 1)
for i in range(3): pcap += struct.pack('<IIII', 1700000000 + i, 0, 4, 4) + b'abcd'
w('t.pcap', pcap)
shb = struct.pack('<II', 0x0a0d0d0a, 28) + struct.pack('<IHHq', 0x1a2b3c4d, 1, 0, -1) + struct.pack('<I', 28)
idb = struct.pack('<IIHHII', 1, 20, 1, 0, 65535, 20)
epb = struct.pack('<IIIIIII', 6, 32, 0, 0, 0, 0, 0) + struct.pack('<I', 32)
w('t.pcapng', shb + idb + epb + epb)
def zz(n): return bytes([n * 2]) if n < 64 else bytes([(n * 2 & 127) | 128, n * 2 >> 7])
schema = json.dumps({'type': 'record', 'name': 'User', 'fields': [{'name': 'id', 'type': 'long'}, {'name': 'mail', 'type': 'string'}]}).encode()
w('t.avro', b'Obj\x01' + zz(2) + zz(10) + b'avro.codec' + zz(7) + b'deflate' + zz(11) + b'avro.schema' + zz(len(schema)) + schema + b'\0' + bytes(16))
w('t.nc', b'CDF\x01' + struct.pack('>I', 12) + bytes(16))
w('t.h5', b'\x89HDF\r\n\x1a\n\0' + bytes(32))
w('t.mat', b'MATLAB 5.0 MAT-file, Platform: MACI64, Created on: Fri Oct 30 2026'.ljust(116) + bytes(12))
w('t.accdb', b'\0\x01\0\0Standard ACE DB\0' + bytes([2]) + bytes(64))
shp = struct.pack('>7i', 9994, 0, 0, 0, 0, 0, 100) + struct.pack('<ii', 1000, 5) + struct.pack('<4d', 13.0, 52.0, 14.0, 53.0) + bytes(32)
for i in range(2): shp += struct.pack('>ii', i + 1, 2) + bytes(4)
w('t.shp', shp)
las = bytearray(375); las[0:4] = b'LASF'; las[24] = 1; las[25] = 2; las[58:58 + 8] = b'lastools'; las[107:111] = struct.pack('<I', 987654)
w('t.las', bytes(las))

# CAD, 3D, AI
w('t.fbx', b'Kaydara FBX Binary  \0\x1a\0' + struct.pack('<I', 7400) + bytes(32))
w('t.blend', b'BLENDER-v403' + bytes(32))
kv = b''
def s(x): return struct.pack('<Q', len(x)) + x.encode()
kv += s('general.architecture') + struct.pack('<I', 8) + s('llama') + s('general.name') + struct.pack('<I', 8) + s('Tiny Model') + s('general.file_type') + struct.pack('<II', 4, 15)
w('t.gguf', b'GGUF' + struct.pack('<IQQ', 3, 291, 3) + kv)
meta = json.dumps({'__metadata__': {'format': 'pt'}, 'wte.weight': {'dtype': 'F32', 'shape': [50257, 768], 'data_offsets': [0, 4]}}).encode()
w('t.safetensors', struct.pack('<Q', len(meta)) + meta + bytes(4))
w('t.step', "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\nFILE_NAME('bracket','2026-10-30T10:00:00',('a'),('b'),'c','d','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=DIRECTION('',(0.,0.,1.));\nENDSEC;\nEND-ISO-10303-21;\n")
w('t.dxf', '  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1027\n  0\nENDSEC\n  0\nSECTION\n  2\nTABLES\n  0\nLAYER\n  2\nWalls\n  0\nLAYER\n  2\nDoors\n  0\nENDSEC\n  0\nEOF\n')
b = io.BytesIO()
with zipfile.ZipFile(b, 'w') as z:
    z.writestr('3D/3dmodel.model', '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>')
w('t.3mf', b.getvalue())

# Containers
b = io.BytesIO()
with zipfile.ZipFile(b, 'w') as z:
    z.writestr('FixedDocumentSequence.fdseq', '<x/>')
    z.writestr('Documents/1/Pages/1.fpage', '<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06"><Glyphs UnicodeString="Hello from XPS"/></FixedPage>')
    z.writestr('docProps/core.xml', '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Spec</dc:title></cp:coreProperties>')
w('t.xps', b.getvalue())
b = io.BytesIO()
with zipfile.ZipFile(b, 'w') as z:
    z.writestr('visio/document.xml', '<VisioDocument/>')
    z.writestr('visio/pages/page1.xml', '<PageContents/>')
    z.writestr('[Content_Types].xml', '<Types/>')
w('t.vsdx', b.getvalue())
b = io.BytesIO()
with zipfile.ZipFile(b, 'w') as z:
    z.writestr('Index/Document.iwa', b'\0')
    z.writestr('preview.jpg', b'')
w('t.pages', b.getvalue())
b = io.BytesIO()
with zipfile.ZipFile(b, 'w') as z:
    z.writestr('demo-1.0.dist-info/METADATA', 'Name: demo\nVersion: 1.0\nSummary: A demo\nAuthor: Ada\n')
w('t.whl', b.getvalue())
b = io.BytesIO()
with zipfile.ZipFile(b, 'w') as z:
    z.writestr('AndroidManifest.xml', b'\x03\0')
    z.writestr('classes.dex', b'dex\n035\0')
    z.writestr('lib/arm64-v8a/libx.so', b'\x7fELF')
w('t.apk', b.getvalue())

# Security and system
w('t.jks', struct.pack('>III', 0xfeedfeed, 2, 3) + bytes(32))
w('t.kdbx', bytes.fromhex('03d9a29a67fb4bb5') + struct.pack('<HH', 1, 4) + bytes(32))
w('t.pub', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAbCdEf ada@example.com\n')
w('t.asc', '-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: Ada\n\nabc\n-----END PGP PUBLIC KEY BLOCK-----\n')
lnk = bytearray(76); lnk[0:4] = struct.pack('<I', 76); lnk[4:20] = bytes.fromhex('0114020000000000c000000000000046')
lnk[20:24] = struct.pack('<I', 0x2 | 0x4 | 0x80); lnk[52:56] = struct.pack('<I', 4096)
lnk[28:36] = struct.pack('<Q', 133000000000000000)
base = b'C:\\Windows\\notepad.exe\0'
info2 = struct.pack('<IIIIIII', 28 + len(base), 28, 1, 0, 28, 0, 0) + base
desc = 'Notepad'
w('t.lnk', bytes(lnk) + info2 + struct.pack('<H', len(desc)) + desc.encode('utf-16le'))
def ben(v):
    if isinstance(v, int): return b'i%de' % v
    if isinstance(v, str): v = v.encode()
    if isinstance(v, bytes): return b'%d:' % len(v) + v
    if isinstance(v, list): return b'l' + b''.join(map(ben, v)) + b'e'
    return b'd' + b''.join(ben(k) + ben(v[k]) for k in sorted(v)) + b'e'
w('t.torrent', ben({'announce': 'http://tracker.example/a', 'created by': 'mktorrent', 'creation date': 1700000000, 'info': {'name': 'ubuntu', 'piece length': 262144, 'files': [{'length': 1000, 'path': ['a', 'b.iso']}, {'length': 2000, 'path': ['c.txt']}]}}))
w('t.dvi', bytes([0xf7, 2]) + struct.pack('>III', 25400000, 473628672, 1000) + bytes([11]) + b' TeX output' + bytes(16))
w('t.wad', b'IWAD' + struct.pack('<II', 7, 12) + bytes(32))

# Text
w('t.patch', 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1,2 @@\n-old\n+new\n+more\n')
w('t.log', '2026-10-30 10:00:01 INFO started\n2026-10-30 10:00:02 ERROR boom\n2026-10-30 10:05:00 WARN slow\n')
w('t.bib', '@article{a, title={First Paper}, year=2020}\n@book{b, title={Second Book}}\n@article{c, title={Third}}\n')
w('t.ass', '[Script Info]\nTitle: Episode 1\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\\Nworld\n')
w('t.lrc', '[ti:Song][ar:Band]\n[ti:Song]\n[ar:Band]\n[00:01.00]First line\n[00:02.00]Second line\n')
w('t.m3u8', '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nseg1.ts\n#EXTINF:10,\nseg2.ts\n')
w('t.ged', '0 HEAD\n1 SOUR Test\n0 @I1@ INDI\n1 NAME Ada /Lovelace/\n0 @I2@ INDI\n0 @F1@ FAM\n0 TRLR\n')
w('t.sql', 'CREATE TABLE users (id int);\nCREATE TABLE IF NOT EXISTS orders (id int);\nINSERT INTO users VALUES (1);\n')
w('t.gpx', '<?xml version="1.0"?><gpx version="1.1" creator="Garmin" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Morning Run</name></metadata><trk><trkseg><trkpt lat="52" lon="13"/><trkpt lat="52.1" lon="13.1"/></trkseg></trk></gpx>')
w('t.kml', '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Places</name><Placemark/><Placemark/></Document></kml>')
w('t.plist', '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Demo</string><key>Enabled</key><true/></dict></plist>')
w('t.xlf', '<?xml version="1.0"?><xliff version="1.2"><file source-language="en" target-language="de"><body><trans-unit id="1"><source>Hi</source></trans-unit></body></file></xliff>')
w('sitemap.xml', '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.example/</loc></url></urlset>')
w('pom.xml', '<?xml version="1.0"?><project xmlns="http://maven.apache.org/POM/4.0.0"><groupId>org.x</groupId><artifactId>demo</artifactId><version>2.1</version><dependencies><dependency/></dependencies></project>')
w('t.har', json.dumps({'log': {'version': '1.2', 'creator': {'name': 'Chrome', 'version': '130'}, 'entries': [{'request': {'url': 'https://a.example/x'}}, {'request': {'url': 'https://a.example/y'}}]}}))
w('package.json', json.dumps({'name': 'demo', 'version': '1.2.3', 'description': 'A demo', 'dependencies': {'a': '1'}}))
w('openapi.json', json.dumps({'openapi': '3.0.0', 'info': {'title': 'Pets', 'version': '1'}, 'paths': {'/a': {}, '/b': {}}}))
w('deploy', '#!/usr/bin/env python3\nprint("hi")\n')

# Parsers that read fields
dpx = bytearray(2048); dpx[0:4] = b'SDPX'; dpx[8:12] = b'V2.0'; dpx[136:146] = b'2026:10:30'; dpx[160:168] = b'Resolve\0'; dpx[772:776] = struct.pack('>I', 2048); dpx[776:780] = struct.pack('>I', 1080)
w('t.dpx', bytes(dpx))
w('t.wmf', bytes.fromhex('d7cdc69a') + struct.pack('<HhhhhHIH', 0, 0, 0, 1440, 720, 1440, 0, 0) + bytes(32))
w('t.xbm', '#define logo_width 16\n#define logo_height 8\nstatic char logo_bits[] = {0};\n')
w('t.xpm', '/* XPM */\nstatic char *a[] = {\n"32 24 4 1",\n};\n')
w('t.djvu', b'AT&TFORM' + struct.pack('>I', 30) + b'DJVU' + b'INFO' + struct.pack('>I', 10) + struct.pack('>HHBB', 800, 600, 26, 0) + struct.pack('<H', 300) + bytes(4))
w('t.raf', b'FUJIFILMCCD-RAW 0201FF129502' + b'X-T5'.ljust(32, b'\0') + bytes(32))
w('t.cr3', b'\0\0\0\x18ftypcrx \0\0\0\1crx isom' + bytes(32))
w('t.jxl', bytes([0xff, 0x0a]) + bytes(32))
mod = bytearray(1200); mod[0:6] = b'Axel F'; mod[1080:1084] = b'M.K.'
w('t.mod', bytes(mod))
w('t.it', b'IMPM' + b'Deep Song'.ljust(26, b'\0') + bytes(32))
w('t.tta', b'TTA1' + struct.pack('<HHHII', 1, 2, 16, 44100, 44100 * 90) + bytes(16))
w('t.ape', b'MAC ' + bytes(32)); w('t.wv', b'wvpk' + bytes(32)); w('t.mpc', b'MPCK' + bytes(32)); w('t.rm', b'.RMF' + bytes(32)); w('t.mxf', bytes.fromhex('060e2b34') + bytes(32)); w('t.bpg', bytes.fromhex('425047fb') + bytes(32))
w('t.lz', b'LZIP\x01' + bytes(32)); w('t.lzma', bytes([0x5d, 0, 0, 0x80, 0]) + bytes(32)); w('t.arj', bytes.fromhex('60ea') + bytes(32)); w('t.lzh', b'\x20\x00-lh5-' + bytes(32)); w('t.zoo', b'ZOO 2.10 Archive.\x1a' + bytes(32)); w('t.ace', bytes(7) + b'**ACE**' + bytes(32)); w('t.sit', b'StuffIt (c)1997' + bytes(32))
vdi = bytearray(512); vdi[0:39] = b'<<< Oracle VM VirtualBox Disk Image >>>'; vdi[64:68] = struct.pack('<I', 0xbeda107f); vdi[76:80] = struct.pack('<I', 1); vdi[84:90] = b'Ubuntu'; vdi[368:376] = struct.pack('<Q', 2 ** 32)
w('t.vdi', bytes(vdi))
w('t.vmdk', b'KDMV' + struct.pack('<IIQ', 1, 3, 2097152) + bytes(32))
sav = bytearray(256); sav[0:4] = b'$FL2'; sav[4:20] = b'@(#) SPSS DATA F'; sav[80:84] = struct.pack('<i', 250); sav[92:101] = b'30 Oct 26'; sav[101:109] = b'10:00:00'; sav[109:115] = b'Survey'
w('t.sav', bytes(sav))
w('t.orc', b'ORC' + bytes(32)); w('t.arrow', b'ARROW1\0\0' + bytes(32)); w('t.cbor', bytes.fromhex('d9d9f7') + bytes(32)); w('t.3ds', b'MM' + bytes(32)); w('t.e57', b'ASTM-E57' + bytes(32)); w('t.tflite', bytes(4) + b'TFL3' + bytes(32)); w('t.igs', 'Test S      1\n' + ' ' * 32)
w('t.obj', '# cube\no Cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
w('t.ply', 'ply\nformat ascii 1.0\ncomment made by hand\nelement vertex 8\nproperty float x\nelement face 6\nend_header\n')
reg = bytearray(4096); reg[0:4] = b'regf'; reg[12:20] = struct.pack('<Q', 133000000000000000); reg[20:24] = struct.pack('<I', 1); reg[24:28] = struct.pack('<I', 5); reg[48:60] = 'SYSTEM'.encode('utf-16le')
w('t.dat', bytes(reg))
evtx = bytearray(4096); evtx[0:8] = b'ElfFile\0'; evtx[24:32] = struct.pack('<Q', 42); evtx[36:38] = struct.pack('<H', 1); evtx[38:40] = struct.pack('<H', 3)
w('t.evtx', bytes(evtx))
w('t.chm', b'ITSF' + struct.pack('<IIIII', 3, 96, 1, 0, 0x407) + bytes(32) + b'Help text inside this file\0')
w('t.one', bytes.fromhex('e4525c7b8cd8a74daeb15378d02996d3') + bytes(32)); w('t.pst', b'!BDN' + bytes(32))
w('t.wpd', bytes.fromhex('ff575043') + struct.pack('<I', 16) + bytes([1, 10, 2, 1]) + bytes(16) + b'Some WordPerfect text here\0')
w('t.nes', b'NES\x1a' + bytes([2, 1]) + bytes(32)); w('t.luac', b'\x1bLua\x53' + bytes(32) + b'print_message_function\0')
def u16s(x):
    b = x.encode('utf-16le'); return struct.pack('<H', len(b)) + b
eot = bytearray(80); eot[34:36] = b'LP'
w('t.eot', bytes(eot) + b'\0\0' + u16s('Lobster') + b'\0\0' + u16s('Regular') + b'\0\0' + u16s('Version 1.0') + b'\0\0' + u16s('Lobster Regular') + bytes(16))
w('t.pfb', '%!PS-AdobeFont-1.0: Utopia\n/FontName /Utopia-Regular def\n/FullName (Utopia Regular) def\n/FamilyName (Utopia) def\n/Notice (Copyright Adobe) def\n')
