import { type AST, parse } from "svelte/compiler";
import type { CodeWriter } from "./writer.ts";

// Svelte's modern tree includes TypeScript nodes that ESTree does not describe.
// Keep that boundary here; no TypeScript compiler or parser is needed.
// deno-lint-ignore no-explicit-any
type Node = { type: string; start: number; end: number; [key: string]: any };

interface Span {
  start: number;
  end: number;
}

interface Prop {
  name: string;
  local: string;
  optional: boolean;
  type?: Span;
  jsdocType?: string;
}

interface Edit extends Span {
  text: string;
}

export interface ScriptInfo {
  props: Prop[];
  exports: { name: string; local: string }[];
  propsType?: Span;
  propsTypeText?: string;
  propsRest?: boolean;
  propsIdentifier?: string;
  generics?: Span;
  genericNames: string[];
  runes: boolean;
  source: string;
  /** Template lowering can supply an expression describing legacy slot props. */
  slotsExpression?: string;
  slotsType?: string;
  eventsType?: string;
  dispatchTypes: Span[];
}

export interface ScriptOptions {
  kit?: "page" | "layout" | "error";
}

function kitType(name: string, kit: ScriptOptions["kit"]): string | undefined {
  if (!kit) return;
  if (kit === "error") {
    return name === "error" ? "App.Error" : undefined;
  }
  if (name === "data") {
    return `import('./$types.js').${
      kit === "layout" ? "LayoutData" : "PageData"
    }`;
  }
  if (name === "form" && kit === "page") {
    return "import('./$types.js').ActionData";
  }
  if (name === "params") {
    return `import('./$types.js').${
      kit === "layout" ? "LayoutProps" : "PageProps"
    }['params']`;
  }
  if (name === "snapshot") return "import('./$types.js').Snapshot";
}

const runes = new Set([
  "$state",
  "$derived",
  "$effect",
  "$props",
  "$bindable",
  "$inspect",
  "$host",
]);

function walk(
  value: unknown,
  visit: (node: Node, parent?: Node, key?: string) => void,
  parent?: Node,
  key?: string,
) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, parent, key);
    return;
  }
  const node = value as Node;
  if (typeof node.type !== "string") return;
  visit(node, parent, key);
  for (const [childKey, child] of Object.entries(node)) {
    if (
      !["loc", "leadingComments", "trailingComments", "comments"].includes(
        childKey,
      )
    ) {
      walk(child, visit, node, childKey);
    }
  }
}

function bindingNames(node: Node | undefined): string[] {
  if (!node) return [];
  if (node.type === "Identifier") return [node.name];
  if (node.type === "AssignmentPattern") return bindingNames(node.left);
  if (node.type === "RestElement") return bindingNames(node.argument);
  if (node.type === "ObjectPattern") {
    return node.properties.flatMap((p: Node) =>
      bindingNames(p.type === "RestElement" ? p.argument : p.value)
    );
  }
  if (node.type === "ArrayPattern") return node.elements.flatMap(bindingNames);
  return [];
}

function declaration(statement: Node): Node {
  return statement.type === "ExportNamedDeclaration"
    ? statement.declaration
    : statement;
}

function declaredNames(statement: Node): string[] {
  const node = declaration(statement);
  if (!node) return [];
  if (node.type === "VariableDeclaration") {
    return node.declarations.flatMap((d: Node) => bindingNames(d.id));
  }
  if (node.id?.name) return [node.id.name];
  if (node.type === "ImportDeclaration") {
    return node.specifiers.map((s: Node) => s.local.name);
  }
  return [];
}

function annotation(node: Node): Span | undefined {
  return node.typeAnnotation?.typeAnnotation;
}

function isPropsCall(node: Node | undefined): boolean {
  return node?.type === "CallExpression" &&
    node.callee?.type === "Identifier" && node.callee.name === "$props";
}

function isReactive(node: Node): boolean {
  return node.type === "LabeledStatement" && node.label.name === "$";
}

function reactiveAssignment(node: Node): Node | undefined {
  const expression = node.body?.expression;
  return expression?.type === "AssignmentExpression" &&
      expression.operator === "="
    ? expression
    : undefined;
}

