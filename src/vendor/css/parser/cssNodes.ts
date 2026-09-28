/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See ../LICENSE.md for license information.
 *--------------------------------------------------------------------------------------------*/

export enum NodeType {
  Undefined = 0,
  Identifier = 1,
  Stylesheet = 2,
  Ruleset = 3,
  Selector = 4,
  SimpleSelector = 5,
  SelectorCombinator = 7,
  SelectorCombinatorParent = 8,
  SelectorCombinatorSibling = 9,
  SelectorCombinatorAllSiblings = 10,
  SelectorCombinatorShadowPiercingDescendant = 11,
  Page = 12,
  PageBoxMarginBox = 13,
  ClassSelector = 14,
  IdentifierSelector = 15,
  ElementNameSelector = 16,
  PseudoSelector = 17,
  AttributeSelector = 18,
  Declaration = 19,
  Declarations = 20,
  Property = 21,
  Expression = 22,
  BinaryExpression = 23,
  Term = 24,
  Operator = 25,
  StringLiteral = 27,
  URILiteral = 28,
  Function = 30,
  NumericValue = 31,
  HexColorValue = 32,
  RatioValue = 33,
  MixinDeclaration = 34,
  MixinReference = 35,
  VariableDeclaration = 37,
  Prio = 38,
  NestedProperties = 40,
  ExtendsReference = 41,
  Debug = 43,
  If = 44,
  For = 46,
  Each = 47,
  While = 48,
  MixinContentReference = 49,
  MixinContentDeclaration = 50,
  Media = 51,
  Scope = 52,
  Keyframe = 53,
  FontFace = 54,
  Import = 55,
  Namespace = 56,
  Invocation = 57,
  FunctionDeclaration = 58,
  ReturnStatement = 59,
  MediaQuery = 60,
  MediaCondition = 61,
  MediaFeature = 62,
  FunctionArgument = 64,
  KeyframeSelector = 65,
  ViewPort = 66,
  Document = 67,
  AtApplyRule = 68,
  CustomPropertyDeclaration = 69,
  CustomPropertySet = 70,
  Supports = 72,
  SupportsCondition = 73,
  NamespacePrefix = 74,
  GridLine = 75,
  UnknownAtRule = 77,
  UnicodeRange = 83,
  Layer = 84,
  LayerNameList = 85,
  LayerName = 86,
  PropertyAtRule = 87,
  Container = 88,
  SelectorList = 90,
  StartingStyleAtRule = 91,
}

export enum ReferenceType {
  Function = 3,
  Keyframe = 4,
  Property = 9,
}

export interface ITextProvider {
  (offset: number, length: number): string;
}

export class Node {
  parent: Node | null;

  offset: number;
  length: number;
  semicolonPosition?: number;
  get end() {
    return this.offset + this.length;
  }

  options: Record<string, unknown> | undefined;

  textProvider: ITextProvider | undefined; // only set on the root node

  private children: Node[] | undefined;
  private issues: IMarker[] | undefined;

  private nodeType: NodeType | undefined;

  constructor(offset: number = -1, len: number = -1, nodeType?: NodeType) {
    this.parent = null;
    this.offset = offset;
    this.length = len;
    if (nodeType) {
      this.nodeType = nodeType;
    }
  }

  set type(type: NodeType) {
    this.nodeType = type;
  }

  get type(): NodeType {
    return this.nodeType || NodeType.Undefined;
  }

  private getTextProvider(): ITextProvider {
    if (this.textProvider) return this.textProvider;
    for (let node = this.parent; node; node = node.parent) {
      if (node.textProvider) return node.textProvider;
    }
    return () => {
      return "unknown";
    };
  }

  getText(): string {
    return this.getTextProvider()(this.offset, this.length);
  }

  matches(str: string): boolean {
    return this.length === str.length &&
      this.getTextProvider()(this.offset, this.length) === str;
  }

  startsWith(str: string): boolean {
    return this.length >= str.length &&
      this.getTextProvider()(this.offset, str.length) === str;
  }

  endsWith(str: string): boolean {
    return this.length >= str.length &&
      this.getTextProvider()(this.end - str.length, str.length) === str;
  }

