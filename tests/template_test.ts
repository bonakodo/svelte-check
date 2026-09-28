import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { parse } from "svelte/compiler";
import { HELPERS } from "../src/transform/helpers.ts";
import {
  emitTemplate,
  UnsupportedTemplateError,
} from "../src/transform/template.ts";
import { CodeWriter, mapRange, positionAt } from "../src/transform/writer.ts";

function generated(template: string, script = ""): string {
  const source = '<script lang="ts"></script>' + template;
  const writer = new CodeWriter(source);
  writer.append(HELPERS + "\nfunction render() {\n" + script + "\n");
  emitTemplate(parse(source, { modern: true }), source, writer);
  writer.append("}\n");
  return writer.code;
}

async function check(
  code: string,
): Promise<{ success: boolean; output: string }> {
  const directory = await Deno.makeTempDir({ prefix: "svelte-template-test-" });
  try {
    await Deno.writeTextFile(
      directory + "/deno.json",
      JSON.stringify({
        imports: { svelte: "npm:svelte@5.57.0" },
        compilerOptions: {
          strict: true,
          lib: ["dom", "dom.iterable", "esnext"],
        },
        nodeModulesDir: "none",
      }),
    );
    await Deno.writeTextFile(directory + "/component.ts", code);
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--quiet",
        "--config",
        directory + "/deno.json",
        directory + "/component.ts",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      success: result.success,
      output: new TextDecoder().decode(result.stderr),
    };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("modern template lowering preserves block inference and DOM event types", async () => {
  const result = await check(generated(
    `
    {#if value !== null}{value.toUpperCase()}{/if}
    {#each rows as {count}, i (count)}
      {@const formatted=count.toFixed()}{formatted}{i.toFixed()}
    {:else}Empty{/each}
    {#await promise then item}{item.toFixed()}{:catch error}{error.message}{/await}
    <input bind:value={text}/>
    <input type="number" bind:value={numeric}/>
    <button onclick={event => event.currentTarget.disabled = true}>OK</button>
    <p class:active={text} style:color={text} use:action={1} transition:transition={{duration: 20}} />
    {#snippet label(value: number)}{value.toFixed()}{/snippet}
    {@render label(2)}
    <svelte:boundary>{#snippet failed(error, reset)}
      {String(error)}<button onclick={reset}>Retry</button>
    {/snippet}</svelte:boundary>
  `,
    `
    let value:string|null=Math.random()?"x":null;
    let text=""; let numeric:number|undefined=0;
    const rows=[{count:1}]; const promise=Promise.resolve(4);
    function action(node: HTMLParagraphElement, params: number) {}
    function transition(node: Element, params: {duration: number}) { return {duration: params.duration}; }
  `,
  ));
  assert(result.success, result.output);
});

Deno.test("modern template lowering reports each, await, binding and event mistakes", async () => {
  const result = await check(generated(
    `
    {#each rows as row}{row.missing}{/each}
    {#await promise then item}{item.toUpperCase()}{/await}
    <input type="number" bind:value={text}/>
    <button onclick={event => event.currentTarget.noSuchProperty}>OK</button>
    {#snippet label(value: number)}{value.toFixed()}{/snippet}
    {@render label("bad")}
  `,
    `let text=""; const rows=[{count:1}]; const promise=Promise.resolve(4);`,
  ));
  assert(!result.success);
  for (
    const error of [
      "missing",
      "toUpperCase",
      "not assignable to type 'string'",
      "noSuchProperty",
      "not assignable to parameter of type 'number'",
    ]
  ) {
    assertStringIncludes(result.output, error);
  }
});

Deno.test("component snippets get their parameter types from component props", async () => {
  const script = `
    const Table = null! as import("svelte").Component<{ rows: number[], row: import("svelte").Snippet<[number]> }>;
  `;
  const valid = await check(
    generated(
      `<Table rows={[1]}>{#snippet row(item)}{item.toFixed()}{/snippet}</Table>`,
      script,
    ),
  );
  assert(valid.success, valid.output);
  const invalid = await check(
    generated(
      `<Table rows={[1]}>{#snippet row(item)}{item.toUpperCase()}{/snippet}</Table>`,
      script,
    ),
  );
  assert(!invalid.success);
  assertStringIncludes(invalid.output, "toUpperCase");
});

Deno.test("component attributes check required props and reject invalid prop types", async () => {
  const result = await check(generated(
    `<Child count="bad"/><Child/>`,
    `
    const Child = null! as import("svelte").Component<{count: number}>;
  `,
  ));
  assert(!result.success);
  assertStringIncludes(result.output, "not assignable to type 'number'");
  assertStringIncludes(result.output, "Property 'count' is missing");
});

Deno.test("legacy slot let scopes use the child component's slot types", async () => {
  const result = await check(
    generated(
      `<Child let:count>{count.toFixed()}</Child>`,
      `
    const Child = null! as import("svelte").Component<{}> & {$$slot_def: {default: {count:number}}};
  `,
    ),
  );
  assert(result.success, result.output);
});

Deno.test("unsupported snippet slot outlets fail explicitly", () => {
  assertThrows(
    () =>
      generated(`{#snippet example(count: number)}<slot {count}/>{/snippet}`),
    UnsupportedTemplateError,
    "slot outlets inside snippet",
  );
});

Deno.test("scoped slots retain each, await, const and branch narrowing in public types", async () => {
  const template = `<div>{#each items as item, index}
    {#if item.value !== null}{@const text = item.value.toUpperCase()}
      {#await Promise.resolve(text) then resolved}<slot {resolved} {index}/>{/await}
    {:else}<slot resolved="fallback" {index}/>{/if}
  {/each}</div>`;
  const code = generated(
    template,
    `const items=[{value: Math.random() ? 'hello' : null}];`,
  )
    .replace(
      /\}\n$/,
      `__sv_slots.default.resolved.toUpperCase(); __sv_slots.default.index.toFixed();\n}\n`,
    );
  const valid = await check(code);
  assert(valid.success, valid.output);
  const invalid = await check(
    code.replace(
      "__sv_slots.default.resolved.toUpperCase()",
      "__sv_slots.default.resolved.toFixed()",
    ),
  );
  assert(!invalid.success);
  assertStringIncludes(invalid.output, "toFixed");
});

