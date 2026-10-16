# ClemToken Highlighter

Helps making your ClemToken grammar more readable.

Highlighting is driven by the actual ClemToken parser instead of regular expressions, so nested
groups, glued suffixes and escapes are coloured by what the grammar says they are rather than by a
best-effort pattern. Rule definitions and references also feed Go to Definition, Find References,
the outline and anchor completion.

## Engine

A small self-contained ClemToken engine ships inside the extension and runs once per edit to turn
the document into tokens. The extension is published as a single package carrying a build per
supported platform, and runs whichever one matches the platform it finds itself on.

Windows and Linux on x64 are the platforms built today. macOS is not supported.

If highlighting does not appear, the `ClemToken` output channel says why. Setting
`clemtoken.enginePath` points the extension at a different engine binary, which is handy while
working on the engine itself.

## Building

The engine is NativeAOT, which cannot cross-compile, so each build has to happen on the platform it
targets. Check out [ClemToken](https://github.com/ClemCa/ClemToken) next to this repository, install
the Linux toolchain once (only needed on Windows, where the Linux build runs inside WSL2), and then:

```
bash scripts/setup-wsl.sh                      # once, from inside WSL2

node scripts/publish.mjs --package             # one package with every engine this machine can build
node scripts/publish.mjs                       # stage, then publish (needs VSCE_PAT)
```

`stage-engine.mjs` is the lower-level step, for when you just want an engine to run the extension
from source. Staged platforms accumulate instead of replacing each other, so building a second one
does not disturb the first:

```
node scripts/stage-engine.mjs                  # this machine's platform
node scripts/stage-engine.mjs --target linux-x64
```

`publish.mjs` stages every engine this host can build and then packages them together, so there is no
pairing to get wrong: one package cannot end up carrying an engine meant for a different platform.

A package built on Windows loses the POSIX executable bit, which the extension restores on first
use, so the Linux build does not need a Linux build host either.

The Linux binary runs on any glibc 2.34 or newer distro and deliberately does not need `libicu` -
see `InvariantGlobalization` in the engine's `ClemToken.csproj` - so it starts even on minimal
installs that never pulled it in.