  accept(visitor: IVisitorFunction): void {
    if (visitor(this) && this.children) {
      for (const child of this.children) {
        child.accept(visitor);
      }
    }
  }

  acceptVisitor(visitor: INodeVisitor): void {
    this.accept(visitor.visitNode.bind(visitor));
  }

  adoptChild(node: Node, index: number = -1): Node {
    if (node.parent && node.parent.children) {
      const idx = node.parent.children.indexOf(node);
      if (idx >= 0) {
        node.parent.children.splice(idx, 1);
      }
    }
    node.parent = this;
    let children = this.children;
    if (!children) {
      children = this.children = [];
    }
    if (index !== -1) {
      children.splice(index, 0, node);
    } else {
      children.push(node);
    }
    return node;
  }

  attachTo(parent: Node | null, index: number = -1): Node {
    if (parent) {
      parent.adoptChild(this, index);
    }
    return this;
  }

  collectIssues(results: IMarker[]): void {
    if (this.issues) {
      results.push.apply(results, this.issues);
    }
  }

  addIssue(issue: IMarker): void {
    if (!this.issues) {
      this.issues = [];
    }
    this.issues.push(issue);
  }

  hasIssue(rule: IRule): boolean {
    return Array.isArray(this.issues) &&
      this.issues.some((i) => i.getRule() === rule);
  }

  isErroneous(recursive: boolean = false): boolean {
    if (this.issues && this.issues.length > 0) {
      return true;
    }
    return recursive && Array.isArray(this.children) &&
      this.children.some((c) => c.isErroneous(true));
  }

  protected setNode<T extends Node>(
    node: T | null,
    assign: (node: T) => void,
    index = -1,
  ): node is T {
    if (node) {
      node.attachTo(this, index);
      assign(node);
      return true;
    }
    return false;
  }

  addChild(node: Node | null): node is Node {
    if (node) {
      if (!this.children) {
        this.children = [];
      }
      node.attachTo(this);
      this.updateOffsetAndLength(node);
      return true;
    }
    return false;
  }

  private updateOffsetAndLength(node: Node): void {
    if (node.offset < this.offset || this.offset === -1) {
      this.offset = node.offset;
    }
    const nodeEnd = node.end;
    if ((nodeEnd > this.end) || this.length === -1) {
      this.length = nodeEnd - this.offset;
    }
  }

  hasChildren(): boolean {
    return !!this.children && this.children.length > 0;
  }

  getChildren(): Node[] {
    return this.children ? this.children.slice(0) : [];
  }

  getChild(index: number): Node | null {
    if (this.children && index < this.children.length) {
      return this.children[index];
    }
    return null;
  }

  addChildren(nodes: Node[]): void {
    for (const node of nodes) {
      this.addChild(node);
    }
  }

  findFirstChildBeforeOffset(offset: number): Node | null {
    if (this.children) {
      let current: Node | null = null;
      for (let i = this.children.length - 1; i >= 0; i--) {
        // iterate until we find a child that has a start offset smaller than the input offset
        current = this.children[i];
        if (current.offset <= offset) {
          return current;
        }
      }
    }
    return null;
  }

  findChildAtOffset(offset: number, goDeep: boolean): Node | null {
    const current: Node | null = this.findFirstChildBeforeOffset(offset);
    if (current && current.end >= offset) {
      if (goDeep) {
        return current.findChildAtOffset(offset, true) || current;
      }
      return current;
    }
    return null;
  }

  encloses(candidate: Node): boolean {
    return this.offset <= candidate.offset &&
      this.offset + this.length >= candidate.offset + candidate.length;
  }

  getParent(): Node | null {
    let result = this.parent;
    while (result instanceof Nodelist) {
      result = result.parent;
    }
    return result;
  }

  findParent(type: NodeType): Node | null {
    if (this.type === type) return this;
    let result = this.parent;
    while (result && result.type !== type) {
      result = result.parent;
    }
    return result;
  }

  findAParent(...types: NodeType[]): Node | null {
    if (types.includes(this.type)) return this;
    let result = this.parent;
    while (result && !types.includes(result.type)) {
      result = result.parent;
    }
    return result;
  }

