# Upstream template cases

These `.svelte` files are verbatim copies of `input.svelte` from
[Svelte language-tools](https://github.com/sveltejs/language-tools/tree/f03e56672ed174e7042334a3237fe8569cfbf8f1/packages/svelte2tsx/test/htmlx2jsx/samples), commit `f03e56672ed174e7042334a3237fe8569cfbf8f1`.

Each file name is its source sample directory. The upstream MIT license is included in `LICENSE`.

`tests/template_test.ts` ports these cases to `Deno.test`: typed declarations supply each fixture's external values; Deno checks the generated code and assertions check source ranges. The old expected JavaScript snapshots are not used because this implementation generates plain TypeScript from Svelte's modern AST.
