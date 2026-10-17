# ClemToken Highlighter

Helps making your ClemToken grammar more readable.

The DSL's grammar is defined in its own syntax in source.

## Build

```bash
npm install
npm run compile            # type-check, then bundle to dist/
npm run release:package    # stage every engine, then produce the .vsix
```

`bin/` already holds the built engines (`win32-x64`, `linux-x64`) and the grammar they compiled,
so compiling, packaging and running from source need nothing else.

Rebuilding an engine is only necessary when the engine's source changes, and that source is a
separate checkout that this repository does not contain. Stage it with:

```bash
npm run stage-engine -- --engine ../ClemToken
```

Without `--engine` the script looks for a sibling `../ClemToken`; for a checkout anywhere else,
either pass the flag or edit `ENGINE_DEFAULT` at the top of `scripts/stage-engine.mjs`.

NativeAOT cannot cross-compile, so each target is built on a machine of that kind: the Linux engine
is built from Windows through WSL2, after running `bash scripts/setup-wsl.sh` once inside WSL.

`npm run release` does the same staging and then publishes to the Marketplace (needs `VSCE_PAT`).
