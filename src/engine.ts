import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** One highlightable terminal, as emitted by `ClemToken -tokens json`. */
export interface SyntaxToken {
	/** nearest enclosing grammar rule: the highlight-kind taxonomy, or `null` for a recovery `Error`. */
	rule: string | null;
	/** the terminal's own rule/spec name. */
	leaf: string;
	value: string;
	line: number;
	character: number;
	length: number;
}

export interface TokenSet {
	schema: string;
	version: number;
	tokens: SyntaxToken[];
}

/** One rule's static analysis, as emitted by `-stats grammar json`. `low`/`high` are `null` for infinity. */
export interface RuleGrammarStats {
	name: string;
	type: string;
	value: string | null;
	low: number | null;
	high: number | null;
	recursive: boolean;
	unproductive: boolean;
}

export interface GrammarStats {
	schema: string;
	version: number;
	ruleCount: number;
	specCount: number;
	counts: { simple: number; reserved: number; group: number; reference: number; anchor: number; optional: number; lookahead: number; empty: number; nodes: number };
	total: { low: number | null; high: number | null };
	rules: RuleGrammarStats[];
}

/** One rule's runtime attribution, as emitted by `-stats parse json`. */
export interface RuleMetrics {
	name: string;
	type: string;
	value: string | null;
	executions: number;
	matches: number;
	failures: number;
	allocatedBytes: number;
	selfAllocatedBytes: number;
	totalMs: number;
	selfMs: number;
}

/** One node of the merged call tree from `-stats parse tree json`. `rule` indexes `rules` (-1 = root). */
export interface CallNode {
	id: number;
	parent: number;
	rule: number;
	executions: number;
	matches: number;
	failures: number;
	allocatedBytes: number;
	totalMs: number;
}

export interface ParseMetrics {
	schema: string;
	version: number;
	totalAllocatedBytes: number;
	totalElapsedMs: number;
	unattributedAllocatedBytes: number;
	unattributedElapsedMs: number;
	rules: RuleMetrics[];
	/** merged call tree, for the flame graph; empty when the engine predates the call-tree output */
	tree: CallNode[];
}

const SCHEMA = 'clemtoken.tokens';
const GRAMMAR_STATS_SCHEMA = 'clemtoken.grammarStats';
const PARSE_METRICS_SCHEMA = 'clemtoken.parseMetrics';
const PARSE_TREE_SCHEMA = 'clemtoken.parseTree';
const VERSION = 1;
const TIMEOUT_MS = 10000;
/** Hard cap on engine stdout + stderr, so a runaway engine cannot exhaust the extension host. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class EngineError extends Error { }

/** Kill without ever throwing: an exception in a timer callback becomes an uncaught exception. */
function kill(child: import('node:child_process').ChildProcess): void {
	try {
		child.kill();
	} catch {
		// already gone
	}
}

/**
 * A `ChildProcess` whose stdio is piped, or `undefined` if the OS refused to start it. `spawn`
 * throws synchronously for a bad executable path, which must not escape an async callback.
 */
function trySpawn(binary: string, args: string[]): import('node:child_process').ChildProcessWithoutNullStreams | undefined {
	try {
		return spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
	} catch {
		return undefined;
	}
}

/**
 * Shells the bundled NativeAOT engine out once per document version.
 *
 * The engine reads the whole document from stdin and prints one JSON payload, so non-ASCII text
 * never has to round-trip through a temp file. Both directions are pinned to UTF-8 by the engine,
 * which keeps `line`/`character`/`length` in UTF-16 units - the same unit VS Code positions use.
 */
export class ClemTokenEngine implements vscode.Disposable {
	private readonly tokenCache = new Map<string, { version: number; value: Promise<TokenSet> }>();
	private readonly statsCache = new Map<string, { version: number; value: Promise<GrammarStats> }>();
	private readonly children = new Set<import('node:child_process').ChildProcess>();

	constructor(private readonly context: vscode.ExtensionContext) { }

	/** Platform folder this build ships for, e.g. `win32-x64`. */
	get target(): string {
		return `${process.platform}-${process.arch}`;
	}

	private get binaryName(): string {
		return process.platform === 'win32' ? 'ClemToken.exe' : 'ClemToken';
	}

