import * as vscode from 'vscode';
import { builtinSpec } from './builtins';
import { Anchor, Analysis, Spec } from './highlight';

/**
 * Name collisions the static stats do not flag. Duplicate rule names make the parser throw at
 * runtime; a declaration shadowed by a non-overridable built-in is silently ignored. Redeclaring a
 * spec is not a collision: the engine treats every `$name:` declaration as an alternative.
 */
export function collectDiagnostics(analysis: Analysis): vscode.Diagnostic[] {
	return [
		...duplicateRules(analysis.definitions),
		...shadowedSpecs(analysis.specs),
	];
}

/** `@a:` twice: the parser throws `Reference 'a' already exists` on the next parse. */
function duplicateRules(definitions: Anchor[]): vscode.Diagnostic[] {
	const first = new Map<string, number>();
	const diagnostics: vscode.Diagnostic[] = [];
	for (const definition of definitions) {
		const line = first.get(definition.name);
		if (line === undefined) {
			first.set(definition.name, definition.line);
			continue;
		}
		diagnostics.push(diagnostic(
			`@${definition.name} is already defined on line ${line + 1}. The parser fails on a duplicate rule name.`,
			vscode.DiagnosticSeverity.Error,
			definition.line, definition.column, definition.size,
		));
	}
	return diagnostics;
}

/** A declaration the built-in `space`, `tab`, `newline` or `greedy` spec silently ignores. */
function shadowedSpecs(specs: Spec[]): vscode.Diagnostic[] {
	const diagnostics: vscode.Diagnostic[] = [];
	for (const spec of specs) {
		const builtin = builtinSpec(spec.name);
		if (builtin === undefined || builtin.overridable) {
			continue;
		}
		diagnostics.push(diagnostic(
			`$${spec.name} has no effect: the built-in ${spec.name} spec cannot be overridden.`,
			vscode.DiagnosticSeverity.Warning,
			spec.line, spec.nameColumn, spec.nameSize,
		));
	}
	return diagnostics;
}

function diagnostic(message: string, severity: vscode.DiagnosticSeverity, line: number, column: number, size: number): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(new vscode.Range(line, column, line, column + size), message, severity);
	diagnostic.source = 'ClemToken';
	return diagnostic;
}