/** Read balanced JSDoc type braces, including object and function types. */
function jsdocTags(
  text: string,
): { tag: string; type: string; name?: string }[] {
  const tags: { tag: string; type: string; name?: string }[] = [];
  const pattern = /@(type|param|returns?|typedef|property|prop)\s*\{/g;
  for (let match; (match = pattern.exec(text));) {
    const start = pattern.lastIndex;
    let end = start;
    let depth = 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}") depth--;
    }
    if (depth) continue;
    const type = text.slice(start, end - 1).trim().replace(/^\*(?!\w)/, "any");
    const name = /^\s*([\w$.[\]=]+)/.exec(text.slice(end))?.[1];
    tags.push({ tag: match[1], type, name });
  }
  return tags;
}

function leadingDoc(source: string, node: Node, previousEnd: number): string {
  const prefix = source.slice(previousEnd, node.start);
  return /\/\*\*([\s\S]*?)\*\/\s*$/.exec(prefix)?.[1] ?? "";
}

function emitTypedefs(doc: string, writer: CodeWriter) {
  const tags = jsdocTags(doc);
  for (const [index, tag] of tags.entries()) {
    if (tag.tag !== "typedef" || !tag.name) continue;
    const properties = tags.slice(index + 1).filter((t) =>
      t.tag === "property" || t.tag === "prop"
    );
    let type = tag.type;
    if (["Object", "object"].includes(type) && properties.length) {
      type = `{${
        properties.map((p) => {
          const optional = p.name?.startsWith("[");
          const name = p.name?.replace(/[\[\]]/g, "").split("=")[0] ?? "";
          return `${JSON.stringify(name)}${optional ? "?" : ""}: ${p.type}`;
        }).join(";")
      }}`;
    }
    writer.append(`type ${tag.name} = ${type};\n`);
  }
}

function jsdocFunctionEdits(node: Node, doc: string): Edit[] {
  const edits: Edit[] = [];
  const tags = jsdocTags(doc);
  for (const parameter of node.params ?? []) {
    const id = parameter.type === "AssignmentPattern"
      ? parameter.left
      : parameter;
    const tag = tags.find((t) =>
      t.tag === "param" &&
      t.name?.replace(/[\[\]]/g, "").split("=")[0] === id.name
    );
    if (tag && !annotation(id)) {
      const optional = parameter === id && tag.name?.startsWith("[") ? "?" : "";
      edits.push({
        start: id.end,
        end: id.end,
        text: `${optional}: ${tag.type}`,
      });
    }
  }
  const returns = tags.find((t) => t.tag === "return" || t.tag === "returns");
  if (returns && !node.returnType) {
    edits.push({
      start: node.body.start,
      end: node.body.start,
      text: `: ${returns.type} `,
    });
  }
  return edits;
}

function emitEdited(
  writer: CodeWriter,
  start: number,
  end: number,
  edits: Edit[],
) {
  let cursor = start;
  for (
    const edit of edits.filter((e) => e.start >= start && e.end <= end).sort((
      a,
      b,
    ) => a.start - b.start || a.end - b.end)
  ) {
    if (edit.start < cursor) continue;
    writer.source(cursor, edit.start);
    writer.append(edit.text);
    cursor = edit.end;
  }
  writer.source(cursor, end);
}

function propertyName(node: Node): string {
  return node.name ?? String(node.value);
}

function collectProps(node: Node, info: ScriptInfo, jsdocType?: string) {
  info.runes = true;
  info.propsType = annotation(node.id);
  info.propsTypeText = jsdocType;
  if (node.id.type === "Identifier") {
    info.propsIdentifier = node.id.name;
    return;
  }
  for (const property of node.id.properties ?? []) {
    if (property.type === "RestElement") {
      info.propsRest = true;
      continue;
    }
    const value = property.value;
    const local = value.type === "AssignmentPattern" ? value.left : value;
    if (local.type === "Identifier") {
      info.props.push({
        name: propertyName(property.key),
        local: local.name,
        optional: value.type === "AssignmentPattern",
        type: annotation(local),
      });
    }
  }
}

