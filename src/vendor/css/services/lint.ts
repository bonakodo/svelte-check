/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See ../LICENSE.md for license information.
 *--------------------------------------------------------------------------------------------*/
import * as nodes from "../parser/cssNodes.ts";
import { type Rule, Rules } from "./lintRules.ts";
import { Element } from "./lintUtil.ts";

/** The built-in data used by default validation; no editor metadata is needed. */
export interface CssData {
  isKnownProperty(name: string): boolean;
  isStandardProperty(name: string): boolean;
  getAtDirective(name: string): boolean;
}

interface NamedNodes<T extends nodes.Node> {
  names: string[];
  nodes: T[];
}

class NodesByRootMap<T extends nodes.Node> {
  readonly data = new Map<string, NamedNodes<T>>();

  add(root: string, name: string, node?: T | null): void {
    let entry = this.data.get(root);
    if (!entry) {
      entry = { nodes: [], names: [] };
      this.data.set(root, entry);
    }
    entry.names.push(name);
    if (node) entry.nodes.push(node);
  }
}

export class LintVisitor implements nodes.INodeVisitor {
  private readonly warnings: nodes.Marker[] = [];
  private readonly keyframes = new NodesByRootMap<nodes.Node>();

  static entries(node: nodes.Node, data: CssData): nodes.Marker[] {
    const visitor = new LintVisitor(data);
    node.acceptVisitor(visitor);
    visitor.validateKeyframes();
    return visitor.warnings;
  }

  private constructor(private readonly data: CssData) {}

  private fetch(input: Element[], property: string): Element[] {
    return input.filter((entry) => entry.fullPropertyName === property);
  }

  private fetchWithValue(
    input: Element[],
    property: string,
    value: string,
  ): Element[] {
    return this.fetch(input, property).filter((entry) => {
      const expression = entry.node.getValue();
      return expression && this.findValueInExpression(expression, value);
    });
  }

  private findValueInExpression(
    expression: nodes.Node,
    value: string,
  ): boolean {
    let found = false;
    expression.accept((node) => {
      if (node.type === nodes.NodeType.Identifier && node.matches(value)) {
        found = true;
      }
      return !found;
    });
    return found;
  }

  private addEntry(node: nodes.Node, rule: Rule, details?: string): void {
    this.warnings.push(
      new nodes.Marker(node, rule, rule.defaultValue, details),
    );
  }

  visitNode(node: nodes.Node): boolean {
    if (node instanceof nodes.UnknownAtRule) {
      return this.visitUnknownAtRule(node);
    }
    if (node instanceof nodes.Keyframe) return this.visitKeyframe(node);
    if (node instanceof nodes.FontFace) return this.visitFontFace(node);
    if (node instanceof nodes.RuleSet) return this.visitRuleSet(node);
    if (node instanceof nodes.Function) return this.visitFunction(node);
    if (node instanceof nodes.HexColorValue) {
      return this.visitHexColorValue(node);
    }
    return true;
  }

  private visitUnknownAtRule(node: nodes.UnknownAtRule): boolean {
    const name = node.getChild(0);
    if (!name || this.data.getAtDirective(name.getText())) return false;
    this.addEntry(
      name,
      Rules.UnknownAtRules,
      `Unknown at rule ${name.getText()}`,
    );
    return true;
  }

  private visitKeyframe(node: nodes.Keyframe): boolean {
    const keyword = node.getKeyword();
    if (!keyword) return false;
    const text = keyword.getText();
    this.keyframes.add(
      node.getName(),
      text,
      text !== "@keyframes" ? keyword : null,
    );
    return true;
  }

  private validateKeyframes(): void {
    for (const { names, nodes: keywords } of this.keyframes.data.values()) {
      if (names.includes("@keyframes")) continue;
      for (const keyword of keywords) {
        this.addEntry(
          keyword,
          Rules.IncludeStandardPropertyWhenUsingVendorPrefix,
          "Always define standard rule '@keyframes' when defining keyframes.",
        );
      }
    }
  }