	/**
	 * Path to the engine binary: the `clemtoken.enginePath` override, else the bundled one.
	 *
	 * A VSIX packaged on Windows carries no POSIX file attributes, so a bundled Linux binary can
	 * arrive without its executable bit. It is restored here rather than requiring a Linux build
	 * host - see `ensureExecutable`.
	 */
	resolveBinary(): string | undefined {
		const override = vscode.workspace.getConfiguration('clemtoken').get<string>('enginePath', '').trim();
		if (override) {
			if (!fs.existsSync(override)) {
				return undefined;
			}
			this.ensureExecutable(override);
			return override;
		}
		const bundled = path.join(this.context.extensionUri.fsPath, 'bin', this.target, this.binaryName);
		if (!fs.existsSync(bundled)) {
			return undefined;
		}
		this.ensureExecutable(bundled);
		return bundled;
	}

	private ensureExecutable(binary: string): void {
		if (process.platform === 'win32') {
			return;
		}
		try {
			fs.accessSync(binary, fs.constants.X_OK);
			return;
		} catch {
			// not executable; try to fix it below
		}
		try {
			fs.chmodSync(binary, 0o755);
		} catch {
			// a spawn failure reports the real problem with a clearer message
		}
	}

	/** The compiled grammar (`dsl.cta`) is platform-independent, so it ships once at the root of `bin`. */
	resolveGrammar(): string {
		return path.join(this.context.extensionUri.fsPath, 'bin', 'dsl.cta');
	}

	get available(): boolean {
		return this.resolveBinary() !== undefined && fs.existsSync(this.resolveGrammar());
	}