function emitPropType(info: ScriptInfo, writer: CodeWriter) {
  if (info.propsType) {
    writer.source(info.propsType.start, info.propsType.end);
  } else if (info.propsTypeText) {
    writer.append(info.propsTypeText);
  } else if (info.propsIdentifier) {
    writer.append(`typeof ${info.propsIdentifier}`);
  } else {
    writer.append("{");
    for (const prop of info.props) {
      writer.append(
        `${JSON.stringify(prop.name)}${prop.optional ? "?" : ""}: `,
      );
      if (prop.type) writer.source(prop.type.start, prop.type.end);
      else if (prop.jsdocType) writer.append(prop.jsdocType);
      else writer.append(`typeof ${prop.local}`);
      writer.append(";");
    }
    writer.append("}");
    if (info.propsRest) writer.append(" & Record<string, any>");
  }
}

function sortReactive(statements: Node[]): Node[] {
  const remaining = [...statements];
  const result: Node[] = [];
  const owners = new Map<string, Node>();
  for (const statement of statements) {
    for (const name of bindingNames(reactiveAssignment(statement)?.left)) {
      owners.set(name, statement);
    }
  }
  const done = new Set<Node>();
  while (remaining.length) {
    let index = remaining.findIndex((statement) => {
      let ready = true;
      const assignment = reactiveAssignment(statement);
      walk(assignment?.right ?? statement.body, (node) => {
        if (node.type !== "Identifier") return;
        const owner = owners.get(
          node.name.startsWith("$") ? node.name.slice(1) : node.name,
        );
        if (owner && owner !== statement && !done.has(owner)) ready = false;
      });
      return ready;
    });
    // Svelte's compiler reports cycles. Keep the tree intact for that diagnostic.
    if (index < 0) index = 0;
    const [next] = remaining.splice(index, 1);
    result.push(next);
    done.add(next);
  }
  return result;
}