  private visitRuleSet(node: nodes.RuleSet): boolean {
    const declarations = node.getDeclarations();
    if (!declarations) return false;
    if (!declarations.hasChildren()) {
      this.addEntry(node.getSelectors(), Rules.EmptyRuleSet);
    }
    const properties = declarations.getChildren()
      .filter((child): child is nodes.Declaration =>
        child instanceof nodes.Declaration
      )
      .map((child) => new Element(child));

    // A float causes inline-block to be treated as block.
    if (this.fetchWithValue(properties, "display", "inline-block").length > 0) {
      for (const { node: declaration } of this.fetch(properties, "float")) {
        const value = declaration.getValue();
        if (value && !value.matches("none")) {
          this.addEntry(
            declaration,
            Rules.PropertyIgnoredDueToDisplay,
            "inline-block is ignored due to the float. If 'float' has a value other than 'none', the box is floated and 'display' is treated as 'block'",
          );
        }
      }
    }
    if (this.fetchWithValue(properties, "display", "block").length > 0) {
      for (
        const { node: declaration } of this.fetch(properties, "vertical-align")
      ) {
        this.addEntry(
          declaration,
          Rules.PropertyIgnoredDueToDisplay,
          "Property is ignored due to the display. With 'display: block', vertical-align should not be used.",
        );
      }
    }

    if (node.getSelectors().matches(":export")) return true;
    const propertiesBySuffix = new NodesByRootMap<nodes.Property>();
    let containsUnknowns = false;
    for (const element of properties) {
      const declaration = element.node;
      const property = this.cssProperty(declaration);
      if (!property) {
        containsUnknowns = true;
        continue;
      }
      let name = element.fullPropertyName;
      const firstChar = name.charAt(0);
      if (firstChar === "-") {
        if (name.charAt(1) !== "-") {
          propertiesBySuffix.add(
            declaration.getNonPrefixedPropertyName(),
            name,
            property,
          );
        }
      } else {
        const fullName = name;
        if (firstChar === "*" || firstChar === "_") name = name.slice(1);
        if (
          !this.data.isKnownProperty(fullName) &&
          !this.data.isKnownProperty(name)
        ) {
          this.addEntry(
            property,
            Rules.UnknownProperty,
            `Unknown property: '${declaration.getFullPropertyName()}'`,
          );
        }
        // Only prefixed properties receive a missing-standard-property warning.
        propertiesBySuffix.add(name, name);
      }
    }
    if (!containsUnknowns) {
      this.validateVendorPrefixes(node, propertiesBySuffix);
    }
    return true;
  }

  private validateVendorPrefixes(
    ruleSet: nodes.RuleSet,
    properties: NodesByRootMap<nodes.Property>,
  ): void {
    for (const [suffix, entry] of properties.data) {
      if (
        !this.data.isStandardProperty(suffix) || entry.names.includes(suffix)
      ) {
        continue;
      }
      const pseudoElements = this.getContextualVendorSpecificPseudoElements(
        ruleSet,
      );
      for (const property of entry.nodes) {
        const name = property.getName();
        const prefix = name.substring(0, name.length - suffix.length);
        if (pseudoElements.some((selector) => selector.startsWith(prefix))) {
          continue;
        }
        this.addEntry(
          property,
          Rules.IncludeStandardPropertyWhenUsingVendorPrefix,
          `Also define the standard property '${suffix}' for compatibility`,
        );
      }
    }
  }

  /** Include vendor pseudo-elements from this ruleset and its enclosing rulesets. */
  private getContextualVendorSpecificPseudoElements(
    node: nodes.RuleSet,
  ): string[] {
    const result = new Set<string>();
    const walkDown = (parent: nodes.Node): void => {
      for (const child of parent.getChildren()) {
        if (child.type === nodes.NodeType.PseudoSelector) {
          const name = child.getChild(0)?.getText();
          if (name) result.add(name);
        }
        walkDown(child);
      }
    };
    for (let parent: nodes.Node | null = node; parent; parent = parent.parent) {
      if (parent instanceof nodes.RuleSet) {
        for (const selector of parent.getSelectors().getChildren()) {
          walkDown(selector);
        }
      }
    }
    return [...result];
  }

  private visitFontFace(node: nodes.FontFace): boolean {
    const declarations = node.getDeclarations();
    if (!declarations) return false;
    let definesSrc = false;
    let definesFontFamily = false;
    let containsUnknowns = false;
    for (const declaration of declarations.getChildren()) {
      const property = this.cssProperty(declaration);
      if (property) {
        const name = property.getName().toLowerCase();
        if (name === "src") definesSrc = true;
        if (name === "font-family") definesFontFamily = true;
      } else {
        containsUnknowns = true;
      }
    }
    if (!containsUnknowns && (!definesSrc || !definesFontFamily)) {
      this.addEntry(node, Rules.RequiredPropertiesForFontFace);
    }
    return true;
  }

  /** Incomplete or interpolated declarations cannot take part in lint comparisons. */
  private cssProperty(node: nodes.Node): nodes.Property | undefined {
    if (!(node instanceof nodes.Declaration) || !node.getValue()) {
      return undefined;
    }
    const property = node.getProperty();
    const identifier = property?.getIdentifier();
    return identifier && !identifier.containsInterpolation()
      ? property ?? undefined
      : undefined;
  }

  private visitHexColorValue(node: nodes.HexColorValue): boolean {
    const length = node.length;
    if (![9, 7, 5, 4].includes(length)) {
      this.addEntry(node, Rules.HexColorLength);
    }
    return false;
  }

  private visitFunction(node: nodes.Function): boolean {
    const name = node.getName().toLowerCase();
    const expected = name === "rgb(" || name === "hsl("
      ? 3
      : name === "rgba(" || name === "hsla("
      ? 4
      : -1;
    if (expected !== -1) {
      let actual = 0;
      node.getArguments().accept((child) => {
        if (child instanceof nodes.BinaryExpression) {
          actual++;
          return false;
        }
        return true;
      });
      if (actual !== expected) this.addEntry(node, Rules.ArgsInColorFunction);
    }
    return true;
  }
}
