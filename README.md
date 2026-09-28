# @bonakodo/svelte-check

A Svelte 5 and SvelteKit 3 checker that runs in Deno and uses the TypeScript
checker bundled with Deno. It has no dependency on `typescript`,
`@typescript/native-preview`, `svelte2tsx`, or `svelte-language-server`.

The transformer uses `svelte/compiler`'s `parse(source, { modern: true })` API.
Generated TypeScript stays in memory at the original component URLs. A
`deno lsp` child process checks those buffers alongside ordinary JavaScript and
TypeScript files. Diagnostics map back to the component source. Svelte's
compiler provides accessibility and compiler diagnostics; the CSS language
service checks styles.

CSS validation and its read-only text-document helper use trimmed local
TypeScript source under `src/vendor`, with upstream MIT notices and regression
tests. They omit editor features, SCSS/LESS, configurable lint rules and unused
CSS data. For preprocessor source maps, the checker shares the same
`trace-mapping` npm version already required by Svelte; it does not keep a
second implementation.

Tested with Deno 2.9.6, Svelte 5.57.0, SvelteKit 3.0.0-next.27 and Vite 8.3.0 on
macOS. This is a new checker, with its own CLI and documented scope; it does not
claim full parity with every upstream language-tools feature.

## Run from JSR

```sh
deno run --allow-read --allow-write --allow-run --allow-env --allow-net \
  jsr:@bonakodo/svelte-check@0.1.0/cli --workspace /path/to/project
```

For SvelteKit, run the project's type-generation step before checking. This
release supports Svelte 5 and SvelteKit 3; it does not support SvelteKit 2 or
standalone `svelte.config.*` files.

The CLI needs read access to source and dependency files, write access for
temporary checking configs, permission to start Deno child processes,
environment access for project tools, and network access for uncached
dependencies and package metadata. Vite configs and preprocessors execute as
project code. Use it with projects you trust.

For a local checkout:

```sh
deno install
deno task svelte-check --workspace /path/to/project
deno task svelte-check --workspace /path/to/project --output json
deno task svelte-check --workspace /path/to/project 'src/**/*.svelte'
deno task svelte-check --workspace /path/to/project --watch
```

The checker uses Deno's global dependency cache and does not need its own
`node_modules` directory. Kit projects still need their installed Vite/Kit
packages and generated `$app` files.

The checker combines the target project's Deno imports with its
`tsconfig.json`/`jsconfig.json`, including Kit 3's `$app/tsconfig` and
`$app/tsconfig/service-worker` parents. It preserves inherited compiler options,
path aliases and generated route types. It follows `package.json` imports such
as `#lib/*`, including imported components outside the config's `include` list.
Kit 3 projects must set their own `include` and `exclude` patterns. It enables
Deno's `sloppy-imports` resolver for common extensionless and `.js`-to-`.ts`
imports. When no configuration exists, it uses a temporary configuration with
Svelte 5 and browser types. It removes temporary files on completion and keeps
generated checking code in memory.

Run `deno task svelte-check --help` for all options. Exit codes are `0` for a
clean check, `1` for diagnostics that fail the check, and `2` for invocation or
process errors. Warnings fail only with `--fail-on-warnings` or a matching
`--compiler-warnings code:error` rule. Watch mode rechecks the whole selected
project after edits and stops with Ctrl-C.

Add the API to a Deno project with `deno add jsr:@bonakodo/svelte-check@0.1.0`:

```ts
import { check, transform } from "@bonakodo/svelte-check";

const result = await check({
  workspace: "/path/to/project",
  diagnosticSources: ["js", "svelte", "css"],
  failOnWarnings: true,
});

for (const diagnostic of result.diagnostics) {
  console.log(diagnostic.file, diagnostic.range, diagnostic.message);
}

const generated = transform(
  '<script lang="ts">let n: number = "wrong";</script>{n}',
  "Example.svelte",
);
```

JSON/API diagnostic positions are zero-based UTF-16 line/column pairs; human
output uses one-based positions. `transform()` returns checking code and source
segments, not executable application output.

## Checked behavior

- Instance/module scripts, imports, legacy exported props, aliases and defaults.
- Runes, typed and inferred `$props`, generic components, store reads and
  writes, and reactive declarations.
- Expressions, if/each/await/key blocks, const/declaration tags, snippets and
  render tags, component props, legacy slots, DOM attributes and events,
  bindings, actions, transitions and attachments.
- Typed legacy event dispatchers and explicit `$$Events` declarations.
- Plain JavaScript components with common JSDoc type annotations.
- Deno import maps and ordinary JS/TS consumers of local components.
- SvelteKit 3 page/layout/error props, route options, request handlers, load
  functions and actions, identified by route filenames and using generated
  `$types`. Run SvelteKit's type generation before checking a Kit project.
