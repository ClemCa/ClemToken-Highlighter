// Stages the NativeAOT engine into ./bin, which is where the extension looks for it.
//
//   node scripts/stage-engine.mjs                     # this machine's platform
//   node scripts/stage-engine.mjs --target linux-x64  # built inside WSL2
//   node scripts/stage-engine.mjs --engine <ClemToken checkout>
//
// Without --engine it looks for ../ClemToken, a sibling checkout. That folder is not part of this
// repo and usually is not there; if your checkout lives elsewhere, either pass --engine or edit
// ENGINE_DEFAULT below, which is the only place the default is written.
//
// NativeAOT cannot cross-compile ("Cross-OS native compilation is not supported"), so a target that
// is not this machine needs a machine of that kind. On Windows that machine is WSL2, which runs a
// real Linux kernel; scripts/setup-wsl.sh installs the toolchain it needs. The shipped grammar is
// compiled with the freshly built engine, so the binary and dsl.cta can never drift apart.
//
// Platforms accumulate in ./bin instead of replacing each other: the extension ships as one
// universal package holding every engine this host can build, and picks its own folder at runtime.
// Staging nothing but your own platform therefore cannot silently ship the wrong engine.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const HOST = `${process.platform}-${process.arch}`;
const target = flag('target', HOST);

// The engine source is its own checkout and is not part of this repo; bin/ holds the prebuilt
// engines, so this default only has to be right when something actually needs rebuilding. Edit the
// folder name here if your checkout does not sit next to this one, or pass --engine per run.
const ENGINE_DEFAULT = join('..', 'ClemToken');
const engineArg = flag('engine');
const engineRepo = resolve(engineArg ?? ENGINE_DEFAULT);

// folder name -> RID. Add an entry here to support another platform; Windows and macOS can only be
// built on a machine of that kind (macOS would also need an ad-hoc codesign step, since Gatekeeper
// refuses to launch an unsigned arm64 binary).
const RIDS = {
  'win32-x64': 'win-x64',
  'win32-arm64': 'win-arm64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};

const rid = RIDS[target];
if (rid === undefined) {
  console.error(`Unsupported target "${target}". Known: ${Object.keys(RIDS).join(', ')}.`);
  process.exit(1);
}

const project = join(engineRepo, 'ClemToken.csproj');
if (!existsSync(project)) {
  console.error(`No ClemToken.csproj under ${engineRepo}.`);
  if (engineArg === undefined) {
    console.error(
      `That is the default engine folder, "${ENGINE_DEFAULT}", which is relative to this repo and did not\n` +
      `exist. The engine's source lives in a separate checkout; this repo only carries the engines it\n` +
      `already built, in bin/. If your checkout is somewhere else, pass --engine <path>, or edit\n` +
      `ENGINE_DEFAULT at the top of scripts/stage-engine.mjs so the default points at it.`,
    );
  } else {
    console.error(
      `Pass a checkout that contains ClemToken.csproj, or edit ENGINE_DEFAULT at the top of\n` +
      `scripts/stage-engine.mjs.`,
    );
  }
  process.exit(1);
}

rmSync(join('bin', '.staging'), { recursive: true, force: true });
mkdirSync('bin', { recursive: true });

if (target === HOST) {
  stageNatively();
} else if (process.platform === 'win32' && target.startsWith('linux-')) {
  stageInWsl();
} else {
  console.error(`Building ${target} needs a ${target} machine - NativeAOT cannot cross-compile.`);
  process.exit(1);
}

/** Build on this machine and compile the grammar with the binary that just came out of it. */
function stageNatively() {
  const binary = process.platform === 'win32' ? 'ClemToken.exe' : 'ClemToken';
  const staging = join('bin', '.staging');
  mkdirSync(staging, { recursive: true });

  console.log(`Publishing NativeAOT engine (${rid}) from ${engineRepo}`);
  execFileSync('dotnet', ['publish', project, '-c', 'Release', '-r', rid, '-p:PublishAot=true', '-o', staging], {
    stdio: 'inherit',
  });

  const built = join(staging, binary);
  if (!existsSync(built)) {
    console.error(`Expected ${built} after publish.`);
    process.exit(1);
  }

  const outDir = join('bin', target);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(built, join(outDir, binary));

  compileGrammar(join(outDir, binary));
  rmSync(staging, { recursive: true, force: true });
}

/** Hand the build to WSL2, which is a real Linux machine as far as the compiler is concerned. */
function stageInWsl() {
  console.log(`Publishing NativeAOT engine (${rid}) inside WSL2`);
  try {
    execFileSync('wsl', [
      'bash', toWsl(join('scripts', 'stage-engine.sh')),
      toWsl(engineRepo), toWsl('bin'), rid,
    ], { stdio: 'inherit' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('Could not run "wsl". Is WSL2 installed and is a distro set up?');
    } else {
      console.error('WSL build failed. Has scripts/setup-wsl.sh been run inside WSL?');
    }
    process.exit(1);
  }
}

/** `dsl.ct` -> `dsl.cta`, compiled by the engine itself so the two can never disagree. */
function compileGrammar(binary) {
  const grammarOut = join('bin', 'dsl.cta');
  execFileSync(binary, ['-f', join(engineRepo, 'dsl.ct'), '-o', grammarOut], { stdio: 'inherit' });
  console.log(`Staged ${grammarOut}`);
}

/** A Windows path expressed the way WSL sees it, as /mnt/<drive>/... */
function toWsl(winPath) {
  const absolute = resolve(winPath).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):/.exec(absolute);
  if (!drive) {
    console.error(`Cannot map ${winPath} into WSL - expected a drive-letter path.`);
    process.exit(1);
  }
  return `/mnt/${drive[1].toLowerCase()}${absolute.slice(2)}`;
}

console.log(`Staged ${join('bin', target)}`);