  setData(key: string, value: unknown): void {
    if (!this.options) {
      this.options = {};
    }
    this.options[key] = value;
  }

  getData(key: string): unknown {
    if (
      !this.options || !Object.prototype.hasOwnProperty.call(this.options, key)
    ) {
      return null;
    }
    return this.options[key];
  }
}

export class Nodelist extends Node {
  constructor(parent: Node, index: number = -1) {
    super(-1, -1);
    this.attachTo(parent, index);
    this.offset = -1;
    this.length = -1;
  }
}

export class UnicodeRange extends Node {
  rangeStart?: Node;
  rangeEnd?: Node;

  override get type(): NodeType {
    return NodeType.UnicodeRange;
  }

  setRangeStart(rangeStart: Node | null): rangeStart is Node {
    return this.setNode(rangeStart, (child) => {
      this.rangeStart = child;
    });
  }

  getRangeStart(): Node | undefined {
    return this.rangeStart;
  }

  setRangeEnd(rangeEnd: Node | null): rangeEnd is Node {
    return this.setNode(rangeEnd, (child) => {
      this.rangeEnd = child;
    });
  }

  getRangeEnd(): Node | undefined {
    return this.rangeEnd;
  }
}

export class Identifier extends Node {
  referenceTypes?: ReferenceType[];
  isCustomProperty = false;

  override get type(): NodeType {
    return NodeType.Identifier;
  }

  containsInterpolation(): boolean {
    return this.hasChildren();
  }
}

export class Stylesheet extends Node {
  override get type(): NodeType {
    return NodeType.Stylesheet;
  }
}

export class Declarations extends Node {
  override get type(): NodeType {
    return NodeType.Declarations;
  }
}

export class BodyDeclaration extends Node {
  declarations?: Declarations;

  getDeclarations(): Declarations | undefined {
    return this.declarations;
  }

  setDeclarations(decls: Declarations | null): decls is Declarations {
    return this.setNode(decls, (child) => {
      this.declarations = child;
    });
  }
}

export class RuleSet extends BodyDeclaration {
  private selectors?: Nodelist;

  override get type(): NodeType {
    return NodeType.Ruleset;
  }

  getSelectors(): Nodelist {
    if (!this.selectors) {
      this.selectors = new Nodelist(this);
    }
    return this.selectors;
  }

  isNested(): boolean {
    return !!this.parent &&
      this.parent.findParent(NodeType.Declarations) !== null;
  }
}

export class Selector extends Node {
  override get type(): NodeType {
    return NodeType.Selector;
  }
}

export class SimpleSelector extends Node {
  override get type(): NodeType {
    return NodeType.SimpleSelector;
  }
}

export class AbstractDeclaration extends Node {
  // positions for code assist
  colonPosition: number | undefined;
}

export class CustomPropertySet extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.CustomPropertySet;
  }
}

export class Declaration extends AbstractDeclaration {
  property: Property | null = null;
  value?: Expression;
  nestedProperties?: NestedProperties;

  override get type(): NodeType {
    return NodeType.Declaration;
  }

  setProperty(node: Property | null): node is Property {
    return this.setNode(node, (child) => {
      this.property = child;
    });
  }

  getProperty(): Property | null {
    return this.property;
  }

  getFullPropertyName(): string {
    const propertyName = this.property ? this.property.getName() : "unknown";
    const parent = this.parent instanceof Declarations
      ? this.parent.getParent()
      : null;
    if (parent instanceof NestedProperties) {
      const parentDecl = parent.getParent();
      if (parentDecl instanceof Declaration) {
        return parentDecl.getFullPropertyName() + propertyName;
      }
    }
    return propertyName;
  }

  getNonPrefixedPropertyName(): string {
    const propertyName = this.getFullPropertyName();
    if (propertyName && propertyName.charAt(0) === "-") {
      const vendorPrefixEnd = propertyName.indexOf("-", 1);
      if (vendorPrefixEnd !== -1) {
        return propertyName.substring(vendorPrefixEnd + 1);
      }
    }
    return propertyName;
  }

