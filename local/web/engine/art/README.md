# Original puffle menu artwork

These two files reproduce the original blue puffle portrait from the pinned
Club Penguin media archive. They are not newly drawn or AI-generated artwork.
The upstream `vanilla-media` submodule is unchanged.

| Input / output | Value |
| --- | --- |
| Source | `vanilla-media/media/play/v2/content/global/puffle/icons/blue.swf` |
| Source SHA256 | `5071c7a73abdecff0d331d508f34394688260f58dd8e4b6ad2fbddc2fb33e1bc` |
| Source selection | DefineSprite 13, frame 1 |
| Exporter | JPEXS 26.4.0, using the archive and library checksums in `local/client-bridge/build.py` |
| SVG | `puffle-blue.svg`, 91.45 × 79.6 with an equivalent responsive viewBox |
| SVG SHA256 | `e128e4fc0eab5e64851691a3eb4ba9f69adbbbab51dd24c30423cfc85c3edb9c` |
| PNG | `puffle-blue.png`, 366 × 319, 8-bit RGBA, transparent background, 4× export |
| PNG SHA256 | `56faf4bf3508ffb4a34a59020ab85adb19de4ab943c271935084e3cc47695519` |

From the repository root, reproduce both checked-in files with:

```sh
python3 local/client-bridge/export-menu-art.py
```

Python 3.9+ and Java are required. The script uses Homebrew OpenJDK when available;
`BRIDGE_JAVA_HOME` selects another Java installation. It reuses or downloads the
same checksum-pinned official JPEXS archive as the bridge compiler, then extracts
it into an isolated ignored build directory. It checks the source SWF before
exporting and refuses a different exporter version until reviewed.

The exporter commands select only the portrait sprite:

```sh
java -Djava.awt.headless=true -Duser.home=BUILD_DIR -jar FFDEC_DIR/ffdec.jar \
  -format sprite:svg -selectid 13 -select 13:1 -zoom 1 -ignorebackground \
  -export sprite SVG_DIR SOURCE_SWF
java -Djava.awt.headless=true -Duser.home=BUILD_DIR -jar FFDEC_DIR/ffdec.jar \
  -format sprite:png -selectid 13 -select 13:1 -zoom 4 -ignorebackground \
  -export sprite PNG_DIR SOURCE_SWF
```

The SVG receives only a `viewBox="0 0 91.45 79.6"` addition; the exported vector
paths are unchanged. The reproducer rejects scripts, embedded raster images,
event handlers, and external references. The PNG is exported directly from the
same original sprite for the native AVM1 menu's image loader. Exporting the SWF's
main timeline would crop this centered sprite, so it must not replace sprite 13.

The artwork remains original Club Penguin / Disney material, with the same
provenance as the rest of the archived game media.
