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

const SCHEMA = 'clemtoken.tokens';
const VERSION = 1;
const TIMEOUT_MS = 10000;

export class EngineError extends Error { }

/**
 * Shells the bundled NativeAOT engine out once per document version.
 *
 * The engine reads the whole document from stdin and prints one JSON payload, so non-ASCII text
 * never has to round-trip through a temp file. Both directions are pinned to UTF-8 by the engine,
 * which keeps `line`/`character`/`length` in UTF-16 units - the same unit VS Code positions use.
 */
export class ClemTokenEngine implements vscode.Disposable {
	private readonly cache = new Map<string, { version: number; tokens: Promise<TokenSet> }>();
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
		if (documentKey === undefined || documentVersion === undefined) {
			return this.run(text);
		}
		const hit = this.cache.get(documentKey);
		if (hit !== undefined && hit.version === documentVersion) {
			return hit.tokens;
		}
		const tokens = this.run(text);
		this.cache.set(documentKey, { version: documentVersion, tokens });
		// a failed run must not stay cached, or the document is stuck on the error until it changes
		tokens.catch(() => {
			if (this.cache.get(documentKey)?.tokens === tokens) {
				this.cache.delete(documentKey);
			}
		});
		return tokens;
	}

	private run(text: string): Promise<TokenSet> {
		const binary = this.resolveBinary();
		if (binary === undefined) {
			return Promise.reject(new EngineError(`No ClemToken engine bundled for ${this.target}.`));
		}
		const grammar = this.resolveGrammar();
		return new Promise<TokenSet>((resolve, reject) => {
			const child = spawn(binary, ['-f', grammar, '-in', '-tokens', 'json'], {
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
			this.children.add(child);
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let settled = false;
			const finish = (): boolean => {
				if (settled) {
					return false;
				}
				settled = true;
				this.children.delete(child);
				return true;
			};
			const timer = setTimeout(() => {
				if (finish()) {
					child.kill();
					reject(new EngineError(`ClemToken engine timed out after ${TIMEOUT_MS}ms.`));
				}
			}, TIMEOUT_MS);
			child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
			child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
			child.on('error', (e) => {
				if (finish()) {
					clearTimeout(timer);
					reject(new EngineError(`Could not start the ClemToken engine: ${e.message}`));
				}
			});
			child.on('close', (code) => {
				if (!finish()) {
					return;
				}
				clearTimeout(timer);
				if (code !== 0) {
					reject(new EngineError(`ClemToken engine exited with code ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
					return;
				}
				try {
					const parsed = JSON.parse(Buffer.concat(out).toString('utf8')) as TokenSet;
					if (parsed.schema !== SCHEMA) {
						reject(new EngineError(`Unexpected engine payload: schema "${parsed.schema}".`));
						return;
					}
					if (parsed.version > VERSION) {
						reject(new EngineError(`Engine speaks ${SCHEMA} v${parsed.version}, this extension understands v${VERSION}.`));
						return;
					}
					resolve(parsed);
				} catch (e) {
					reject(new EngineError(`Could not read the engine output: ${(e as Error).message}`));
				}
			});
			// the engine may exit before we finish writing (bad grammar), so a broken pipe is not fatal
			child.stdin.on('error', () => { /* reported through close */ });
			child.stdin.end(Buffer.from(text, 'utf8'));
		});
	}

	dispose(): void {
		for (const child of this.children) {
			child.kill();
		}
		this.children.clear();
		this.cache.clear();
	}
}