  setValue(value: Expression | null): value is Expression {
    return this.setNode(value, (child) => {
      this.value = child;
    });
  }

  getValue(): Expression | undefined {
    return this.value;
  }

  setNestedProperties(
    value: NestedProperties | null,
  ): value is NestedProperties {
    return this.setNode(value, (child) => {
      this.nestedProperties = child;
    });
  }

  getNestedProperties(): NestedProperties | undefined {
    return this.nestedProperties;
  }
}

export class CustomPropertyDeclaration extends Declaration {
  propertySet?: CustomPropertySet;

  override get type(): NodeType {
    return NodeType.CustomPropertyDeclaration;
  }

  setPropertySet(
    value: CustomPropertySet | null,
  ): value is CustomPropertySet {
    return this.setNode(value, (child) => {
      this.propertySet = child;
    });
  }

  getPropertySet(): CustomPropertySet | undefined {
    return this.propertySet;
  }
}

export class Property extends Node {
  identifier?: Identifier;

  override get type(): NodeType {
    return NodeType.Property;
  }

  setIdentifier(value: Identifier | null): value is Identifier {
    return this.setNode(value, (child) => {
      this.identifier = child;
    });
  }

  getIdentifier(): Identifier | undefined {
    return this.identifier;
  }

  getName(): string {
    const text = this.getText();
    const suffix = /[_+]+$/.exec(text); // Preserve merge suffix handling.
    return suffix ? text.slice(0, text.length - suffix[0].length) : text;
  }

  isCustomProperty(): boolean {
    return !!this.identifier && this.identifier.isCustomProperty;
  }
}

export class Invocation extends Node {
  private arguments?: Nodelist;

  override get type(): NodeType {
    return NodeType.Invocation;
  }

  getArguments(): Nodelist {
    if (!this.arguments) {
      this.arguments = new Nodelist(this);
    }
    return this.arguments;
  }
}

export class Function extends Invocation {
  identifier?: Identifier;

  override get type(): NodeType {
    return NodeType.Function;
  }

  setIdentifier(node: Identifier | null): node is Identifier {
    return this.setNode(node, (child) => {
      this.identifier = child;
    }, 0);
  }

  getIdentifier(): Identifier | undefined {
    return this.identifier;
  }

  getName(): string {
    return this.identifier ? this.identifier.getText() : "";
  }
}

export class FunctionArgument extends Node {
  identifier?: Node;
  value?: Node;

  override get type(): NodeType {
    return NodeType.FunctionArgument;
  }

  setIdentifier(node: Node | null): node is Node {
    return this.setNode(node, (child) => {
      this.identifier = child;
    }, 0);
  }

  getIdentifier(): Node | undefined {
    return this.identifier;
  }

  getName(): string {
    return this.identifier ? this.identifier.getText() : "";
  }

  setValue(node: Node | null): node is Node {
    return this.setNode(node, (child) => {
      this.value = child;
    }, 0);
  }

  getValue(): Node | undefined {
    return this.value;
  }
}

export class ViewPort extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.ViewPort;
  }
}

export class FontFace extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.FontFace;
  }
}

export class NestedProperties extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.NestedProperties;
  }
}

export class Keyframe extends BodyDeclaration {
  keyword?: Node;
  identifier?: Node;

  override get type(): NodeType {
    return NodeType.Keyframe;
  }

  setKeyword(keyword: Node | null): keyword is Node {
    return this.setNode(keyword, (child) => {
      this.keyword = child;
    }, 0);
  }

  getKeyword(): Node | undefined {
    return this.keyword;
  }

  setIdentifier(node: Node | null): node is Node {
    return this.setNode(node, (child) => {
      this.identifier = child;
    }, 0);
  }

  getIdentifier(): Node | undefined {
    return this.identifier;
  }

  getName(): string {
    return this.identifier ? this.identifier.getText() : "";
  }
}

export class KeyframeSelector extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.KeyframeSelector;
  }
}

export class Import extends Node {
  override get type(): NodeType {
    return NodeType.Import;
  }

  setMedialist(node: Node | null): node is Node {
    if (node) {
      node.attachTo(this);
      return true;
    }
    return false;
  }
}

