# Diagnostic helper subsets

These files contain only the parts of two upstream packages used by this
checker. They are local TypeScript subsets with no npm imports. Keep them
readable; do not replace them with complete package bundles when updating them.

| Local code         | Upstream version                            | Retained behavior                                                                 |
| ------------------ | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `css/`             | `vscode-css-languageservice` 6.3.10         | CSS parsing and default error/warning validation, with the data those checks use. |
| `text_document.ts` | `vscode-languageserver-textdocument` 1.0.12 | Immutable text reads and UTF-16 offsets/positions, including CR/LF handling.      |

The CSS subset drops completion, hover, formatting, navigation, LESS/SCSS
support and rich documentation data. The document subset drops updates, applying
edits, change-event helpers and sorting. The checker's default diagnostic
behavior remains covered by tests.

The text-document source comes from `lib/esm/main.js` in the published 1.0.12
package from
[vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node/tree/main/textDocument).
Its MIT notice is in `licenses/vscode-languageserver-textdocument.txt`. The CSS
directory contains its own version/source notes and MIT license.

Before updating a subset, compare it with the original pinned package on
representative and edge inputs, then add fixed regressions to `Deno.test`. The
tests must run without installing the original helper packages. Run:

```sh
deno test --no-npm --node-modules-dir=none tests/vendor_*_test.ts
deno task check
deno task lint
deno task test
```

The checker imports `@jridgewell/trace-mapping` 0.3.31 directly and shares the
same resolved npm package already used by Svelte through its remapping packages.
Deno's lockfile contains one copy. We keep the direct declaration because Svelte
exposes no public trace-mapping API; importing through private `node_modules`
paths would depend on the install layout. There is no local copy of the
source-map library, and the dependency test guards against adding a second
version.
