# Change Log

All notable changes to the "clemtoken-highlighter" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