/** Emit module/import scope and open the component's render/check scope. */
export function emitScriptStart(
  ast: AST.Root,
  source: string,
  writer: CodeWriter,
  options: ScriptOptions = {},
): ScriptInfo {
  const root = ast as unknown as Node;
  const statements: Node[] = root.instance?.content.body ?? [];
  const info: ScriptInfo = {
    props: [],
    exports: [],
    genericNames: [],
    runes: false,
    source,
    dispatchTypes: [],
  };
  const generic = root.instance?.attributes?.find((a: Node) =>
    a.name === "generics"
  )?.value?.[0];
  if (generic?.type === "Text") {
    info.generics = { start: generic.start, end: generic.end };
    // Reuse Svelte's TypeScript-aware parser for constraints/defaults rather
    // than splitting on commas that may occur inside nested types.
    const text = source.slice(generic.start, generic.end);
    const probe = parse(
      `<script lang="ts">function __generic<${text}>() {}</script>`,
      { modern: true },
    ) as unknown as Node;
    info.genericNames = probe.instance.content.body[0].typeParameters.params
      .map(
        (parameter: Node) => parameter.name,
      );
  }

  if (root.module) {
    const moduleEdits: Edit[] = [];
    let previous = root.module.content.start;
    for (const statement of root.module.content.body) {
      const node = declaration(statement);
      const doc = leadingDoc(source, statement, previous);
      emitTypedefs(doc, writer);
      const type = jsdocTags(doc).find((t) => t.tag === "type")?.type;
      if (node?.type === "VariableDeclaration" && type) {
        for (const item of node.declarations) {
          if (!annotation(item.id)) {
            moduleEdits.push({
              start: item.id.end,
              end: item.id.end,
              text: `: ${type}`,
            });
          }
        }
      }
      if (node?.type === "FunctionDeclaration") {
        moduleEdits.push(...jsdocFunctionEdits(node, doc));
      }
      previous = statement.end;
    }
    emitEdited(
      writer,
      root.module.content.start,
      root.module.content.end,
      moduleEdits,
    );
    writer.append("\n");
  }
  let importPreviousEnd = root.instance?.content.start ?? 0;
  for (const statement of statements) {
    if (statement.type === "ImportDeclaration") {
      writer.source(importPreviousEnd, statement.start);
      writer.source(statement.start, statement.end);
      writer.append("\n");
    }
    importPreviousEnd = statement.end;
  }

  writer.append("function __sv_render");
  if (info.generics) {
    writer.append("<");
    writer.source(info.generics.start, info.generics.end);
    writer.append(">");
  }
  writer.append("() {\n");
  const declared = new Set(statements.flatMap(declaredNames));
  const dispatchFactories = new Set<string>();
  for (const statement of statements) {
    if (
      statement.type === "ImportDeclaration" &&
      statement.source.value === "svelte"
    ) {
      for (const specifier of statement.specifiers) {
        if (specifier.imported?.name === "createEventDispatcher") {
          dispatchFactories.add(specifier.local.name);
        }
      }
    }
  }
  const declarations = new Map<
    string,
    { node: Node; declaration: Node; statement: Node; jsdocType?: string }
  >();
  const edits: Edit[] = [];
  const propDefaults = new Map<
    Node,
    { name: string; entries: { key: string; value: Node }[] }
  >();
  const prefixes = new Map<Node, Span>();
  let previousEnd = root.instance?.content.start ?? 0;
  for (const statement of statements) {
    const node = declaration(statement);
    prefixes.set(statement, { start: previousEnd, end: statement.start });
    const doc = leadingDoc(source, statement, previousEnd);
    previousEnd = statement.end;
    const tags = jsdocTags(doc);
    emitTypedefs(doc, writer);
    const type = tags.find((t) => t.tag === "type")?.type;
    if (node?.type === "TSInterfaceDeclaration" && node.id.name === "$$Slots") {
      info.slotsType = "$$Slots";
    }
    if (node?.type === "TSInterfaceDeclaration" && node.id.name === "$$Props") {
      info.propsTypeText = "$$Props";
    }
    if (
      node?.type === "TSInterfaceDeclaration" && node.id.name === "$$Events"
    ) info.eventsType = "$$Events";
    if (node?.type === "VariableDeclaration") {
      for (const item of node.declarations) {
        if (
          item.init?.type === "CallExpression" &&
          dispatchFactories.has(item.init.callee?.name) &&
          item.init.typeArguments?.params?.[0]
        ) {
          info.dispatchTypes.push(item.init.typeArguments.params[0]);
        }
        for (const name of bindingNames(item.id)) {
          declarations.set(name, {
            node: item,
            declaration: node,
            statement,
            jsdocType: type,
          });
        }
        if (isPropsCall(item.init)) {
          collectProps(item, info, type);
          if (!annotation(item.id) && !type && options.kit) {
            // Kit 3 generates the full shape, including layout children and
            // whether a page has actions. Error status belongs to App.Error.
            const propsType = `import('./$types.js').${
              options.kit === "layout"
                ? "LayoutProps"
                : options.kit === "error"
                ? "ErrorProps"
                : "PageProps"
            }`;
            info.propsTypeText = propsType;
            edits.push({
              start: item.id.end,
              end: item.id.end,
              text: `: ${propsType}`,
            });
          }
          if (
            !annotation(item.id) && !type && !options.kit &&
            item.id.type === "ObjectPattern"
          ) {
            const entries: { key: string; value: Node }[] = [];
            for (const property of item.id.properties) {
              if (property.value?.type === "AssignmentPattern") {
                entries.push({
                  key: propertyName(property.key),
                  value: property.value.right,
                });
              }
            }
            if (entries.length) {
              const name = `__sv_prop_defaults_${propDefaults.size}`;
              propDefaults.set(statement, { name, entries });
              const propsType = `{${
                info.props.map((prop) => {
                  const entry = entries.find((entry) =>
                    entry.key === prop.name
                  );
                  return `${JSON.stringify(prop.name)}${
                    prop.optional ? "?" : ""
                  }: ${
                    entry
                      ? `typeof ${name}[${JSON.stringify(prop.name)}]`
                      : "any"
                  }`;
                }).join(";")
              }}${info.propsRest ? " & Record<string, any>" : ""}`;
              info.propsTypeText = propsType;
              edits.push({
                start: item.id.end,
                end: item.id.end,
                text: `: ${propsType}`,
              });
            }
          }
        }
        if (type && !annotation(item.id)) {
          edits.push({
            start: item.id.end,
            end: item.id.end,
            text: `: ${type}`,
          });
        }
      }
    }
    if (node?.type === "FunctionDeclaration") {
      edits.push(...jsdocFunctionEdits(node, doc));
    }
  }

  for (const statement of statements) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const exported = statement.declaration;
    if (exported) {
      edits.push({ start: statement.start, end: exported.start, text: "" });
      for (const local of declaredNames(statement)) {
        const entry = declarations.get(local);
        if (!info.runes && entry?.declaration.kind === "let") {
          info.props.push({
            name: local,
            local,
            optional: !!entry.node.init,
            type: annotation(entry.node.id),
            jsdocType: entry.jsdocType,
          });
        } else if (!exported.type.startsWith("TS")) {
          info.exports.push({ name: local, local });
        }
      }
    } else {
      edits.push({ start: statement.start, end: statement.end, text: "" });
      for (const specifier of statement.specifiers) {
        const local = specifier.local.name;
        const name = propertyName(specifier.exported);
        const entry = declarations.get(local);
        if (!info.runes && entry?.declaration.kind === "let") {
          info.props.push({
            name,
            local,
            optional: !!entry.node.init,
            type: annotation(entry.node.id),
            jsdocType: entry.jsdocType,
          });
        } else if (statement.exportKind !== "type") {
          info.exports.push({ name, local });
        }
      }
    }
  }

  for (const [name, entry] of declarations) {
    const item = entry.node;
    const isProp = info.props.some((p) => p.local === name);
    const inferredKitType =
      isProp && !info.runes && item.id.type === "Identifier" &&
        !annotation(item.id) && !entry.jsdocType
        ? kitType(name, options.kit)
        : undefined;
    if (inferredKitType) {
      entry.jsdocType = inferredKitType;
      edits.push({
        start: item.id.end,
        end: item.id.end,
        text: `: ${inferredKitType}`,
      });
      for (const prop of info.props.filter((p) => p.local === name)) {
        prop.jsdocType = inferredKitType;
      }
    }
    // Do not annotate plain untyped lets: TypeScript must still infer the type
    // of later reactive assignments. Props and typed bindings start initialized.
    if (
      entry.declaration.kind === "let" && !item.init &&
      item.id.type === "Identifier" &&
      (isProp || annotation(item.id) || entry.jsdocType)
    ) {
      edits.push({
        start: item.end,
        end: item.end,
        text: `${
          annotation(item.id) || entry.jsdocType ? "" : ": any"
        } = null!`,
      });
    }
    if (
      isProp && item.init?.type === "Literal" &&
      typeof item.init.value === "boolean"
    ) {
      for (const prop of info.props.filter((p) => p.local === name)) {
        prop.jsdocType ??= "boolean";
      }
    }
  }

  const stores = new Map<string, Node>();
  const writtenStores = new Map<string, Node>();
  const special = new Set<string>();
  walk(root, (node, parent, key) => {
    if (
      node.type === "AssignmentExpression" || node.type === "UpdateExpression"
    ) {
      let target = node.left ?? node.argument;
      while (target?.type === "MemberExpression") target = target.object;
      if (
        target?.type === "Identifier" &&
        /^\$[A-Za-z_$][\w$]*$/.test(target.name) &&
        !target.name.startsWith("$$")
      ) writtenStores.set(target.name.slice(1), target);
    }
    if (node.type !== "Identifier") return;
    if (node.name.startsWith("$$")) {
      special.add(node.name);
      return;
    }
    if (
      !/^\$[A-Za-z_$][\w$]*$/.test(node.name) ||
      (runes.has(node.name) && (
        (parent?.type === "CallExpression" && key === "callee") ||
        (parent?.type === "MemberExpression" && key === "object") ||
        !declared.has(node.name.slice(1))
      ))
    ) return;
    if (
      (parent?.type === "MemberExpression" && key === "property" &&
        !parent.computed) ||
      (parent?.type === "Property" && key === "key" && !parent.computed &&
        !parent.shorthand)
    ) return;
    stores.set(node.name.slice(1), node);
  });
  for (const name of special) {
    if (["$$props", "$$restProps"].includes(name)) {
      writer.append(`let ${name}: Record<string, any> = {};\n`);
    }
    if (name === "$$slots") {
      writer.append("let $$slots: Record<string, boolean> = {};\n");
    }
  }
  const inserted = new Set<string>();
  function emitStore(name: string) {
    const node = stores.get(name);
    if (!node || inserted.has(name)) return;
    inserted.add(name);
    writer.append(`let $${name} = __sv_store_get(`);
    writer.source(node.start + 1, node.end);
    writer.append(");\n");
    const write = writtenStores.get(name);
    if (write) {
      writer.append("__sv_store_settable(");
      writer.source(write.start + 1, write.end);
      writer.append(");\n");
    }
  }
  const reactive = statements.filter(isReactive);
  const reactiveNames = new Set(
    reactive.flatMap((s) => bindingNames(reactiveAssignment(s)?.left)),
  );
  for (const name of stores.keys()) {
    if (!declarations.has(name) && !reactiveNames.has(name)) emitStore(name);
  }
  for (const statement of statements) {
    if (statement.type === "ImportDeclaration" || isReactive(statement)) {
      continue;
    }
    const defaults = propDefaults.get(statement);
    if (defaults) {
      writer.append(`const ${defaults.name} = {`);
      for (const entry of defaults.entries) {
        writer.append(`${JSON.stringify(entry.key)}: `);
        writer.source(entry.value.start, entry.value.end);
        writer.append(",");
      }
      writer.append("};\n");
    }
    const prefix = prefixes.get(statement)!;
    writer.source(prefix.start, prefix.end);
    emitEdited(writer, statement.start, statement.end, edits);
    writer.append("\n");
    if (!info.runes) {
      for (
        const prop of info.props.filter((p) =>
          declaredNames(statement).includes(p.local)
        )
      ) {
        writer.append(`${prop.local} = null! as any;\n`);
      }
    }
    for (const name of declaredNames(statement)) emitStore(name);
  }
  for (const statement of sortReactive(reactive)) {
    const prefix = prefixes.get(statement)!;
    writer.source(prefix.start, prefix.end);
    const assignment = reactiveAssignment(statement);
    const names = bindingNames(assignment?.left);
    if (assignment && names.length && names.every((n) => !declared.has(n))) {
      writer.append("let ");
      writer.source(assignment.left.start, assignment.left.end);
      writer.append(" = ");
      writer.source(assignment.right.start, assignment.right.end);
      writer.append(";\n");
      for (const name of names) declared.add(name);
    } else {
      const newNames = names.filter((name) => !declared.has(name));
      if (newNames.length) {
        writer.append(`let ${newNames.join(", ")};\n`);
        for (const name of newNames) declared.add(name);
      }
      writer.source(statement.body.start, statement.body.end);
      writer.append("\n");
    }
    for (const name of names) emitStore(name);
  }
  return info;
}

