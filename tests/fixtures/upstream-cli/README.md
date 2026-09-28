The `test-success` and `test-error` directories are verbatim copies from
`sveltejs/language-tools/packages/svelte-check` at commit
`f03e56672ed174e7042334a3237fe8569cfbf8f1`. The MIT license is included here.

`tests/upstream_cli_test.ts` ports `packages/svelte-check/test-sanity.js` to
`Deno.test`, checking both the library and the Deno CLI against the original
TypeScript project configs. It preserves the seven original semantic error
checks and their source positions. Deno's missing-local-import diagnostic uses
the string code `no-local` instead of TypeScript's numeric `2307`. The new
component call emitter reports a missing required prop as `2345` at the opening
tag, while upstream's assignment emitter reports `2741` at the component name
(one character later). The test checks the same missing `b` property and fixes
the expected location to the new emitter's opening-tag span.

The original harness repeats the same cases for Node, TSGo, and incremental
compiler-cache modes. This project has one Deno backend, so the port exercises
the clean and erroneous projects through both supported entry points instead
of repeating those backend switches.
