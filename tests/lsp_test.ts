import { DenoLsp, type LspDiagnostic } from "../src/lsp.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errors(diagnostics: LspDiagnostic[]): LspDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === 1);
}

function uri(root: string, name: string): string {
  const normalized = root.replaceAll("\\", "/");
  return new URL(
    name,
    `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)}/`,
  ).href;
}

async function rejects(
  operation: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(
      error instanceof Error && pattern.test(error.message),
      `Expected ${pattern}, received ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected an error matching ${pattern}`);
}

Deno.test("Deno LSP checks component overlays, import maps, Unicode and edits", async () => {
  const root = await Deno.makeTempDir({ prefix: "svelte-check-lsp-" });
  let client: DenoLsp | undefined;
  try {
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({
        imports: { "virtual-dep": "./dependency.ts" },
        compilerOptions: { strict: true },
      }),
    );
    const original =
      '<script lang="ts">export const value = 1;</script>\n<p>{value}</p>\n';
    await Deno.writeTextFile(`${root}/Child.svelte`, original);
    client = await DenoLsp.start({ root, timeoutMs: 15_000 });
    await client.open(
      uri(root, "Child.svelte"),
      "export const value: number = 1;\n",
    );
    await client.open(
      uri(root, "dependency.ts"),
      "export const value: number = 1;\n",
    );
    const invalid =
      'import { value } from "./Child.svelte";\nexport const emoji = "文字 🦕";\nexport const count: string = value;\n';
    const valid = invalid.replace("count: string", "count: number");
    await client.open(uri(root, "Parent.svelte"), invalid);
    await client.open(uri(root, "consumer.ts"), invalid);
    await client.open(uri(root, "valid.ts"), valid);
    await client.open(
      uri(root, "mapped.ts"),
      invalid.replace("./Child.svelte", "virtual-dep"),
    );
    for (const file of ["Parent.svelte", "consumer.ts", "mapped.ts"]) {
      const found = errors(await client.diagnostics(uri(root, file)));
      assert(
        found.length === 1 && found[0].code === 2322,
        `${file}: ${JSON.stringify(found)}`,
      );
      assert(
        found[0].range.start.line === 2,
        "Wrong generated source location",
      );
    }
    assert(
      errors(await client.diagnostics(uri(root, "valid.ts"))).length === 0,
      "Valid source did not pass",
    );
    await client.change(uri(root, "consumer.ts"), valid);
    assert(
      errors(await client.diagnostics(uri(root, "consumer.ts"))).length === 0,
      "Edit did not clear the error",
    );
    assert(
      await Deno.readTextFile(`${root}/Child.svelte`) === original,
      "LSP changed the original component",
    );
    await rejects(
      () => client!.change(uri(root, "unopened.ts"), ""),
      /not open/,
    );
    await client.close();
    await client.close();
    await rejects(() => client!.diagnostics(uri(root, "valid.ts")), /closed/);
  } finally {
    await client?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Deno LSP honors an explicit config outside the project", async () => {
  const temporary = await Deno.makeTempDir({
    prefix: "svelte-check-lsp-config-",
  });
  const root = `${temporary}/project`;
  let client: DenoLsp | undefined;
  try {
    await Deno.mkdir(root);
    await Deno.writeTextFile(
      `${temporary}/checker.json`,
      JSON.stringify({
        imports: { "external-dep": "./dependency.ts" },
        compilerOptions: { lib: ["dom", "esnext"], strict: true },
      }),
    );
    await Deno.writeTextFile(
      `${temporary}/dependency.ts`,
      "export const value: number = 1;\n",
    );
    client = await DenoLsp.start({
      root,
      config: `${temporary}/checker.json`,
      timeoutMs: 15_000,
    });
    const file = uri(root, "main.ts");
    await client.open(
      file,
      'import { value } from "external-dep";\nexport const element: HTMLElement = document.body;\nexport const count: string = value;\n',
    );
    const found = errors(await client.diagnostics(file));
    assert(
      found.length === 1 && found[0].code === 2322,
      `External config was not applied: ${JSON.stringify(found)}`,
    );
  } finally {
    await client?.close();
    await Deno.remove(temporary, { recursive: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function mockServer(root: string, source: string): Promise<string> {
  const script = `${root}/server.ts`;
  const executable = `${root}/deno-mock`;
  await Deno.writeTextFile(script, source);
  await Deno.writeTextFile(
    executable,
    `#!/bin/sh\nexec ${shellQuote(Deno.execPath())} run --no-config --no-lock ${
      shellQuote(script)
    }\n`,
  );
  await Deno.chmod(executable, 0o700);
  return executable;
}

const protocolServer = String.raw`
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function frame(value) {
  const body = encoder.encode(JSON.stringify({jsonrpc:'2.0', ...value}));
  const header = encoder.encode('content-length: ' + body.length + '\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n');
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header); bytes.set(body, header.length); return bytes;
}
async function respond(value) {
  // Coalesce a notification and response, then fragment every byte, including UTF-8.
  const note = frame({method:'window/logMessage',params:{type:4,message:'文字 🦕'}});
  const response = frame(value);
  const joined = new Uint8Array(note.length + response.length);
  joined.set(note); joined.set(response,note.length);
  for (let i=0;i<joined.length;i++) await Deno.stdout.write(joined.subarray(i,i+1));
}
let configuration = false;
let unsupported = false;
let unicodeSource = false;
const waiting = [];
let bytes = new Uint8Array();
for await (const part of Deno.stdin.readable) {
  const combined = new Uint8Array(bytes.length + part.length);
  combined.set(bytes); combined.set(part,bytes.length); bytes=combined;
  for (;;) {
    const text = decoder.decode(bytes);
    const split = text.indexOf('\r\n\r\n');
    if(split < 0) break;
    const size = Number(/Content-Length: (\d+)/i.exec(text.slice(0,split))[1]);
    const end = split+4+size;
    if(bytes.length < end) break;
    const message = JSON.parse(decoder.decode(bytes.subarray(split+4,end)));
    bytes=bytes.subarray(end);
    if(message.method === 'initialize') {
      await respond({id:message.id,result:{capabilities:{diagnosticProvider:{interFileDependencies:true}}}});
    } else if(message.method === 'initialized') {
      await respond({id:'config',method:'workspace/configuration',params:{items:[{section:'deno'}]}});
      await respond({id:'unknown',method:'fixture/unknown'});
    } else if(message.id === 'config') {
      configuration = message.result?.[0]?.enable === true && message.result?.[0]?.lint === false;
    } else if(message.id === 'unknown') {
      unsupported = message.error?.code === -32601;
    } else if(message.method === 'textDocument/didOpen') {
      unicodeSource = message.params.textDocument.text.includes('文字 🦕');
    } else if(message.method === 'textDocument/diagnostic') {
      waiting.push(message.id);
    } else if(message.method === 'shutdown') {
      await respond({id:message.id,result:null});
    } else if(message.method === 'exit') {
      Deno.exit(0);
    }
    if(configuration && unsupported && unicodeSource) {
      for(const id of waiting.splice(0)) {
        await respond({id,result:{kind:'full',items:[{severity:1,code:2322,message:'文字 🦕 é',range:{start:{line:0,character:0},end:{line:0,character:1}}}]}});
      }
    }
  }
}
`;

Deno.test({
  name: "LSP blocked writes time out and release the child process",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "svelte-check-lsp-write-" });
    let client: DenoLsp | undefined;
    try {
      const source =
        'await Deno.stdin.read(new Uint8Array(65536)); const body = JSON.stringify({jsonrpc:"2.0",id:1,result:{capabilities:{diagnosticProvider:{}}}}); await Deno.stdout.write(new TextEncoder().encode("Content-Length: " + body.length + "\\r\\n\\r\\n" + body)); setInterval(() => {}, 1000);';
      client = await DenoLsp.start({
        root,
        denoPath: await mockServer(root, source),
        timeoutMs: 500,
      });
      await rejects(
        () => client!.open(uri(root, "large.ts"), " ".repeat(2 * 1024 * 1024)),
        /timed out.*writing/,
      );
    } finally {
      await client?.close();
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "LSP framing handles fragmented UTF-8, server requests and concurrent writes",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "svelte-check-lsp-frame-" });
    let client: DenoLsp | undefined;
    try {
      client = await DenoLsp.start({
        root,
        denoPath: await mockServer(root, protocolServer),
        timeoutMs: 5_000,
      });
      await client.open(uri(root, "one.ts"), 'export const value = "文字 🦕";');
      const reports = await Promise.all(
        Array.from(
          { length: 5 },
          () => client!.diagnostics(uri(root, "one.ts")),
        ),
      );
      assert(
        reports.every((report) => report[0].message === "文字 🦕 é"),
        "UTF-8 content was corrupted",
      );
    } finally {
      await client?.close();
      await Deno.remove(root, { recursive: true });
    }
  },
});

for (
  const fixture of [
    {
      name: "early process exit includes stderr",
      source:
        'await Deno.stdin.read(new Uint8Array(65536)); console.error("fixture exit detail"); Deno.exit(7);',
      pattern: /exited unexpectedly[\s\S]*fixture exit detail/,
      timeoutMs: 2_000,
    },
    {
      name: "a blocked server times out and exits",
      source:
        "await Deno.stdin.read(new Uint8Array(65536)); setInterval(() => {}, 1000);",
      pattern: /timed out/,
      timeoutMs: 250,
    },
    {
      name: "malformed Content-Length fails promptly",
      source:
        'await Deno.stdin.read(new Uint8Array(65536)); await Deno.stdout.write(new TextEncoder().encode("Content-Length: fish\\r\\n\\r\\n")); setInterval(() => {}, 1000);',
      pattern: /Content-Length/,
      timeoutMs: 2_000,
    },
    {
      name: "a truncated frame fails promptly",
      source:
        'await Deno.stdin.read(new Uint8Array(65536)); await Deno.stdout.write(new TextEncoder().encode("Content-Length: 100\\r\\n\\r\\n{"));',
      pattern: /middle of a frame/,
      timeoutMs: 2_000,
    },
  ]
) {
  Deno.test({
    name: `LSP ${fixture.name}`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const root = await Deno.makeTempDir({
        prefix: "svelte-check-lsp-failure-",
      });
      try {
        const denoPath = await mockServer(root, fixture.source);
        await rejects(
          () => DenoLsp.start({ root, denoPath, timeoutMs: fixture.timeoutMs }),
          fixture.pattern,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    },
  });
}