/** Finish the render/check scope and expose the public component props. */
export function emitScriptEnd(info: ScriptInfo, writer: CodeWriter): void {
  if (info.dispatchTypes.length) {
    writer.append("\ntype __sv_dispatch_events = ");
    for (const [index, span] of info.dispatchTypes.entries()) {
      if (index) writer.append(" & ");
      writer.source(span.start, span.end);
    }
    writer.append(";\n");
    info.eventsType ??=
      "{[K in keyof __sv_dispatch_events]: CustomEvent<__sv_dispatch_events[K]>}";
  }
  writer.append("\nreturn { props: {} as ");
  emitPropType(info, writer);
  writer.append(", exports: {");
  for (const item of info.exports) {
    writer.append(`${JSON.stringify(item.name)}: ${item.local},`);
  }
  writer.append(
    `}, slots: ${
      info.slotsType ? `{} as ${info.slotsType}` : info.slotsExpression ?? "{}"
    }, events: {} as ${
      info.eventsType ?? "Record<string, CustomEvent<any>>"
    } };\n}\n`,
  );
  if (info.generics) {
    writer.append("declare function __sv_component_export<");
    writer.source(info.generics.start, info.generics.end);
    const use = `typeof __sv_render<${info.genericNames.join(",")}>`;
    writer.append(
      `>(anchor: unknown, props: ReturnType<${use}>["props"]): ReturnType<${use}>["exports"] & { $$prop_def: ReturnType<${use}>["props"]; $$events_def: ReturnType<${use}>["events"] };\n`,
    );
  } else {
    writer.append(
      'declare const __sv_component_export: import("svelte").Component<ReturnType<typeof __sv_render>["props"], ReturnType<typeof __sv_render>["exports"] & { $$prop_def: ReturnType<typeof __sv_render>["props"] }> & { $$slot_def: ReturnType<typeof __sv_render>["slots"]; $$events_def: ReturnType<typeof __sv_render>["events"] };\n',
    );
  }
  writer.append("export default __sv_component_export;\n");
}