Deno.test("sibling snippets retain concrete and generic parameter types", async () => {
  const script = `
    type Props<T> = {data:T[], row:import('svelte').Snippet<[T]>, children?:import('svelte').Snippet};
    const List = null! as <T>(anchor: unknown, props: Props<T>) => {$$prop_def: Props<T>};
  `;
  const template =
    `<List data={[1,2]}>{#snippet row(item)}{item.toFixed()}{/snippet}<button onclick={() => row(2)}>Run</button></List>`;
  const valid = await check(generated(template, script));
  assert(valid.success, valid.output);
  const invalid = await check(
    generated(template.replace("row(2)", 'row("wrong")'), script),
  );
  assert(!invalid.success);
  assertStringIncludes(
    invalid.output,
    "not assignable to parameter of type 'number'",
  );
});

const upstreamCases = [
  {
    name: "each-block-key-else",
    script: "const items=[{id:1}];",
    token: "item.id",
  },
  {
    name: "each-block-optional-chaining",
    script:
      "const someObject: {items:number[]}|undefined = Math.random() ? {items:[1]} : undefined;",
    token: "someObject?.items",
  },
  {
    name: "await-block-destruct-array",
    script: "const thePromise=Promise.resolve([1,2]);",
    token: "thePromise",
  },
  {
    name: "await-block-destruct-rest",
    script:
      "const object=Promise.resolve({a:1,b:2}); const array=Promise.resolve([1,2,3]); const objectReject=object; const arrayReject=array;",
    token: "{ a, ...rest }",
  },
  {
    name: "if-block-const",
    script:
      "const name='world'; const a:string|number = Math.random() ? 'yes' : 4;",
    token: 'name == "world"',
  },
  {
    name: "if-else-if-nullish-coalescing",
    script:
      "const name1:string|null=Math.random()?'world':null; const name2='x'; const name3=name1; const name4='y';",
    token: 'name3 ?? "blubb"',
  },
  {
    name: "binding-this",
    script: "let element:HTMLInputElement;",
    token: "element",
  },
  {
    name: "binding-this-get-set.v5",
    script:
      "let v:HTMLDivElement; function set(value:HTMLDivElement){}; const Input=null! as import('svelte').Component<{}, HTMLDivElement>;",
    token: "new_v => v = new_v",
  },
];

for (const fixture of upstreamCases) {
  Deno.test(`upstream htmlx2jsx: ${fixture.name} checks and maps source ranges`, async () => {
    const source = await Deno.readTextFile(
      new URL(
        `./fixtures/upstream-template/${fixture.name}.svelte`,
        import.meta.url,
      ),
    );
    const writer = new CodeWriter(source);
    writer.append(HELPERS + "\nfunction render() {\n" + fixture.script + "\n");
    emitTemplate(parse(source, { modern: true }), source, writer);
    writer.append("}\n");
    const result = await check(writer.code);
    assert(result.success, result.output);
    const original = source.indexOf(fixture.token);
    assert(original >= 0);
    const segment = writer.segments.find((s) =>
      original >= s.originalStart &&
      original + fixture.token.length <= s.originalEnd &&
      writer.code.slice(s.generatedStart, s.generatedEnd) ===
        source.slice(s.originalStart, s.originalEnd)
    );
    assert(segment, `No exact source segment for ${fixture.token}`);
    const generatedStart = segment.generatedStart + original -
      segment.originalStart;
    assertEquals(
      mapRange(writer.code, source, writer.segments, {
        start: positionAt(writer.code, generatedStart),
        end: positionAt(writer.code, generatedStart + fixture.token.length),
      }),
      {
        start: positionAt(source, original),
        end: positionAt(source, original + fixture.token.length),
      },
    );
  });
}

