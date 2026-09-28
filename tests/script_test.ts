import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "svelte/compiler";
import {
  emitScriptEnd,
  emitScriptStart,
  type ScriptOptions,
} from "../src/transform/script.ts";
import { CodeWriter } from "../src/transform/writer.ts";

function lower(source: string, options: ScriptOptions = {}, template = "") {
  const writer = new CodeWriter(source);
  const info = emitScriptStart(
    parse(source, { modern: true }),
    source,
    writer,
    options,
  );
  writer.append(template);
  emitScriptEnd(info, writer);
  return { code: writer.code, info, segments: writer.segments };
}

async function fixture(name: string) {
  return lower(
    await Deno.readTextFile(
      new URL(`./fixtures/upstream-script/${name}.svelte`, import.meta.url),
    ),
  );
}

Deno.test("upstream: renamed exports keep public names and optional defaults", async () => {
  const { info, code } = await fixture("renamed-exports");
  assertEquals(info.props.map((p) => [p.name, p.local, p.optional]), [
    ["name3", "name", true],
    ["name4", "name2", true],
  ]);
  assertStringIncludes(code, '"name3"?: typeof name');
  assert(!code.includes("export { name as"));
});

Deno.test("upstream: typed exports retain required and optional props", async () => {
  const { info, code } = await fixture("ts-export-has-type");
  assertEquals(info.props.map((p) => [p.name, p.optional]), [["a", false], [
    "b",
    true,
  ]]);
  assertStringIncludes(code, "let a: A = null!");
  assertStringIncludes(code, '"a": A;"b"?: A;');
});

Deno.test("upstream: reactive declarations gain bindings but assignments keep bindings", async () => {
  const { code } = await fixture("reactive-declare");
  assertStringIncludes(code, "let b = 7;");
  assertStringIncludes(code, "a = 5;");
  assert(!code.includes("let a = 5"));
});

Deno.test("upstream: reactive declarations support nested destructuring and defaults", async () => {
  const { code } = await fixture("reactive-declare-destructuring");
  assertStringIncludes(code, "let { a } = { a: '' };");
  assertStringIncludes(code, "let { c: { length } } = { c: '' };");
  assertStringIncludes(code, "let { b: g = 1} = { b: 1 };");
});

Deno.test("upstream: imported stores include aliases and template-only reads", async () => {
  const { code } = await fixture("store-import");
  assertStringIncludes(code, "let $storeA = __sv_store_get(storeA);");
  assertStringIncludes(code, "let $storeB = __sv_store_get(storeB);");
  assertStringIncludes(code, "let $storeC = __sv_store_get(storeC);");
  assert(code.indexOf("import storeA") < code.indexOf("function __sv_render"));
});

Deno.test("upstream: runes props retain local and module type dependencies", async () => {
  const { code, info } = await fixture("ts-runes-hoistable-props-2.v5");
  assert(info.runes);
  assertStringIncludes(code, "{} as { a: Dependency, b: string }");
  assert(code.indexOf("let value = 1") < code.indexOf("function __sv_render"));
});

Deno.test("upstream: export lists distinguish mutable props from component APIs", async () => {
  const { info } = await fixture("export-list");
  assertEquals(info.props.map((p) => p.name), [
    "name1",
    "name2",
    "renamed1",
    "renamed2",
  ]);
  assertEquals(info.exports.map((p) => p.name), [
    "Foo",
    "bar",
    "baz",
    "RenamedFoo",
    "renamedbar",
    "renamedbaz",
  ]);
});

Deno.test("upstream: boolean defaults widen and required JS props remain any", async () => {
  const boolean = await fixture("ts-export-boolean");
  assert(boolean.info.props.every((p) => p.optional));
  assertStringIncludes(boolean.code, '"bla"?: boolean');
  assertStringIncludes(boolean.code, "bla = null! as any;");
  const required = await fixture("export-js-required-props");
  assertEquals(required.info.props.map((p) => [p.name, p.optional]), [
    ["a", false],
    ["b", false],
    ["c", true],
  ]);
  assertStringIncludes(required.code, "let a: any = null!");
});

Deno.test("upstream: rune calls do not create store subscriptions for local names", async () => {
  const { code } = await fixture("runes-looking-like-stores.v5");
  assert(!code.includes("__sv_store_get("));
  assertStringIncludes(code, "$state(0)");
  assertStringIncludes(code, "$derived(state * 2)");
});