export class Namespace extends Node {
  override get type(): NodeType {
    return NodeType.Namespace;
  }
}

export class Media extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.Media;
  }
}

export class Scope extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.Scope;
  }
}

export class ScopeLimits extends Node {
  scopeStart?: Node;
  scopeEnd?: Node;

  override get type(): NodeType {
    return NodeType.Scope;
  }

  getScopeStart(): Node | undefined {
    return this.scopeStart;
  }

  setScopeStart(right: Node | null): right is Node {
    return this.setNode(right, (child) => {
      this.scopeStart = child;
    });
  }

  getScopeEnd(): Node | undefined {
    return this.scopeEnd;
  }

  setScopeEnd(right: Node | null): right is Node {
    return this.setNode(right, (child) => {
      this.scopeEnd = child;
    });
  }

  getName(): string {
    let name = "";

    if (this.scopeStart) {
      name += this.scopeStart.getText();
    }
    if (this.scopeEnd) {
      name += `${this.scopeStart ? " " : ""}→ ${this.scopeEnd.getText()}`;
    }

    return name;
  }
}

export class Supports extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.Supports;
  }
}

export class Layer extends BodyDeclaration {
  names?: Node;

  override get type(): NodeType {
    return NodeType.Layer;
  }

  setNames(names: Node | null): names is Node {
    return this.setNode(names, (child) => {
      this.names = child;
    });
  }

  getNames(): Node | undefined {
    return this.names;
  }
}

export class PropertyAtRule extends BodyDeclaration {
  private name: Identifier | undefined;

  override get type(): NodeType {
    return NodeType.PropertyAtRule;
  }

  setName(node: Identifier | undefined | null): node is Identifier {
    if (node) {
      node.attachTo(this);
      this.name = node;
      return true;
    }
    return false;
  }

  getName(): Identifier | undefined {
    return this.name;
  }
}

export class StartingStyleAtRule extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.StartingStyleAtRule;
  }
}

export class Document extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.Document;
  }
}

export class Container extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.Container;
  }
}

export class Medialist extends Node {
}

export class MediaQuery extends Node {
  override get type(): NodeType {
    return NodeType.MediaQuery;
  }
}

export class MediaCondition extends Node {
  override get type(): NodeType {
    return NodeType.MediaCondition;
  }
}

export class MediaFeature extends Node {
  override get type(): NodeType {
    return NodeType.MediaFeature;
  }
}

export class SupportsCondition extends Node {
  lParent?: number;
  rParent?: number;

  override get type(): NodeType {
    return NodeType.SupportsCondition;
  }
}

export class Page extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.Page;
  }
}

export class PageBoxMarginBox extends BodyDeclaration {
  override get type(): NodeType {
    return NodeType.PageBoxMarginBox;
  }
}

export class Expression extends Node {
  override get type(): NodeType {
    return NodeType.Expression;
  }
}

export class BinaryExpression extends Node {
  left?: Node;
  right?: Node;
  operator?: Node;

  override get type(): NodeType {
    return NodeType.BinaryExpression;
  }

  setLeft(left: Node | null): left is Node {
    return this.setNode(left, (child) => {
      this.left = child;
    });
  }

  getLeft(): Node | undefined {
    return this.left;
  }

  setRight(right: Node | null): right is Node {
    return this.setNode(right, (child) => {
      this.right = child;
    });
  }

  getRight(): Node | undefined {
    return this.right;
  }

  setOperator(value: Node | null): value is Node {
    return this.setNode(value, (child) => {
      this.operator = child;
    });
  }

  getOperator(): Node | undefined {
    return this.operator;
  }
}

export class Term extends Node {
  operator?: Node;
  expression?: Node;

  override get type(): NodeType {
    return NodeType.Term;
  }

  setOperator(value: Node | null): value is Node {
    return this.setNode(value, (child) => {
      this.operator = child;
    });
  }

  getOperator(): Node | undefined {
    return this.operator;
  }

  setExpression(value: Node | null): value is Node {
    return this.setNode(value, (child) => {
      this.expression = child;
    });
  }

  getExpression(): Node | undefined {
    return this.expression;
  }
}

