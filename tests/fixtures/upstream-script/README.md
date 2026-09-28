These component inputs come from `sveltejs/language-tools`,
`packages/svelte2tsx/test/svelte2tsx/samples/<name>/input.svelte`, at commit
`f03e56672ed174e7042334a3237fe8569cfbf8f1` (MIT license).

The Deno tests in `tests/script_test.ts` port the checks to the new emitter. The
old generated-code snapshots target the TypeScript-based svelte2tsx emitter, so
the port checks public props, export aliases, scopes, store reads and source
locations instead of keeping incompatible snapshots.

`ts-export-has-type.svelte` and `ts-export-boolean.svelte` add `lang="ts"`, since the original harness selected
the TypeScript mode outside the component. Other component inputs are unchanged.