Deno.test("upstream: JSDoc rune props keep generic constraints and typedef imports", async () => {
  const { code } = await fixture("jsdoc-various.v5");
  assertStringIncludes(code, "let { b }: { b: T } = $props()");
  assertStringIncludes(code, "props: {} as { b: T }");
  const imported = await fixture("js-jsdoc-before-first-import");
  assertStringIncludes(imported.code, "type Foo = { a: string }");
});

Deno.test("upstream: reactive blocks preserve scope and casts preserve types", async () => {
  const block = await fixture("reactive-block");
  assertStringIncludes(block.code, "{\n    console.log(a + 1);\n}");
  const cast = await fixture("reactive-assignment-type-cast");
  assertStringIncludes(
    cast.code,
    'let team = { search: "Real", players: [] } as Team;',
  );
});

Deno.test("upstream: module stores stay in module scope and subscribe inside render", async () => {
  const { code } = await fixture("store-from-module");
  assert(code.indexOf("const store3") < code.indexOf("function __sv_render"));
  for (const name of ["store1", "store2", "store3", "store4"]) {
    assertStringIncludes(code, `let $${name} = __sv_store_get(${name});`);
  }
});

Deno.test("SvelteKit 3 uses generated route props without replacing user types", () => {
  const page = lower(
    `<script>let { data, form, params } = $props();</script>`,
    { kit: "page" },
  );
  assertStringIncludes(
    page.code,
    `let { data, form, params }: import('./$types.js').PageProps = $props()`,
  );
  const layout = lower(`<script>export let data;</script>`, { kit: "layout" });
  assertStringIncludes(
    layout.code,
    `let data: import('./$types.js').LayoutData = null!`,
  );
  const error = lower(`<script>let { error } = $props();</script>`, {
    kit: "error",
  });
  assertStringIncludes(error.code, `: import('./$types.js').ErrorProps`);
  const layoutRunes = lower(
    `<script>let { children, ...rest } = $props();</script>`,
    { kit: "layout" },
  );
  assertStringIncludes(layoutRunes.code, `: import('./$types.js').LayoutProps`);
  assert(!layoutRunes.code.includes("Record<string, any>"));
  const explicit = lower(
    `<script lang="ts">let {data}: {data:string} = $props();</script>`,
    { kit: "page" },
  );
  assert(!explicit.code.includes("$types"));
});

