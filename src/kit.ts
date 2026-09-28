import { parse } from "svelte/compiler";
import { CodeWriter, type Segment } from "./transform/writer.ts";

// Svelte's modern ESTree includes TypeScript nodes outside ESTree's type model.
// deno-lint-ignore no-explicit-any
type Node = { type: string; start: number; end: number; [key: string]: any };

export interface KitModule {
  code: string;
  segments: Segment[];
  languageId: "typescript" | "javascript";
}

interface Exported {
  node: Node;
  start: number;
  initializer?: Node;
  typed: boolean;
}

const route =
  /(?:^|[/\\])\+(page(?:\.server)?|layout(?:\.server)?|server)(?:@[^/\\.]*)?\.[cm]?[jt]s$/;
const methods = new Set([
  "GET",
  "PUT",
  "POST",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "fallback",
]);
const options: Record<string, string> = {
  ssr: "boolean",
  csr: "boolean",
  prerender: "boolean | 'auto'",
  trailingSlash: "'never' | 'always' | 'ignore'",
};

function typedInitializer(node: Node | undefined): boolean {
  return ["TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"]
    .includes(node?.type ?? "");
}

/**
 * Add SvelteKit's route types without a separate TypeScript parser. Generated
 * declarations stay in memory; every retained source span keeps its exact map.
 */
export function transformKitModule(
  source: string,
  file: string,
): KitModule | undefined {
  const kind = route.exec(file)?.[1];
  if (!kind) return;
  const javascript = /\.[cm]?js$/.test(file);
  const prefix = '<script lang="ts">';
  let ast: Node;
  try {
    ast = parse(`${prefix}${source}\n</script>`, {
      modern: true,
    }) as unknown as Node;
  } catch {
    // Leave syntax errors to Deno, whose ranges already refer to the real file.
    return;
  }
  const declarations = new Map<string, Exported>();
  const exports = new Map<string, Exported>();
  const named: { local: string; exported: string }[] = [];
  const statements: Node[] = ast.instance.content.body;
  let previous = prefix.length;
  for (const statement of statements) {
    const exported = statement.type === "ExportNamedDeclaration";
    const node = exported ? statement.declaration : statement;
    const comment = source.slice(
      previous - prefix.length,
      statement.start - prefix.length,
    );
    const hasDocType = /@(?:type|satisfies|param|returns?)\b/.test(comment);
    previous = statement.end;
    if (node?.type === "VariableDeclaration") {
      for (const item of node.declarations) {
        if (item.id.type !== "Identifier") continue;
        const info: Exported = {
          node: item,
          start: statement.start,
          initializer: item.init,
          typed: !!item.id.typeAnnotation || typedInitializer(item.init) ||
            hasDocType,
        };
        declarations.set(item.id.name, info);
        if (exported) exports.set(item.id.name, info);
      }
    } else if (node?.type === "FunctionDeclaration" && node.id) {
      const info = {
        node,
        start: statement.start,
        typed: !!node.returnType || hasDocType ||
          node.params.some((p: Node) => !!p.typeAnnotation),
      };
      declarations.set(node.id.name, info);
      if (exported) exports.set(node.id.name, info);
    }
    if (exported && !node && !statement.source) {
      for (const specifier of statement.specifiers) {
        named.push({
          local: specifier.local.name,
          exported: specifier.exported.name ?? specifier.exported.value,
        });
      }
    }
  }
  for (const { local, exported } of named) {
    const declaration = declarations.get(local);
    if (declaration) exports.set(exported, declaration);
  }

  const insertions: { offset: number; text: string }[] = [];
  const insert = (position: number, text: string) =>
    insertions.push({ offset: position - prefix.length, text });
  const annotateFunction = (fn: Node, parameter: string, result?: string) => {
    const first = fn.params[0];
    if (first && !first.typeAnnotation) {
      const target = first.type === "AssignmentPattern" ? first.left : first;
      if (!target.typeAnnotation) insert(target.end, `: ${parameter}`);
    }
    if (result && !fn.returnType) {
      if (fn.type === "ArrowFunctionExpression") {
        // The parameter list ends at the => token, not at the first body token.
        const between = source.slice(
          (first?.end ?? fn.start) - prefix.length,
          fn.body.start - prefix.length,
        );
        const arrow = between.lastIndexOf("=>");
        if (arrow >= 0) {
          insert((first?.end ?? fn.start) + arrow, `: ${result} `);
        }
      } else insert(fn.body.start, `: ${result} `);
    }
  };
  for (const [name, declaration] of exports) {
    if (declaration.typed) continue;
    const { node, initializer } = declaration;
    if (options[name] && node.type === "VariableDeclarator") {
      if (javascript && initializer) {
        insert(node.id.start, `/** @type {${options[name]}} */ `);
      } else if (!javascript) insert(node.id.end, `: ${options[name]}`);
    } else if (name === "load") {
      const type = `import('./$types.js').${
        kind.startsWith("layout") ? "Layout" : "Page"
      }${kind.includes("server") ? "Server" : ""}Load`;
      if (node.type === "FunctionDeclaration") {
        if (javascript && node.params[0]) {
          insert(
            declaration.start,
            `\n/** @param {${type}Event} ${node.params[0].name ?? "arg0"} */\n`,
          );
        } else if (!javascript) annotateFunction(node, `${type}Event`);
      } else if (initializer) {
        insert(
          initializer.start,
          javascript ? `/** @satisfies {${type}} */ (` : "(",
        );
        insert(initializer.end, javascript ? ")" : `) satisfies ${type}`);
      }
    } else if (name === "actions" && initializer) {
      insert(
        initializer.start,
        javascript
          ? "/** @satisfies {import('./$types.js').Actions} */ ("
          : "(",
      );
      insert(
        initializer.end,
        javascript ? ")" : ") satisfies import('./$types.js').Actions",
      );
    } else if (methods.has(name)) {
      const fn = node.type === "FunctionDeclaration" ? node : initializer;
      if (
        fn &&
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]
          .includes(fn.type)
      ) {
        if (javascript) {
          insert(
            fn.type === "FunctionDeclaration" ? declaration.start : fn.start,
            `\n/** @type {(arg0: import('./$types.js').RequestEvent) => ${
              fn.async ? "Promise<Response>" : "Response | Promise<Response>"
            }} */\n`,
          );
          continue;
        }
        let wrapParameter = false;
        if (
          fn.type === "ArrowFunctionExpression" && fn.params.length === 1 &&
          fn.params[0].type === "Identifier" &&
          source.slice(
              fn.start - prefix.length,
              fn.params[0].start - prefix.length,
            ).trim().replace(/^async\s*/, "") === ""
        ) {
          insert(fn.params[0].start, "(");
          wrapParameter = true;
        }
        annotateFunction(
          fn,
          "import('./$types.js').RequestEvent",
          fn.async ? "Promise<Response>" : "Response | Promise<Response>",
        );
        if (wrapParameter) insert(fn.params[0].end, ")");
      }
    }
  }
  if (!insertions.length) return;
  const writer = new CodeWriter(source);
  let cursor = 0;
  for (const edit of insertions.sort((a, b) => a.offset - b.offset)) {
    writer.source(cursor, edit.offset);
    writer.append(edit.text);
    cursor = edit.offset;
  }
  writer.source(cursor, source.length);
  return {
    code: writer.code,
    segments: writer.segments,
    languageId: javascript ? "javascript" : "typescript",
  };
}
