# ClemToken Highlighter

Helps making your ClemToken grammar more readable.

Highlighting is driven by the actual ClemToken parser instead of regular expressions, so nested
groups, glued suffixes and escapes are coloured by what the grammar says they are rather than by a
best-effort pattern. Rule definitions and references also feed Go to Definition, Find References,
the outline and anchor completion.

## Engine

A small self-contained ClemToken engine ships inside the extension and runs once per edit to turn
the document into tokens. Separate builds are published for Windows and for Linux, so only the one
you need is downloaded.

If highlighting does not appear, the `ClemToken` output channel says why. Setting
`clemtoken.enginePath` points the extension at a different engine binary, which is handy while
working on the engine itself.

## Building

The engine is NativeAOT, which cannot cross-compile, so each build has to happen on the platform it
targets. Check out [ClemToken](https://github.com/ClemCa/ClemToken) next to this repository, install
the Linux toolchain once (only needed on Windows, where the Linux build runs inside WSL2), and then:

```
bash scripts/setup-wsl.sh                      # once, from inside WSL2

node scripts/publish.mjs --package             # every VSIX this machine can build
node scripts/publish.mjs                       # stage, then publish each target (needs VSCE_PAT)
node scripts/publish.mjs --target linux-x64    # one target only
```

`stage-engine.mjs` is the lower-level step, for when you just want an engine to run the extension
from source:

```
node scripts/stage-engine.mjs                  # this machine's platform
node scripts/stage-engine.mjs --target linux-x64
```

Staging a platform clears any other out of `bin/`, and `publish.mjs` stages each target immediately
before packaging it, so a VSIX always carries its own engine. Doing that by hand in the wrong order
produces a Windows package containing the Linux binary, which nothing downstream rejects.

A VSIX packaged on Windows loses the POSIX executable bit, which the extension restores on first
use, so the Linux build does not need a Linux build host either.

The Linux binary runs on any glibc 2.34 or newer distro and deliberately does not need `libicu` -
see `InvariantGlobalization` in the engine's `ClemToken.csproj` - so it starts even on minimal
installs that never pulled it in.