export class AttributeSelector extends Node {
  namespacePrefix?: Node;
  identifier?: Identifier;
  operator?: Node;
  value?: BinaryExpression;

  override get type(): NodeType {
    return NodeType.AttributeSelector;
  }

  setNamespacePrefix(value: Node | null): value is Node {
    return this.setNode(value, (child) => {
      this.namespacePrefix = child;
    });
  }

  getNamespacePrefix(): Node | undefined {
    return this.namespacePrefix;
  }

  setIdentifier(value: Identifier | null): value is Identifier {
    return this.setNode(value, (child) => {
      this.identifier = child;
    });
  }

  getIdentifier(): Identifier | undefined {
    return this.identifier;
  }

  setOperator(operator: Node | null): operator is Node {
    return this.setNode(operator, (child) => {
      this.operator = child;
    });
  }

  getOperator(): Node | undefined {
    return this.operator;
  }

  setValue(value: BinaryExpression | null): value is BinaryExpression {
    return this.setNode(value, (child) => {
      this.value = child;
    });
  }

  getValue(): BinaryExpression | undefined {
    return this.value;
  }
}

export class HexColorValue extends Node {
  override get type(): NodeType {
    return NodeType.HexColorValue;
  }
}

export class RatioValue extends Node {
  override get type(): NodeType {
    return NodeType.RatioValue;
  }
}

const _dot = ".".charCodeAt(0), _0 = "0".charCodeAt(0), _9 = "9".charCodeAt(0);

export class NumericValue extends Node {
  override get type(): NodeType {
    return NodeType.NumericValue;
  }

  getValue(): { value: string; unit?: string } {
    const raw = this.getText();
    let unitIdx = 0;
    let code: number;
    for (let i = 0, len = raw.length; i < len; i++) {
      code = raw.charCodeAt(i);
      if (!(_0 <= code && code <= _9 || code === _dot)) {
        break;
      }
      unitIdx += 1;
    }
    return {
      value: raw.substring(0, unitIdx),
      unit: unitIdx < raw.length ? raw.substring(unitIdx) : undefined,
    };
  }
}

export class UnknownAtRule extends BodyDeclaration {
  atRuleName?: string;

  override get type(): NodeType {
    return NodeType.UnknownAtRule;
  }

  setAtRuleName(atRuleName: string) {
    this.atRuleName = atRuleName;
  }
  getAtRuleName() {
    return this.atRuleName;
  }
}

export interface IRule {
  id: string;
  message: string;
}

export enum Level {
  Ignore = 1,
  Warning = 2,
  Error = 4,
}

export interface IMarker {
  getNode(): Node;
  getMessage(): string;
  getOffset(): number;
  getLength(): number;
  getRule(): IRule;
  getLevel(): Level;
}

export class Marker implements IMarker {
  private node: Node;
  private rule: IRule;
  private level: Level;
  private message: string;
  private offset: number;
  private length: number;

  constructor(
    node: Node,
    rule: IRule,
    level: Level,
    message?: string,
    offset: number = node.offset,
    length: number = node.length,
  ) {
    this.node = node;
    this.rule = rule;
    this.level = level;
    this.message = message || rule.message;
    this.offset = offset;
    this.length = length;
  }

  getRule(): IRule {
    return this.rule;
  }

  getLevel(): Level {
    return this.level;
  }

  getOffset(): number {
    return this.offset;
  }

  getLength(): number {
    return this.length;
  }

  getNode(): Node {
    return this.node;
  }

  getMessage(): string {
    return this.message;
  }
}

export interface INodeVisitor {
  visitNode: (node: Node) => boolean;
}

export interface IVisitorFunction {
  (node: Node): boolean;
}

export class ParseErrorCollector implements INodeVisitor {
  static entries(node: Node): IMarker[] {
    const visitor = new ParseErrorCollector();
    node.acceptVisitor(visitor);
    return visitor.entries;
  }

  entries: IMarker[];

  constructor() {
    this.entries = [];
  }

  visitNode(node: Node): boolean {
    if (node.isErroneous()) {
      node.collectIssues(this.entries);
    }
    return true;
  }
}
