// Publishes the extension as a single universal package that carries every engine this host can build.
//
//   node scripts/publish.mjs                     # stage every target, then publish
//   node scripts/publish.mjs --package           # same staging, but stop at the .vsix
//   node scripts/publish.mjs --engine <checkout> # ClemToken checkout, if not ../ClemToken
//
// The engines are all staged into ./bin before the package is built once, so an engine cannot end up
// in a package meant for a different platform: there is only one package and it holds all of them.
// The extension picks its own folder at runtime, and says so out loud on a platform it has no engine
// for rather than leaving the file unhighlighted for no visible reason.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptsDir);

// NativeAOT cannot cross-compile, so the only foreign target reachable from Windows is Linux, via the
// WSL2 path in stage-engine.mjs. A platform this host cannot build is simply absent from the package,
// which is why the extension checks what it actually carries instead of assuming.
const HOST = `${process.platform}-${process.arch}`;
const TARGETS = process.platform === 'win32' ? [HOST, `linux-${process.arch}`] : [HOST];

const engine = flag('engine');
const packageOnly = has('package');

console.log(`${packageOnly ? 'Packaging' : 'Publishing'} one package with engines: ${TARGETS.join(', ')}`);

for (const target of TARGETS) {
	console.log(`\n=== staging ${target} ===`);
	execFileSync(process.execPath, [
		join(scriptsDir, 'stage-engine.mjs'),
		'--target', target,
		...(engine !== undefined ? ['--engine', engine] : []),
	], { stdio: 'inherit', cwd: root });

	const binary = join(root, 'bin', target, target.startsWith('win32') ? 'ClemToken.exe' : 'ClemToken');
	if (!existsSync(binary)) {
		console.error(`Expected ${binary} after staging ${target}.`);
		process.exit(1);
	}
}

// No --target: one package for every platform, matching what bin/ now holds. Nothing here has to be
// kept in sync with anything, which is the point of the universal shape.
//
// Node refuses to spawn a .cmd without a shell (CVE-2024-27980), and passing args alongside
// shell: true is deprecated (DEP0190), so the whole command goes in as a single literal string.
execFileSync(`npx --yes @vscode/vsce ${packageOnly ? 'package' : 'publish'}`, {
	stdio: 'inherit',
	cwd: root,
	shell: true,
});

console.log(`\nDone: ${packageOnly ? 'packaged' : 'published'} with ${TARGETS.join(', ')}`);