Deno.test("generic component snippets retain relationships to data props", async () => {
  const script =
    `const List = null! as <T>(anchor: unknown, props: {data:T[], row:import('svelte').Snippet<[T]>}) => {};`;
  const valid = await check(
    generated(
      `<List data={[1,2]}>{#snippet row(item)}{item.toFixed()}{/snippet}</List>`,
      script,
    ),
  );
  assert(valid.success, valid.output);
  const invalid = await check(
    generated(
      `<List data={[1,2]}>{#snippet row(item)}{item.toUpperCase()}{/snippet}</List>`,
      script,
    ),
  );
  assert(!invalid.success);
  assertStringIncludes(invalid.output, "toUpperCase");
});

Deno.test("optional render accepts absent snippets but still checks argument types", async () => {
  const script =
    `let optional:import('svelte').Snippet<[number]>|undefined = Math.random() ? null! as import('svelte').Snippet<[number]> : undefined;`;
  const valid = await check(generated(`{@render optional?.(1)}`, script));
  assert(valid.success, valid.output);
  const invalid = await check(generated(`{@render optional?.("bad")}`, script));
  assert(!invalid.success);
  assertStringIncludes(
    invalid.output,
    "not assignable to parameter of type 'number'",
  );
});

Deno.test("nullable dynamic components check props against the non-null component", async () => {
  const script =
    `const Child=null! as import('svelte').Component<{count:number}>;`;
  const valid = await check(
    generated(
      `<svelte:component this={Math.random()?Child:null} count={2}/><svelte:component this={undefined}/>`,
      script,
    ),
  );
  assert(valid.success, valid.output);
  const invalid = await check(
    generated(
      `<svelte:component this={Math.random()?Child:null} count="bad"/><svelte:component this={42}/>`,
      script,
    ),
  );
  assert(!invalid.success);
  assertStringIncludes(invalid.output, "not assignable to type 'number'");
  assertStringIncludes(invalid.output, "Argument of type '42'");
});

Deno.test("component events use known payloads and allow untyped custom events", async () => {
  const script = `
    const Typed=null! as import('svelte').Component<{}> & {$$events_def:{saved:CustomEvent<number>}};
    const Untyped=null! as import('svelte').Component<{}>;
  `;
  const valid = await check(
    generated(
      `<Typed on:saved={e=>e.detail.toFixed()}/><Untyped on:changed={e=>e.detail.anything}/>`,
      script,
    ),
  );
  assert(valid.success, valid.output);
  const invalid = await check(
    generated(`<Typed on:saved={e=>e.detail.toUpperCase()}/>`, script),
  );
  assert(!invalid.success);
  assertStringIncludes(invalid.output, "toUpperCase");
});

Deno.test("attachments allow falsy values and check their element and return types", async () => {
  const script = `const enabled = Math.random() > .5;`;
  const valid = await check(
    generated(
      `<input {@attach enabled && (element => {element.value='ok'; return () => {};})}/>`,
      script,
    ),
  );
  assert(valid.success, valid.output);
  const invalid = await check(
    generated(
      `<input {@attach element => element.notAnInputProperty}/>`,
      script,
    ),
  );
  assert(!invalid.success);
  assertStringIncludes(invalid.output, "notAnInputProperty");
});

Deno.test("action and transition result types cannot silently become invalid", async () => {
  const result = await check(
    generated(
      `<div use:badAction transition:badTransition/>`,
      `
    const badAction = (element: HTMLDivElement) => 42;
    const badTransition = (element: Element) => 'wrong';
  `,
    ),
  );
  assert(!result.success);
  assertStringIncludes(result.output, "ActionReturn");
  assertStringIncludes(result.output, "TransitionConfig");
});

Deno.test("binding a store value requires a writable store", async () => {
  const result = await check(generated(
    `<input bind:value={$value}/>`,
    `
    const value = {subscribe(callback:(value:string)=>void){return ()=>{};}};
    let $value=__sv_store_get(value);
  `,
  ));
  assert(!result.success);
  assertStringIncludes(result.output, "Property 'set' is missing");
});
