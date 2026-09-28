import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { transformKitModule } from "../src/kit.ts";
import { check } from "../src/checker.ts";
import { mapRange, positionAt } from "../src/transform/writer.ts";

Deno.test("Kit modules retain option diagnostic locations", () => {
  const source =
    "export const ssr = 'invalid';\nexport const prerender = 'auto';";
  const result = transformKitModule(source, "/src/routes/+page.ts")!;
  assertStringIncludes(result.code, "ssr: boolean = 'invalid'");
  assertStringIncludes(result.code, "prerender: boolean | 'auto'");
  const start = result.code.indexOf("ssr");
  assertEquals(
    mapRange(result.code, source, result.segments, {
      start: positionAt(result.code, start),
      end: positionAt(result.code, start + 3),
    }),
    { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } },
  );
  assertEquals(transformKitModule(source, "/src/ordinary.ts"), undefined);
});

Deno.test("Kit modules respect explicit annotations and named aliases", () => {
  const source =
    "const handle = event => new Response(event.url.pathname); export {handle as GET};";
  assertStringIncludes(
    transformKitModule(source, "+server.ts")!.code,
    "(event: import('./$types.js').RequestEvent)",
  );
  assertEquals(
    transformKitModule("export const ssr: string = 'custom';", "+page.ts"),
    undefined,
  );
  assertEquals(
    transformKitModule(
      "export function GET(event: MyEvent): CustomResult {return event.result}",
      "+server.ts",
    ),
    undefined,
  );
  assertEquals(
    transformKitModule("export const GET = broken => (", "+server.ts"),
    undefined,
  );
});

Deno.test("Deno checks generated Kit server, loader, actions and route option types", async () => {
  const directory = await Deno.makeTempDir({ prefix: "kit-module-test-" });
  try {
    await Deno.writeTextFile(
      `${directory}/$types.js`,
      '// @ts-self-types="./$types.d.ts"\nexport {};',
    );
    await Deno.writeTextFile(
      `${directory}/$types.d.ts`,
      `export interface RequestEvent {url:URL;request:Request;params:{slug:string}}\nexport interface PageLoadEvent {params:{slug:string}}\nexport type PageServerLoadEvent=PageLoadEvent;\nexport type PageLoad=(event:PageLoadEvent)=>{title:string};\nexport type PageServerLoad=PageLoad;\nexport type Actions=Record<string,(event:RequestEvent)=>Promise<{ok:boolean}>>;`,
    );
    const cases = [
      {
        file: "+server.ts",
        source:
          `export async function GET({url}) { return new Response(url.pathname); }\nexport const POST = event => new Response(event.params.slug);\nexport const DELETE = async ({request}) => new Response(await request.text());`,
      },
      {
        file: "+page.ts",
        source:
          `export const ssr=true; export const csr=false; export const prerender='auto'; export const trailingSlash='never'; export const load=({params})=>({title:params.slug});`,
      },
      {
        file: "+page.server.ts",
        source:
          `export const load=({params})=>({title:params.slug}); export const actions={default:async({request})=>({ok:(await request.text()).length>0})};`,
      },
      {
        file: "+page@admin.ts",
        source: `export function load({params}){return {title:params.slug};}`,
      },
      {
        file: "+server.js",
        source:
          `// @ts-check\n/** @type {string} */ const explicit='ok';\nexport async function GET({url}) { return new Response(explicit+url.pathname); }\nexport const POST = event => new Response(event.request.url);`,
      },
      {
        file: "+page.js",
        source:
          `// @ts-check\nexport const ssr=true; export const prerender='auto'; export function load({params}) {return {title:params.slug}}`,
      },
    ];
    for (const item of cases) {
      await Deno.writeTextFile(
        `${directory}/${item.file}`,
        transformKitModule(item.source, item.file)!.code,
      );
    }
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        ...cases.map((c) => `${directory}/${c.file}`),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const bad =
      "export const ssr='invalid'; export function GET(event){return event.url.pathname;}";
    await Deno.writeTextFile(
      `${directory}/bad.ts`,
      transformKitModule(bad, "+server.ts")!.code,
    );
    const errors = await new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        `${directory}/bad.ts`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(!errors.success);
    const text = new TextDecoder().decode(errors.stderr);
    assertStringIncludes(text, "TS2322");
    assertStringIncludes(text, "boolean");
    assertStringIncludes(text, "Response");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("checker preserves JS route JSDoc and maps auto route errors", async () => {
  const directory = await Deno.makeTempDir({ prefix: "kit-js-checker-" });
  try {
    await Deno.writeTextFile(
      `${directory}/deno.json`,
      JSON.stringify({
        imports: { svelte: "npm:svelte@5.57.0" },
        compilerOptions: {
          strict: true,
          checkJs: true,
          lib: ["esnext", "dom", "dom.iterable"],
        },
      }),
    );
    await Deno.writeTextFile(
      `${directory}/$types.d.ts`,
      "export interface RequestEvent {url:URL;request:Request;params:{slug:string}}",
    );
    const server =
      `/** @type {string} */\nconst title = 123;\nexport async function GET({url}) {\n  return new Response(title + url.pathname);\n}\nexport const POST = ({request}) => new Response(request.url);\n`;
    const page =
      "export const ssr = 'invalid';\nexport const prerender = 'auto';\n";
    await Deno.writeTextFile(`${directory}/+server.js`, server);
    await Deno.writeTextFile(`${directory}/+page.js`, page);
    const result = await check({ workspace: directory, config: "deno.json" });
    assertEquals(result.errorCount, 2, JSON.stringify(result.diagnostics));
    assertEquals(
      result.diagnostics.map((d) => ({
        file: d.file.split("/").at(-1),
        code: d.code,
        start: d.range.start,
      })),
      [
        { file: "+page.js", code: 2322, start: { line: 0, character: 13 } },
        { file: "+server.js", code: 2322, start: { line: 1, character: 6 } },
      ],
    );
    assert(result.diagnostics.every((d) => !d.message.includes("generated")));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
