# Historical maintenance fragments

This directory contains non-executable Markdown references for explicitly
reviewed, retired maintenance fragments. It is not a location for supported
scripts or an automatic escape from compiler diagnostics.

A fragment may be archived here only after repository/history review establishes
that it is incomplete and has no active import or operational workflow. Each
artifact must document the original path, introducing revision, retirement
reason and content hash, and preserve the exact original source in a code block.
Missing executable behavior must not be reconstructed by guesswork.

Supported or uncertain maintenance tools remain in their existing locations
pending a separate review. Archival does not authorize executing legacy snippets
or changing runtime code. Markdown is documentation; compiler/lint configuration
must not be weakened for archival.

## Reviewed archive

- [patch_n8n.ts](patch_n8n.ts.md): incomplete 2026-06-14 insertion fragment with an
  undeclared `content` and no file read/write lifecycle; retired 2026-10-08.
