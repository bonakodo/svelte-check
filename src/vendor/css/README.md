# CSS validation subset

This directory contains the default CSS parser and validator from
[`vscode-css-languageservice` 6.3.10](https://github.com/microsoft/vscode-css-languageservice/tree/v6.3.10),
originally extracted from that npm release's `lib/esm` files and rewritten as
strict TypeScript. The Microsoft copyright headers and
[MIT license](./LICENSE.md) remain with the code. The modules use typed parser
state, AST nodes, tokens, visitors, and diagnostics, with native enums in place
of generated JavaScript enum initialization. They pass Deno's type checker and
linter without file-wide exclusions.

`mod.ts` performs the same default `parseStylesheet` and `doValidation` work
used by this checker: collect parser errors, run the default lint visitor, omit
ignored markers, and convert offsets to diagnostic ranges. It keeps upstream
ordering, messages, codes, and severities. It uses the local read-only
text-document adapter.

## Retained code and data

- CSS scanner and parser, CSS AST classes reached by that parser and validator,
  and their parser error messages. The remaining parser and node methods stay
  together to preserve syntax recovery and the validator's expected AST shape.
- The eight enabled default lint rules: `emptyRules`, `unknownProperties`,
  `unknownAtRules`, `vendorPrefix`, `fontFaceProperties`,
  `propertyIgnoredDueToDisplay`, `hexColorLength`, and
  `argumentsInColorFunction`.
- Built-in validation data: 888 property names, 138 names whose status is not
  standard, 25 at-rule names, and the parser's page-margin at-rule names. These
  values come from `data/webCustomData.js` and `languageFacts/builtinData.js` in
  the same release. No property value or support data is needed by default
  validation.
- The lint declaration `Element`. Small string and presence checks stay in their
  callers, and messages use literals or template strings. Arrays of built-in
  names are read-only.

## Deliberate omissions

Completion, hover, navigation, symbols, formatting, edits, colors, folding,
selection ranges, filesystem access, custom data providers, locale loading,
SCSS/LESS parsers and scanners, 28 unused node exports, unused enum members, ten
unused parser messages, and all lint paths disabled by default are omitted. The
latter include box-model, duplicate-property, float, IE-hack, numeric-unit,
selector, import, important, unknown-vendor-property and all-vendor-prefix
checks. The configurable lint settings API is omitted; this checker uses fixed
defaults.

The copied CSS data drops descriptions, documentation links, browser versions,
syntax descriptions, completion values, relevance, restrictions, pseudo classes,
and pseudo elements. Default validation never reads those fields. It preserves
the property-status flags used to decide whether a standard property exists.

`tests/vendor_css_test.ts` uses exact default diagnostic outputs captured from
the unmodified 6.3.10 release for syntax recovery, modern CSS, vendor prefixes,
display rules, comments, escapes, custom properties, and newline/Unicode cases.
Those saved tests run entirely against local code and do not import the npm
language service.

The TypeScript rewrite also fixes an upstream crash when property or keyframe
names match object prototype keys such as `constructor`. Typed `Map` collections
keep those names separate from JavaScript object members. Dedicated tests cover
the resulting diagnostics and paired keyframes.