- Svelte compiler errors/warnings, CSS validation, warning filters, and mapped
  preprocessor diagnostics.

The checker reads Svelte options from `sveltekit(...)` in `vite.config.*`
through the project's installed Vite instance. Use `--vite-config` for a custom
path. It loads the config with Vite's native loader in the project's Deno
context; the checker does not add Vite or Kit to its own dependencies. Changed
preprocessor output must include a source map. Standalone `svelte.config.*`
files and SvelteKit 2 are unsupported. Svelte 5 component libraries without a
Vite config still work.

Vite 8 loads its installed Rolldown native binding even with the native config
loader. The child process allows native access to the project's dependency
directories. Checking uses a temporary `nodeModulesDir: "manual"` config when
Svelte is installed, which lets Deno's LSP resolve package imports such as
`#lib`. The project's config and lockfile stay unchanged.

The checker consumes existing generated route declarations. Kit 3's own
`svelte-kit sync` currently needs a TypeScript package to generate route
`$types`; without it, Kit silently skips that step. This checker does not
replace Kit's generator or install TypeScript. Preprocessors and project
configuration may also have their own dependencies.

## Scope

- Supports Svelte 5's modern parser and SvelteKit 3 configuration. Svelte 5's
  supported legacy component syntax remains available. Older Svelte or Kit
  versions, declaration emission and editor features such as completion/rename
  are outside this CLI's scope.
- Source discovery and local dependency traversal cover `.svelte`, `.ts`, `.js`,
  `.mts`, `.cts`, `.mjs`, and `.cjs`. JSX/TSX files are outside this CLI's
  scope. Svelte components generate plain TypeScript for checking; they do not
  need JSX.
- A slot outlet inside a snippet or component-child callback currently produces
  an explicit unsupported-feature error. Scoped outlets in ordinary
  each/if/await blocks retain their inferred types.
- JSDoc handling covers `@type`, `@typedef`, `@property`, `@param`, and
  `@return`/`@returns`; it is not a full Closure/JSDoc implementation.
- Legacy forwarded events use broad event types unless the component provides an
  explicit `$$Events` interface or a typed event dispatcher. Action-added
  element attributes have not been ported.
- Local components under the workspace participate in checking, including
  config-excluded components imported by selected files. Explicit file/glob
  arguments restrict which files receive diagnostics; `--ignore` also suppresses
  diagnostics in matching imported files. Package-provided components should
  supply published type declarations. The scanner skips symlinks, package/build
  directories and declaration files as diagnostic roots. It does not read
  `.gitignore`, expand external project references, or fetch remote
  configuration inheritance.
- Deno's checking rules and module resolver can differ from upstream
  `svelte-check`. The tests establish the covered behavior; they do not
  establish parity for the complete upstream test suite.
- In Deno 2.9.6, setting `baseUrl` can prevent `rootDirs` from resolving
  generated route types. The checker preserves that setting; configs using
  `paths` and `rootDirs` without `baseUrl` pass the regression tests.

Unsupported transformations fail explicitly. Unexpected errors in generated
checking code also fail the check, rather than producing a false clean result.

## Develop and test

```sh
deno task check
deno task lint
deno task test
deno task fmt
```

The suite uses `Deno.test`, including upstream script and template fixture
ports, the original CLI success/error projects and large-output flush test, real
Deno type checks, LSP protocol/process failure cases, end-to-end diagnostics,
source mapping, configuration selection, CLI status codes, and watch updates.
The dependency test rejects lockfiles that add a separate TypeScript compiler or
the old language-tools runtime.

Fixtures under `tests/fixtures/upstream-script`, `upstream-template` and
`upstream-cli` come from `sveltejs/language-tools` commit
`f03e56672ed174e7042334a3237fe8569cfbf8f1`. Each directory contains the upstream
MIT license and a provenance note. The ports assert behavior and source
positions; upstream generated-code snapshots describe a different emitter and
are not compatible with this implementation.

## Release

Run `deno task publish:check`, update both `deno.json` and `src/version.ts` when
changing the version, and commit the release. Push the commit and wait for CI,
then create and push its matching version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

CI runs format, lint, type, test, and publish dry-run checks on Linux and macOS.
The tag workflow repeats those checks, verifies that the tag matches the package
and CLI versions, and publishes to JSR using GitHub OIDC with provenance. Only
the publish job has `id-token: write`; no stored JSR token is needed.

The JSR package must link to `bonakodo/svelte-check` in its package settings for
OIDC publishing. Branch pushes and pull requests only run CI. If a publish run
fails before uploading the version, fix the cause and rerun the failed workflow
job. Published versions are immutable.

The package includes the worker, runtime config, lockfile, and third-party
license notices. Tests, fixtures, local outputs, and CI files are excluded.

## License

MIT; see [LICENSE](./LICENSE). Vendored helpers retain their upstream notices
under `src/vendor`.
