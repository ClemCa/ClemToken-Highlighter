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