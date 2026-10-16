// Publishes the per-target extensions in the order that keeps bin/ and the VSIX target in sync.
//
//   node scripts/publish.mjs                     # stage and publish every target this host can build
//   node scripts/publish.mjs --package           # build those VSIXs without publishing
//   node scripts/publish.mjs --target linux-x64  # one target only
//   node scripts/publish.mjs --engine <checkout> # ClemToken checkout, if not ../ClemToken
//
// vsce re-runs "vscode:prepublish" but packages whatever is sitting in bin/, and staging a platform
// evicts the others. So each engine has to be staged immediately before the target that consumes
// it. Getting that backwards ships a Windows VSIX containing the Linux engine, and nothing in the
// toolchain rejects it - it just fails for every user at runtime.
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

// NativeAOT cannot cross-compile, so the only foreign target reachable from Windows is Linux, via
// the WSL2 path in stage-engine.mjs. Everything else needs a machine of that kind.
const HOST = `${process.platform}-${process.arch}`;
const BUILDABLE = process.platform === 'win32' ? [HOST, `linux-${process.arch}`] : [HOST];

const requested = flag('target');
const targets = requested !== undefined ? [requested] : BUILDABLE;

// a typo here would otherwise publish nothing and look like a success
const unknown = targets.filter((target) => !BUILDABLE.includes(target));
if (unknown.length > 0) {
	console.error(`This host cannot build ${unknown.join(', ')}. Available here: ${BUILDABLE.join(', ')}.`);
	process.exit(1);
}

const engine = flag('engine');
const packageOnly = has('package');

console.log(`${packageOnly ? 'Packaging' : 'Publishing'} ${targets.join(', ')} on ${HOST}`);
if (!packageOnly && targets.length > 1) {
	// a published version cannot be replaced, so an abort between targets leaves the new version
	// half-published: installable on one platform, missing on the others
	console.log('Note: each target publishes separately, so a failure part way through is not rolled back.');
}

for (const target of targets) {
	const binary = join(root, 'bin', target, target.startsWith('win32') ? 'ClemToken.exe' : 'ClemToken');
	console.log(`\n=== ${target} ===`);

	// stage, then package: staging also evicts any other platform from bin/
	execFileSync(process.execPath, [
		join(scriptsDir, 'stage-engine.mjs'),
		'--target', target,
		...(engine !== undefined ? ['--engine', engine] : []),
	], { stdio: 'inherit', cwd: root });

	if (!existsSync(binary)) {
		console.error(`Expected ${binary} after staging ${target}.`);
		process.exit(1);
	}

	// Node refuses to spawn a .cmd without a shell (CVE-2024-27980), and passing args alongside
	// shell: true is deprecated (DEP0190), so the whole command goes in as one string. Both parts
	// are safe to interpolate: the subcommand is a literal and the target was checked above.
	execFileSync(`npx --yes @vscode/vsce ${packageOnly ? 'package' : 'publish'} --target ${target}`, {
		stdio: 'inherit',
		cwd: root,
		shell: true,
	});
}

console.log(`\nDone: ${targets.join(', ')}`);