	/**
	 * Targets this build bundles an engine for, read from `bin/`.
	 *
	 * The package is universal, so it carries a folder per platform. Reading them back means the
	 * unpacked contents decide what is supported and a hardcoded table cannot drift from them.
	 */
	get bundledTargets(): string[] {
		try {
			return fs.readdirSync(path.join(this.context.extensionUri.fsPath, 'bin'), { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && /^(win32|linux|darwin)-/.test(entry.name))
				.map((entry) => entry.name);
		} catch {
			return [];
		}
	}

	/** A target as a person would say it, for messages that get shown rather than logged. */
	platformName(): string {
		const [platform, arch] = this.target.split('-');
		const name = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform;
		return arch === 'x64' ? name : `${name} on ${arch}`;
	}

	/**
	 * Tokenize `text`, reusing the in-flight or completed run when the caller passes the same
	 * document key and version. Both the semantic and decoration layers call this per pass, so the
	 * document is only ever shelled out once.
	 */
	tokenize(text: string, documentKey?: string, documentVersion?: number): Promise<TokenSet> {
		const run = () => this.run(['-f', this.resolveGrammar(), '-in', '-tokens', 'json'], text)
			.then((parsed) => this.contract(parsed, SCHEMA, VERSION) as TokenSet);
		if (documentKey === undefined || documentVersion === undefined) {
			return run();
		}
		return this.memo(this.tokenCache, documentKey, documentVersion, run);
	}

	/**
	 * Static analysis of a grammar (`-stats grammar`). The grammar arrives over stdin (`-f -`), so
	 * the buffer under edit is analyzed as-is. Cached per document version like `tokenize`.
	 */
	grammarStats(text: string, documentKey?: string, documentVersion?: number): Promise<GrammarStats> {
		const run = () => this.run(['-f', '-', '-stats', 'grammar', 'json'], text)
			.then((parsed) => this.contract(parsed, GRAMMAR_STATS_SCHEMA, VERSION) as GrammarStats);
		if (documentKey === undefined || documentVersion === undefined) {
			return run();
		}
		return this.memo(this.statsCache, documentKey, documentVersion, run);
	}

	/**
	 * Runtime parse metrics of `text` under the DSL grammar (`-stats parse tree`). The call tree
	 * (`edges`) drives the flame graph; an engine that predates it falls back to the flat table.
	 */
	profile(text: string): Promise<ParseMetrics> {
		return this.run(['-f', this.resolveGrammar(), '-in', '-stats', 'parse', 'tree', 'json'], text)
			.then((parsed) => this.contract(parsed, PARSE_TREE_SCHEMA, VERSION) as ParseMetrics)
			.catch(() => this.run(['-f', this.resolveGrammar(), '-in', '-stats', 'parse', 'json'], text)
				.then((parsed) => ({ ...(this.contract(parsed, PARSE_METRICS_SCHEMA, VERSION) as ParseMetrics), tree: [] })));
	}

	/** Reuse an in-flight or completed run for the same key + version; a failed run is dropped. */
	private memo<T>(cache: Map<string, { version: number; value: Promise<T> }>, key: string, version: number, make: () => Promise<T>): Promise<T> {
		const hit = cache.get(key);
		if (hit !== undefined && hit.version === version) {
			return hit.value;
		}
		const value = make();
		cache.set(key, { version, value });
		value.catch(() => {
			if (cache.get(key)?.value === value) {
				cache.delete(key);
			}
		});
		return value;
	}

	/** Every payload is versioned the same way, so the contract is enforced in one place. */
	private contract(parsed: { schema?: string; version?: number }, schema: string, version: number): unknown {
		if (parsed.schema !== schema) {
			throw new EngineError(`Unexpected engine payload: schema "${parsed.schema}".`);
		}
		if ((parsed.version ?? 0) > version) {
			throw new EngineError(`Engine speaks ${schema} v${parsed.version}, this extension understands v${version}.`);
		}
		return parsed;
	}

	private run(args: string[], text: string): Promise<{ schema?: string; version?: number }> {
		const binary = this.resolveBinary();
		if (binary === undefined) {
			return Promise.reject(new EngineError(`No ClemToken engine bundled for ${this.target}.`));
		}
		return new Promise<{ schema?: string; version?: number }>((resolve, reject) => {
			const child = trySpawn(binary, args);
			if (child === undefined) {
				reject(new EngineError('Could not start the ClemToken engine.'));
				return;
			}
			this.children.add(child);
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let bytes = 0;
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			// every exit path goes through `finish`, so the promise settles exactly once and the child
			// is always dropped from the set even when the engine fail-fasts
			const finish = (): boolean => {
				if (settled) {
					return false;
				}
				settled = true;
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				this.children.delete(child);
				return true;
			};
			const fail = (error: EngineError): void => {
				if (finish()) {
					kill(child);
					reject(error);
				}
			};
			timer = setTimeout(() => fail(new EngineError(`ClemToken engine timed out after ${TIMEOUT_MS}ms.`)), TIMEOUT_MS);
			child.stdout.on('data', (chunk: Buffer) => {
				out.push(chunk);
				bytes += chunk.length;
				if (bytes > MAX_OUTPUT_BYTES) {
					fail(new EngineError(`ClemToken engine output exceeded ${MAX_OUTPUT_BYTES} bytes.`));
				}
			});
			child.stderr.on('data', (chunk: Buffer) => {
				err.push(chunk);
				bytes += chunk.length;
				if (bytes > MAX_OUTPUT_BYTES) {
					fail(new EngineError(`ClemToken engine output exceeded ${MAX_OUTPUT_BYTES} bytes.`));
				}
			});
			// a stream 'error' with no listener reaches Node's uncaught-exception path, so a hard
			// engine crash that breaks the pipe could take the extension host down with it. Swallow
			// every pipe error here; `close`/`error` below report the real reason.
			child.stdout.on('error', () => { /* reported through close */ });
			child.stderr.on('error', () => { /* reported through close */ });
			child.stdin.on('error', () => { /* reported through close */ });
			child.on('error', (e) => {
				fail(new EngineError(`Could not start the ClemToken engine: ${e.message}`));
			});
			child.on('close', (code, signal) => {
				if (!finish()) {
					return;
				}
				if (code !== 0) {
					const detail = Buffer.concat(err).toString('utf8').trim();
					const reason = signal ? `signal ${signal}` : `code ${code}`;
					reject(new EngineError(`ClemToken engine exited with ${reason}${detail ? `: ${detail}` : ''}`));
					return;
				}
				try {
					resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as { schema?: string; version?: number });
				} catch (e) {
					reject(new EngineError(`Could not read the engine output: ${(e as Error).message}`));
				}
			});
			try {
				child.stdin.end(Buffer.from(text, 'utf8'));
			} catch {
				// the engine may already be gone; `close` reports it
			}
		});
	}

	dispose(): void {
		for (const child of this.children) {
			kill(child);
		}
		this.children.clear();
		this.tokenCache.clear();
		this.statsCache.clear();
	}
}
