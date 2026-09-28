# Third-party notices

Materialize 3D is MIT licensed (see `LICENSE`). It ships the third-party material below, each under its own license. The app bundle carries this file, `LICENSE`, and the AGPL-3.0 text in `Contents/Resources`.

## Fonts

The app interface uses DM Sans, Instrument Serif, and JetBrains Mono. Sign lettering uses Lato. All four are licensed under the SIL Open Font License, Version 1.1, reproduced once at the end of this file. Each family's own license file sits next to its font files.

| Font | Files | Copyright |
|---|---|---|
| DM Sans | `src/assets/fonts/DMSans-*.ttf` | Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts) |
| Instrument Serif | `src/assets/fonts/InstrumentSerif-Italic.ttf` | Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif) |
| JetBrains Mono | `src/assets/fonts/JetBrainsMono-*.ttf` | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| Lato | `src-tauri/resources/fonts/Lato-*.ttf` | Copyright (c) 2010-2014 by tyPoland Lukasz Dziedzic (team@latofonts.com) with Reserved Font Name "Lato" |

## Bambu Studio print settings

`src-tauri/resources/bambu/p2s-0.4-pla-basic-x3.project_settings.json` is embedded in every sign package. It was exported by Bambu Studio 02.08.02.61 from its bundled Bambu Lab system profiles (profile bundle 02.08.00.05); `src-tauri/resources/bambu/README.md` records how. Bambu Studio is licensed under the GNU Affero General Public License v3.0, and its source, including those profiles, is at https://github.com/bambulab/BambuStudio/tree/v02.08.02.61. This settings file is distributed under the same license; the full text is in `src-tauri/resources/bambu/AGPL-3.0.txt`.

Materialize 3D does not include or redistribute Bambu Studio itself. It runs a copy that you install from Bambu Lab.

## Bambu Lab CA certificate

`src-tauri/certs/bambu-ca.pem` is the public root certificate that Bambu Lab printers present (`CN=BBL CA`, `O=BBL Technologies Co., Ltd`). The app embeds it to verify TLS connections to a printer.

## Software dependencies

The app is built from open source Rust crates and JavaScript packages, each under its own license. `src-tauri/Cargo.lock` and `bun.lock` pin the exact versions.

## SIL Open Font License, Version 1.1

```text
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
