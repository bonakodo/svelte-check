import type { AST } from "svelte/compiler";
import type { CodeWriter } from "./writer.ts";

type Ranged = { start?: number; end?: number };
type Element = AST.ElementLike;
type Attr = Element["attributes"][number];

/** A feature that cannot be checked faithfully must not produce a clean result. */
export class UnsupportedTemplateError extends Error {
  constructor(message: string, public start: number, public end: number) {
    super(message);
    this.name = "UnsupportedTemplateError";
  }
}

/** Lower the modern Svelte AST into TypeScript statements for Deno's checker. */
export function emitTemplate(
  ast: AST.Root,
  source: string,
  writer: CodeWriter,
): void {
  let counter = 0;
  type SlotContext = { enter: () => void; leave?: () => void };
  const contexts: SlotContext[] = [];
  const slots = new Map<
    string,
    { node: AST.SlotElement; contexts: SlotContext[] }[]
  >();
  let opaqueSlotScope = 0;
  const append = (text: string, offset?: number) => writer.append(text, offset);
  const slice = (node: Ranged) => {
    if (node.start === undefined || node.end === undefined) {
      throw new Error("The Svelte parser did not provide source offsets");
    }
    writer.source(node.start, node.end);
  };
  const fail = (node: AST.BaseNode, detail = node.type): never => {
    throw new UnsupportedTemplateError(
      `Cannot yet type-check ${detail}`,
      node.start,
      node.end,
    );
  };
  function scoped(context: SlotContext, body: () => void): void {
    contexts.push(context);
    body();
    contexts.pop();
  }
  function value(value: AST.Attribute["value"]): void {
    if (value === true) append("true");
    else if (!Array.isArray(value)) slice(value.expression as Ranged);
    else if (value.length === 0) append('""');
    else if (value.length === 1) {
      const part = value[0];
      if (part.type === "Text") append(JSON.stringify(part.data), part.start);
      else slice(part.expression as Ranged);
    } else {
      append('(""');
      for (const part of value) {
        append(" + (");
        if (part.type === "Text") append(JSON.stringify(part.data), part.start);
        else slice(part.expression as Ranged);
        append(")");
      }
      append(")");
    }
  }
  function expr(node: Ranged): void {
    append("void (");
    slice(node);
    append(");\n");
  }
  function name(node: Element): void {
    if (node.type === "SvelteComponent") slice(node.expression as Ranged);
    else if (node.type === "SvelteSelf") {
      append("__sv_component_export", node.start + 1);
    } else append(node.name, node.start + 1);
  }
  function stringAttr(node: Element, key: string): string | undefined {
    const attr = node.attributes.find((a) =>
      a.type === "Attribute" && a.name === key
    );
    if (attr?.type !== "Attribute" || !Array.isArray(attr.value)) return;
    if (attr.value.length === 1 && attr.value[0].type === "Text") {
      return attr.value[0].data;
    }
  }
  function snippet(node: AST.SnippetBlock, asProperty: boolean): void {
    if (asProperty) {
      append(JSON.stringify(node.expression.name), node.start);
      append(": ");
      if (node.typeParams) append(`<${node.typeParams}>`);
      append("(");
    } else {
      append("function ");
      slice(node.expression as Ranged);
      if (node.typeParams) append(`<${node.typeParams}>`);
      append("(");
    }
    node.parameters.forEach((p, i) => {
      if (i) append(", ");
      slice(p as Ranged);
    });
    append(asProperty ? ") => {\n" : ") {\n");
    opaqueSlotScope++;
    fragment(node.body, 1);
    opaqueSlotScope--;
    append("return __sv_snippet_result();\n}");
    append(asProperty ? ",\n" : "\n");
  }
  function props(node: Element, component: boolean): void {
    append("{\n", node.start);
    for (const attr of node.attributes) {
      if (attr.type === "Attribute") {
        append(`${JSON.stringify(attr.name)}: `, attr.start);
        value(attr.value);
        append(",\n");
      } else if (attr.type === "SpreadAttribute") {
        append("...(");
        slice(attr.expression as Ranged);
        append("),\n");
      } else if (
        component && attr.type === "BindDirective" && attr.name !== "this"
      ) {
        append(`${JSON.stringify(attr.name)}: `, attr.start);
        if (attr.expression.type === "SequenceExpression") {
          append("(");
          slice(attr.expression.expressions[0] as Ranged);
          append(")?.()");
        } else slice(attr.expression as Ranged);
        append(",\n");
      } else if (!component && attr.type === "OnDirective" && attr.expression) {
        append(`${JSON.stringify(`on:${attr.name}`)}: `, attr.start);
        slice(attr.expression as Ranged);
        append(",\n");
      }
    }
    if (component || node.type === "SvelteBoundary") {
      const snippets = node.fragment.nodes.filter((n) =>
        n.type === "SnippetBlock"
      );
      for (const child of snippets) snippet(child, true);
    }
    if (component) {
      const regular = node.fragment.nodes.filter((n) =>
        n.type !== "SnippetBlock"
      );
      const meaningful = regular.some((n) =>
        n.type !== "Comment" && (n.type !== "Text" || n.data.trim())
      );
      const legacy = node.attributes.some((a) => a.type === "LetDirective") ||
        regular.some((n) =>
          "attributes" in n &&
          n.attributes.some((a) => a.type === "Attribute" && a.name === "slot")
        );
      if (meaningful && !legacy) {
        append("children: () => {\n");
        opaqueSlotScope++;
        fragment({ type: "Fragment", nodes: regular }, 1);
        opaqueSlotScope--;
        append("return __sv_snippet_result();\n},\n");
      }
    }
    append("}");
  }
  function bindValue(
    node: Element,
    attr: AST.BindDirective,
    el: string,
    component: boolean,
  ): void {
    if (attr.name === "this") append(el);
    else if (component) {
      append("__sv_component_prop(");
      name(node);
      append(`, ${JSON.stringify(attr.name)})`);
    } else if (node.name === "input" && attr.name === "value") {
      append("__sv_input_value(");
      const type = node.attributes.find((a) =>
        a.type === "Attribute" && a.name === "type"
      );
      if (type?.type === "Attribute") value(type.value);
      else append('"text"');
      append(")");
    } else if (
      (node.name === "select" && attr.name === "value") || attr.name === "group"
    ) {
      append("__sv_select_value()");
    } else {
      append(
        `__sv_binding(${el}, ${JSON.stringify(attr.name)})`,
        attr.start,
      );
    }
  }
  function directives(node: Element, el: string, component: boolean): void {
    for (const attr of node.attributes) {
      switch (attr.type) {
        case "Attribute":
        case "SpreadAttribute":
        case "LetDirective":
          break;
        case "OnDirective":
          if (component && attr.expression) {
            append("__sv_component_event(");
            name(node);
            append(`, ${el}, ${JSON.stringify(attr.name)}, `, attr.start);
            slice(attr.expression as Ranged);
            append(");\n");
          }
          break;
        case "BindDirective":
          {
            let target: unknown = attr.expression;
            while (
              target && typeof target === "object" && "type" in target &&
              target.type === "MemberExpression" && "object" in target
            ) target = target.object;
            if (
              target && typeof target === "object" && "type" in target &&
              target.type === "Identifier" && "name" in target &&
              typeof target.name === "string" && /^\$[^$]/.test(target.name)
            ) {
              append("__sv_store_settable(");
              append(target.name.slice(1), (target as Ranged).start! + 1);
              append(");\n");
            }
          }
          if (attr.expression.type === "SequenceExpression") {
            append("__sv_function_bind(");
            bindValue(node, attr, el, component);
            append(", ");
            attr.expression.expressions.forEach((part, i) => {
              if (i) append(", ");
              slice(part as Ranged);
            });
            append(");\n");
          } else {
            slice(attr.expression as Ranged);
            append(" = ");
            bindValue(node, attr, el, component);
            append(";\n");
          }
          break;
        case "ClassDirective":
          expr(attr.expression as Ranged);
          break;
        case "StyleDirective":
          append("void (");
          if (attr.value === true) {
            append(attr.name, attr.start + "style:".length);
          } else value(attr.value);
          append(");\n");
          break;
        case "UseDirective":
        case "TransitionDirective":
        case "AnimateDirective": {
          const prefix = source.slice(attr.start, attr.end).indexOf(":") + 1;
          if (attr.type === "TransitionDirective") append("__sv_transition(");
          else if (attr.type === "UseDirective") append("__sv_action_result(");
          else append("__sv_animation_result(");
          append(attr.name, attr.start + prefix);
          append(attr.type === "TransitionDirective" ? `, ${el}` : `(${el}`);
          if (attr.type === "AnimateDirective") {
            append(", { from: new DOMRect(), to: new DOMRect() }");
          }
          if (attr.expression) {
            append(", ");
            slice(attr.expression as Ranged);
          }
          if (attr.type === "TransitionDirective") {
            if (!attr.expression) append(", undefined");
          }
          if (attr.type !== "TransitionDirective") append(")");
          append(");\n");
          break;
        }
        case "AttachTag":
          append(`__sv_attach(${el}, `);
          slice(attr.expression as Ranged);
          append(");\n");
          break;
        default:
          fail(attr as Attr & AST.BaseNode);
      }
    }
  }
  function letScope(
    owner: Element,
    attributes: Element["attributes"],
    slot: string,
  ): void {
    for (const attr of attributes) {
      if (attr.type !== "LetDirective") continue;
      append("const ");
      if (attr.expression) slice(attr.expression as Ranged);
      else append(attr.name, attr.start + 4);
      append(" = __sv_slot(");
      name(owner);
      append(
        `, ${JSON.stringify(slot)})[${JSON.stringify(attr.name)}];\n`,
        attr.start,
      );
    }
  }
  function element(node: Element, depth: number): void {
    const component = node.type === "Component" ||
      node.type === "SvelteComponent" || node.type === "SvelteSelf";
    if (node.type === "SlotElement") {
      if (opaqueSlotScope > 0) {
        fail(
          node,
          "slot outlets inside snippet or component children callbacks",
        );
      }
      const slotName = stringAttr(node, "name") ?? "default";
      const outlets = slots.get(slotName) ?? [];
      outlets.push({ node, contexts: [...contexts] });
      slots.set(slotName, outlets);
      for (const attr of node.attributes) {
        if (attr.type === "Attribute") {
          append("void (");
          value(attr.value);
          append(");\n");
        } else if (attr.type === "SpreadAttribute") {
          expr(attr.expression as Ranged);
        } else fail(attr, "directives on slot outlets");
      }
      fragment(node.fragment, depth);
      return;
    }
    const id = `__sv_el_${counter++}`;
    append("{\n");
    if (node.type === "SvelteFragment") {
      if (node.attributes.some((a) => a.type === "LetDirective")) {
        fail(node, "let directives outside a component slot");
      }
      fragment(node.fragment, depth);
      append("}\n");
      return;
    }
    append(`const ${id} = `);
    if (component) {
      append("__sv_component(");
      name(node);
      append(")(null!, ");
      props(node, true);
      append(");\n");
      const snippets = node.fragment.nodes.filter((child) =>
        child.type === "SnippetBlock"
      );
      if (snippets.length) {
        append("const { ");
        snippets.forEach((child, index) => {
          if (index) append(", ");
          slice(child.expression as Ranged);
        });
        append(" } = __sv_component_snippets(");
        name(node);
        append(`, ${id});\n`);
      }
    } else if (node.type === "SvelteElement") {
      append("__sv_dynamic_element(");
      slice(node.tag as Ranged);
      append(", ");
      props(node, false);
      append(");\n");
    } else {
      append(`__sv_element(${JSON.stringify(node.name)}, `, node.start + 1);
      props(node, false);
      append(");\n");
    }
    directives(node, id, component);
    if (component) {
      const hasLets = node.attributes.some((a) => a.type === "LetDirective");
      const named = node.fragment.nodes.filter((n): n is Element =>
        "attributes" in n &&
        n.attributes.some((a) => a.type === "Attribute" && a.name === "slot")
      );
      if (hasLets || named.length) {
        letScope(node, node.attributes, "default");
        for (const child of node.fragment.nodes) {
          if (child.type === "SnippetBlock") continue;
          if ("attributes" in child && named.includes(child)) {
            append("{\n");
            letScope(
              node,
              child.attributes,
              stringAttr(child, "slot") ?? "default",
            );
            const withoutLets = {
              ...child,
              attributes: child.attributes.filter((a) =>
                a.type !== "LetDirective" &&
                !(a.type === "Attribute" && a.name === "slot")
              ),
            };
            element(withoutLets, depth + 1);
            append("}\n");
          } else visit(child, depth + 1);
        }
      }
    } else if (node.type === "SvelteBoundary") {
      fragment({
        type: "Fragment",
        nodes: node.fragment.nodes.filter((n) => n.type !== "SnippetBlock"),
      }, depth);
    } else fragment(node.fragment, depth);
    append("}\n");
  }
  function fragment(f: AST.Fragment, depth: number): void {
    const savedContextCount = contexts.length;
    const hasLocals = f.nodes.some((node) =>
      node.type === "ConstTag" || node.type === "DeclarationTag"
    );
    for (const node of f.nodes) visit(node, depth + (hasLocals ? 1 : 0));
    contexts.length = savedContextCount;
  }
  function visit(node: AST.Fragment["nodes"][number], depth: number): void {
    switch (node.type) {
      case "Text":
      case "Comment":
        break;
      case "ExpressionTag":
      case "HtmlTag":
        expr(node.expression as Ranged);
        break;
      case "DebugTag":
        for (const id of node.identifiers) expr(id as Ranged);
        break;
      case "ConstTag":
      case "DeclarationTag":
        slice(node.declaration as Ranged);
        append(";\n");
        contexts.push({
          enter: () => {
            append("{\n");
            slice(node.declaration as Ranged);
            append(";\n");
          },
          leave: () => append("}\n"),
        });
        break;
      case "RenderTag":
        append("__sv_render_snippet(");
        slice(node.expression as Ranged);
        append(");\n");
        break;
      case "SnippetBlock":
        snippet(node, false);
        break;
      case "IfBlock":
        append("if (");
        slice(node.test as Ranged);
        append(") {\n");
        scoped({
          enter: () => {
            append("if (");
            slice(node.test as Ranged);
            append(") {\n");
          },
          leave: () => append("}\nthrow null;\n"),
        }, () => fragment(node.consequent, depth + 1));
        append("}\n");
        if (node.alternate) {
          append("else {\n");
          scoped({
            enter: () => {
              append("if (");
              slice(node.test as Ranged);
              append(") {} else {\n");
            },
            leave: () => append("}\nthrow null;\n"),
          }, () => fragment(node.alternate!, depth + 1));
          append("}\n");
        }
        break;
      case "EachBlock": {
        const id = counter++;
        append(`{\nlet __sv_index_${id} = 0;\nfor (const `);
        if (node.context) slice(node.context as Ranged);
        else append(`__sv_item_${id}`);
        append(" of __sv_each(");
        slice(node.expression as Ranged);
        append(")) {\n");
        if (node.index) {
          const offset = source.indexOf(
            node.index,
            (node.context as Ranged | null)?.end ??
              (node.expression as Ranged).end ?? node.start,
          );
          append(`const ${node.index} = __sv_index_${id}++;\n`, offset);
        }
        if (node.key) expr(node.key as Ranged);
        scoped({
          enter: () => {
            append("{\n");
            if (node.context) {
              append("const ");
              slice(node.context as Ranged);
              append(" = __sv_each_item(");
              slice(node.expression as Ranged);
              append(");\n");
            }
            if (node.index) append(`const ${node.index} = 0;\n`);
          },
          leave: () => append("}\n"),
        }, () => fragment(node.body, depth + 1));
        append("}\n");
        if (node.fallback) {
          append("{\n");
          fragment(node.fallback, depth + 1);
          append("}\n");
        }
        append("}\n");
        break;
      }
      case "AwaitBlock": {
        const id = counter++;
        append(`{\nconst __sv_promise_${id} = (`);
        slice(node.expression as Ranged);
        append(");\n");
        if (node.pending) {
          append("{\n");
          fragment(node.pending, depth + 1);
          append("}\n");
        }
        if (node.then) {
          append("{\n");
          if (node.value) {
            append("const ");
            slice(node.value as Ranged);
            append(` = __sv_await(__sv_promise_${id});\n`);
          }
          scoped({
            enter: () => {
              append("{\n");
              if (node.value) {
                append("const ");
                slice(node.value as Ranged);
                append(" = __sv_await(");
                slice(node.expression as Ranged);
                append(");\n");
              }
            },
            leave: () => append("}\n"),
          }, () => fragment(node.then!, depth + 1));
          append("}\n");
        }
        if (node.catch) {
          append("{\n");
          if (node.error) {
            append("const ");
            slice(node.error as Ranged);
            append(" = null as any;\n");
          }
          scoped({
            enter: () => {
              append("{\n");
              if (node.error) {
                append("const ");
                slice(node.error as Ranged);
                append(" = null as any;\n");
              }
            },
            leave: () => append("}\n"),
          }, () => fragment(node.catch!, depth + 1));
          append("}\n");
        }
        append("}\n");
        break;
      }
      case "KeyBlock":
        append("{\n");
        expr(node.expression as Ranged);
        fragment(node.fragment, depth + 1);
        append("}\n");
        break;
      case "Component":
      case "RegularElement":
      case "TitleElement":
      case "SlotElement":
      case "SvelteBody":
      case "SvelteComponent":
      case "SvelteDocument":
      case "SvelteElement":
      case "SvelteFragment":
      case "SvelteHead":
      case "SvelteSelf":
      case "SvelteWindow":
      case "SvelteBoundary":
      case "SvelteOptions":
        element(node, depth);
        break;
      default:
        fail(node);
    }
  }
  fragment(ast.fragment, 0);
  append("const __sv_slots = {\n");
  for (const [slotName, outlets] of slots) {
    append(`${JSON.stringify(slotName)}: __sv_slot_union([\n`);
    for (const slot of outlets) {
      append("(() => {\n");
      for (const context of slot.contexts) context.enter();
      append("return {\n");
      for (const attr of slot.node.attributes) {
        if (attr.type === "Attribute" && attr.name !== "name") {
          append(`${JSON.stringify(attr.name)}: `, attr.start);
          value(attr.value);
          append(",\n");
        } else if (attr.type === "SpreadAttribute") {
          append("...(");
          slice(attr.expression as Ranged);
          append("),\n");
        }
      }
      append("};\n");
      for (const context of slot.contexts.toReversed()) context.leave?.();
      append("})(),\n");
    }
    append("]),\n");
  }
  append("};\n");
}