Deno.test("Deno checks Kit 3 route props, error.status and pages without actions", async () => {
  const directory = await Deno.makeTempDir({ prefix: "svelte-kit-script-" });
  try {
    const cases: {
      source: string;
      options: ScriptOptions;
      template: string;
      noServer?: boolean;
    }[] = [
      {
        source: "<script>let {data,form,params}=$props();</script>",
        options: { kit: "page" },
        template:
          `data.title.toUpperCase(); form.ok.valueOf(); params.slug.toUpperCase();\n// @ts-expect-error page title is string\ndata.title.toFixed();`,
      },
      {
        source: "<script>export let data;</script>",
        options: { kit: "layout" },
        template:
          `data.title.toFixed();\n// @ts-expect-error layout title is numeric\ndata.title.toUpperCase();`,
      },
      {
        source: "<script>let {error}=$props();</script>",
        options: { kit: "error" },
        template:
          `error.message.toUpperCase(); error.status.toFixed();\n// @ts-expect-error error is typed\nerror.missing;`,
      },
      {
        source: "<script>let props=$props();</script>",
        options: { kit: "error" },
        template:
          `props.error.status.toFixed();\n// @ts-expect-error Kit 3 removed the separate status prop\nprops.status;`,
      },
      {
        source: "<script>let {children,...rest}=$props();</script>",
        options: { kit: "layout" },
        template:
          `children(); rest.data.title.toFixed(); rest.params.slug.toUpperCase();\n// @ts-expect-error children is a snippet without parameters\nchildren(1);\n// @ts-expect-error remaining props have the generated shape\nrest.unknown;`,
      },
      {
        source: "<script>let props=$props();</script>",
        options: { kit: "page" },
        noServer: true,
        template:
          `props.data.title.toUpperCase();\n// @ts-expect-error pages without a server module have no form prop\nprops.form;`,
      },
    ];
    for (const [i, item] of cases.entries()) {
      await Deno.mkdir(`${directory}/${i}`);
      await Deno.writeTextFile(
        `${directory}/${i}/$types.js`,
        '// @ts-self-types="./$types.d.ts"\nexport {};\n',
      );
      // Shapes from @sveltejs/kit 3.0.0-next.27 write_types/index.js and
      // ambient.d.ts. Keep each route separate, as Kit generates these types.
      await Deno.writeTextFile(
        `${directory}/${i}/$types.d.ts`,
        `declare global { namespace App { interface Error { message:string; status:number; } } }
export interface PageData { title:string; }
export interface LayoutData { title:number; }
export interface ActionData { ok:boolean; }
export type PageProps = { data:PageData; params:{slug:string}; ${
          item.noServer ? "" : "form:ActionData;"
        } };
export type LayoutProps = { data:LayoutData; params:{slug:string}; children:import('svelte').Snippet };
export type ErrorProps = { error:App.Error };
export interface Snapshot { capture():unknown; restore(value:unknown):void }`,
      );
      const { code } = lower(item.source, item.options, item.template);
      await Deno.writeTextFile(
        `${directory}/${i}/test.ts`,
        `import "svelte";\n${code}`,
      );
    }
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        ...cases.map((_, i) => `${directory}/${i}/test.ts`),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("reactive dependencies sort before reads, including store subscriptions", () => {
  const { code } = lower(`<script>
    $: doubled = value * 2;
    $: value = 4;
    $: result = $derivedStore;
    $: derivedStore = { subscribe(run) { run(doubled); } };
  </script>`);
  assert(
    code.indexOf("let value = 4") < code.indexOf("let doubled = value * 2"),
  );
  assert(
    code.indexOf("let derivedStore =") < code.indexOf("let $derivedStore ="),
  );
  assert(code.indexOf("let $derivedStore =") < code.indexOf("let result ="));
  const declared =
    lower(`<script>let a; $: b = a + 1; $: a = 2;</script>`).code;
  assert(declared.indexOf("a = 2") < declared.indexOf("let b = a + 1"));
});

Deno.test("generic parameters use Svelte's parser for nested defaults", () => {
  const { code, info } = lower(
    `<script lang="ts" generics="T extends { a: string, b: number }, U = (x: T) => T">
    let { value, fn }: {value: T, fn: U} = $props();
  </script>`,
  );
  assertEquals(info.genericNames, ["T", "U"]);
  assertStringIncludes(code, 'ReturnType<typeof __sv_render<T,U>>["props"]');
});

Deno.test("JSDoc annotations check JS scripts and preserve user suppression comments", () => {
  const { code } = lower(`<script>
    /** @type {string | undefined} */
    export let name;
    /** @param {number} value @returns {string} */
    function label(value) { return String(value); }
    // @ts-expect-error intentional regression fixture
    label('bad');
  </script>`);
  assertStringIncludes(code, "let name: string | undefined = null!");
  assertStringIncludes(code, "function label(value: number) : string");
  assertStringIncludes(
    code,
    "// @ts-expect-error intentional regression fixture",
  );
  assertStringIncludes(code, '"name": string | undefined');
});

Deno.test("copied source ranges preserve script diagnostic locations", () => {
  const source =
    `<script lang="ts">export let count: number = 'wrong';</script>`;
  const { code, segments } = lower(source);
  const generated = code.indexOf("'wrong'");
  const segment = segments.find((s) =>
    generated >= s.generatedStart && generated < s.generatedEnd
  )!;
  assertEquals(
    segment.originalStart + generated - segment.generatedStart,
    source.indexOf("'wrong'"),
  );
});

Deno.test("Deno checks script props, generic calls, JSDoc and store types", async () => {
  const sources = [
    `<script lang="ts">export let name: string; export let count = 1;</script>`,
    `<script lang="ts" generics="T extends {id: string}">let {value}: {value:T} = $props();</script>`,
    `<script>/** @type {number} */ export let count; /** @param {number} n @returns {number} */ function twice(n) { return n * 2; } const value = twice(count);</script>`,
    `<script lang="ts">const count = {subscribe(run: (n:number)=>void) {run(1);}}; const value: number = $count;</script>`,
  ];
  const directory = await Deno.makeTempDir({ prefix: "svelte-script-test-" });
  try {
    for (const [i, source] of sources.entries()) {
      const { code } = lower(source);
      const calls = i === 0
        ? `\n__sv_component_export(null!, {name:'ok'});\n// @ts-expect-error wrong prop\n__sv_component_export(null!, {name:1});\n// @ts-expect-error missing prop\n__sv_component_export(null!, {});`
        : i === 1
        ? `\n__sv_component_export(null!, {value:{id:'ok',other:1}});\n// @ts-expect-error wrong generic constraint\n__sv_component_export(null!, {value:{id:1}});`
        : "";
      await Deno.writeTextFile(
        `${directory}/test${i}.ts`,
        `import "svelte";\ndeclare function __sv_store_get<T>(store: {subscribe(run:(value:T)=>void):unknown}):T;\n${code}${calls}`,
      );
    }
    const config = new URL("../deno.json", import.meta.url);
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--config",
        config.pathname,
        ...sources.map((_, i) => `${directory}/test${i}.ts`),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Deno checks widened props, JS typedefs, inferred defaults, module exports and stores", async () => {
  const cases = [
    {
      source:
        `<script lang="ts">export let enabled=false; export let value: string | undefined = '';</script>`,
      template:
        `\n// @ts-expect-error exported value can be undefined despite its default\nvalue.toUpperCase();`,
      calls:
        `__sv_component_export(null!, {enabled: true, value: undefined});\n// @ts-expect-error bool prop rejects strings\n__sv_component_export(null!, {enabled: 'true'});`,
    },
    {
      source: `<script>
      /** @typedef {Object} Props
       * @property {string} name
       * @property {number} [count]
       */
      /** @type {Props} */
      let { name, count = 0 } = $props();
      </script>`,
      template:
        `name.toUpperCase(); count.toFixed();\n// @ts-expect-error count is numeric\ncount.toUpperCase();`,
      calls:
        `__sv_component_export(null!, {name:'ok'});\n// @ts-expect-error name is required\n__sv_component_export(null!, {});`,
    },
    {
      source:
        `<script>let { title='name', count=0, enabled=false, entry={id:''} } = $props();</script>`,
      template:
        `title.toUpperCase(); count.toFixed(); entry.id.toUpperCase();\n// @ts-expect-error inferred numeric default\ncount.toUpperCase();`,
      calls:
        `__sv_component_export(null!, {enabled:true, count:2, entry:{id:'other'}});\n// @ts-expect-error inferred numeric default\n__sv_component_export(null!, {count:'wrong'});`,
    },
    {
      source:
        `<script module>/** @typedef {{id:string}} Item */\n/** @param {Item} item @returns {string} */\nexport function getId(item) { return item.id; }\n/** @type {number} */ export let count=1;</script>`,
      template: "",
      calls:
        `getId({id:'ok'});\n// @ts-expect-error exported API is typed\ngetId({id:1});`,
    },
    {
      source:
        `<script lang="ts">const state=$state(0); const derived=$derived(state*2); const store={subscribe(run:(n:number)=>void){run(1)},set(n:number){}}; $store=2;\n// @ts-expect-error store values are numeric\n$store='bad'; let existing; $: ({existing, created}={existing:1,created:'str'});</script>`,
      template:
        `existing.toFixed(); created.toUpperCase();\n// @ts-expect-error reactive let keeps inference\nexisting.toUpperCase();`,
      calls: "",
    },
    {
      source:
        `<script lang="ts">import {createEventDispatcher as make} from 'svelte'; const dispatch=make<{change:number}>(); dispatch('change',1);</script>`,
      template: "",
      calls:
        `const event: typeof __sv_component_export.$$events_def['change'] = new CustomEvent('change',{detail:1}); event.detail.toFixed();\n// @ts-expect-error event payload is numeric\nevent.detail.toUpperCase();`,
    },
    {
      source:
        `<script lang="ts">interface $$Events { loaded: Event; }</script>`,
      template: "",
      calls:
        `const event: typeof __sv_component_export.$$events_def['loaded'] = new Event('loaded');\n// @ts-expect-error explicit events do not add CustomEvent detail\nevent.detail;`,
    },
    {
      source: `<script>let {label='hello',...rest}=$props();</script>`,
      template: `label.toUpperCase(); rest.extra;`,
      calls:
        `__sv_component_export(null!, {label:'world',extra:123});\n// @ts-expect-error declared props remain typed with rest\n__sv_component_export(null!, {label:123});`,
    },
    {
      source:
        `<script lang="ts">interface $$Props {label:string; class?:string;} export let label:string;</script>`,
      template: `label.toUpperCase();`,
      calls:
        `__sv_component_export(null!, {label:'ok',class:'style'});\n// @ts-expect-error $$Props keeps required props\n__sv_component_export(null!, {class:'style'});`,
    },
  ];
  const directory = await Deno.makeTempDir({ prefix: "svelte-script-parity-" });
  try {
    for (const [i, item] of cases.entries()) {
      const { code } = lower(item.source, {}, item.template);
      await Deno.writeTextFile(
        `${directory}/test${i}.ts`,
        `import "svelte";\ndeclare function __sv_store_get<T>(store:{subscribe(run:(value:T)=>void):unknown}):T;\ndeclare function __sv_store_settable(store:{set:(...values:any[])=>unknown}):void;\n${code}\n${item.calls}`,
      );
    }
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        ...cases.map((_, i) => `${directory}/test${i}.ts`),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
