# Change Log

All notable changes to the "clemtoken-highlighter" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.5.2] - 2026-10-16

- Added `ClemToken: Show Grammar Stats` and `ClemToken: Profile Grammar`, which open the grammar's
  static analysis and a live parse profile in one reusable panel
- A status bar item summarises the current grammar (`N rules · M nodes`) and opens the stats window
- Grammar Stats and Parse Profile now open with a flame graph above the table: the grammar window
  nests each rule under the rules that reference it (width = the tokens in its fully-expanded body),
  and the profile window draws the engine's new per-call call tree (width = inclusive time)
- The flame graphs are interactive: hover a frame to spotlight its stack and read a tooltip that
  follows the cursor, click a frame to zoom into that subtree (the only way to see frames too thin to
  draw at full width, with a breadcrumb to navigate back), and filter by rule name to flag every match
- The flame graph and the rule table below are linked: clicking a frame filters the table to that
  rule, clicking (or hovering) a row filters to the rule and zooms the graph to where it runs, and
  typing in the filter box narrows the table as it flags the matching frames
- Hovering a rule definition or a reference now explains it: the rule's type, symbol bound, flags and
  reference count, its body, and a link from a reference to its definition
- Hovering a spec now reports its body and uses, and whether it overrides a built-in or is shadowed
  by one; `$$name` is flagged as ignored and an undeclared `$name` lists the built-ins
- Hovering a group's `(` / `)` now reports the group's label, body and repetition, and hovering a
  group's label `:` reports the separator
- Hovering an option's `[` / `]` now marks it as optional (with its branch count); `|` reports the
  branch separator, `$[...]`'s brackets report the reserved spec selector, and `@>` / `@>>` report a
  zero-width lookahead
- Hovering a repetition suffix now says how many times it repeats and whether the match is ignored
- A reference count now sits above each rule definition as a CodeLens shortcut to Find References,
  behind the new `clemtoken.showCodeLens` setting
- The editor now flags a duplicate `@rule` name (an error, since the parser throws on it) and a
  declaration of a built-in spec the engine cannot override (a warning, since it is silently ignored)
- Group parentheses are now coloured by nesting depth from the new `clemtoken.bracketColors` list (an
  empty list turns the rainbow off), and `clemtoken.statsDebounceMs` sets how long stats wait after
  an edit
- The bundled engine no longer crashes on malformed or pathological input: an unhandled error, or a
  grammar nested too deeply to walk, now reports a message on stderr and exits non-zero instead of
  aborting the process (which the editor surfaced as a crash)

## [1.5.1] - 2026-10-15
- The agent had made the documentation for the changelog, and overdid it on the readme.

## [1.5.0] - 2026-10-15

- Highlighting is now parser-driven: a bundled ClemToken engine tokenizes the document and the
  decorations come from the grammar's own rules instead of regular expressions
- Added a semantic tokens provider for the categories a theme understands (comment, keyword,
  variable, regexp, operator)
- Rule definitions and references now come from the parser, fixing Go to Definition, Find References
  and the outline for tagged (`tag:@name`) and optional (`?@name`) references
- Colour changes now apply on setting change instead of requiring a reload
- Removed an invalid `capabilities` block from the manifest
- Fixed `.cta` highlighting never refreshing on edit, document symbols accumulating stale entries,
  and folding ranges throwing on files whose last line is not `)`
- macOS is not supported; the extension now says so on startup instead of highlighting nothing
- Fixed the reserved spec name inside `$[...]` being coloured the same as its own brackets
- Added settings for the spec and lookahead colors, which were missing from the manifest

## [1.4.12] - 2026-02-03

- Ignored optionals

## [1.4.11] - 2026-02-03

- Adjusted symbols

## [1.4.10] - 2026-02-03

- Fixed highlighting for lookahead optionals

## [1.4.9] - 2026-02-03

- Fixed closing-bracket detection for escaped `\]` in optionals

## [1.4.8] - 2026-02-03

- Lookahead: allow a space ending

## [1.4.7] - 2026-02-03

- Lookaheads with optionals

## [1.4.6] - 2026-02-03

- Always ignored anchors

## [1.4.5] - 2026-01-28

- Lookahead

## [1.4.4] - 2026-01-26

- Fixes to spec mode decorations

## [1.4.3] - 2026-01-26

- Spec modes

## [1.4.2] - 2026-01-26

- Better optionals handling, including escaped brackets

## [1.4.1] - 2026-01-26

- Added support for named optional references

## [1.4.0] - 2026-01-26

- Added support for optional references, plus some fixes for subgroups

## [1.3.0] - 2025-11-20

- Support for specs

## [1.2.5] - 2025-08-20

- Fixed nested optionals

## [1.2.4] - 2025-08-20

- Better subgroup support inside optionals

## [1.2.3] - 2025-08-20

- Added support for ignored selector decorations

## [1.2.2] - 2025-08-20

- Added postfix exception for conditionals

## [1.2.1] - 2025-08-16

- Regex update to sync with C#

## [1.2.0] - 2025-08-16

- Support for ClemToken abstract trees (`.cta`)

## [1.1.1] - 2025-08-16

- Regex fix for cases with both `:` and other suffixes

## [1.1.0] - 2025-08-16

- Definition and references

## [1.0.0] - 2025-08-16

- First release. Bundled with esbuild, and shipping highlighting for comments, references and anchors
