// @ts-ignore
import syntaxJSX from "@babel/plugin-syntax-jsx";
// import { getInlinePolyfill, getExternalPolyfill } from "./polyfill.js";
import type { NodePath, PluginObj } from "@babel/core";
import type {
  JSXElement,
  JSXFragment,
  JSXNamespacedName,
  Expression,
  JSXMemberExpression,
  JSXIdentifier,
  Identifier,
  MemberExpression,
  StringLiteral,
  JSXOpeningElement, JSXAttribute, JSXSpreadAttribute,
  NumericLiteral, NullLiteral, BooleanLiteral, BigIntLiteral, DecimalLiteral
} from "@babel/types";
import * as t from "@babel/types";

export default function(
  { template }: typeof import("@babel/core"),
  { polyfill = "import" }: { polyfill?: "import" | "inline" | false } = {}
): PluginObj {
  if (polyfill !== false && polyfill !== "inline" && polyfill !== "import") {
    throw new Error(
      `The .polyfill option must be one of: false, "inline", "import".`
    );
  }
  /*
    function buildReference({ scope }: NodePath<JSXElement | JSXFragment>) {
      const ref = scope.generateUidIdentifier("templateReference");
      const programScope = scope.getProgramParent();
      programScope.push({ id: t.cloneNode(ref), init: t.objectExpression([]) });

      ensurePolyfill(programScope.path as NodePath<Program>);
      return ref;
    }

    const polyfillInjected = new WeakSet();

    function ensurePolyfill(programPath: NodePath<Program>) {
      if (!polyfill || polyfillInjected.has(programPath.node)) return;
      polyfillInjected.add(programPath.node);

      if (programPath.scope.hasBinding("ESXToken")) return;
      programPath.unshiftContainer(
        "body",
        polyfill === "inline"
          ? getInlinePolyfill(template)
          : getExternalPolyfill(template)
      );
    }*/

  return {
    inherits: syntaxJSX.default,
    visitor: {
      JSXElement(path) {
        transform(path);
      },
      JSXFragment(path) {
        transform(path);
      }
    }
  };
}

type JsxPath = NodePath<JSXElement | JSXFragment>

function transform(path: JsxPath) {
  const dynamics: Expression[] = [];
  const tag = transformElement(path, dynamics);
  if (dynamics.length)
    t.addComment(tag, "leading", `${dynamics.length} dynamics`);

  const {scope} = path
  const ref = scope.generateUidIdentifier('esx')
  const programScope = scope.getProgramParent();
  programScope.push({ id: t.cloneNode(ref), init: tag });

  path.replaceWith(newInstance(ref, dynamics));
}

const newInstance = (e: Expression, dynamics: Expression[]) =>
  t.newExpression(
    t.identifier("ESXInstance"),
    [e, t.arrayExpression(dynamics)]
  );

function jsxToString(node: JSXIdentifier | JSXNamespacedName): StringLiteral {
  let str = t.isJSXNamespacedName(node)
    ? `${node.namespace.name}:${node.name.name}`
    : node.name;
  return t.inherits(t.stringLiteral(str), node);
}

function jsxToJS(node: JSXIdentifier | JSXMemberExpression): MemberExpression | Identifier {
  if (t.isJSXMemberExpression(node)) {
    return t.inherits(
      t.memberExpression(jsxToJS(node.object), jsxToJS(node.property)),
      node
    );
  }
  return t.inherits(t.identifier(node.name), node);
}

const getChildren = (path: NodePath<JSXElement | JSXFragment>, dynamics: Expression[]): Expression[] =>
  path.get("children").map(c => transformChild(c, dynamics)).filter((n): n is Expression => !!n);

type ConstLiteral = StringLiteral | NumericLiteral | NullLiteral | BooleanLiteral | BigIntLiteral | DecimalLiteral

const isConstLiteral = (e: Expression): e is ConstLiteral =>
  t.isStringLiteral(e) || t.isNumericLiteral(e) || t.isNullLiteral(e)
  || t.isBooleanLiteral(e) || t.isBigIntLiteral(e) || t.isDecimalLiteral(e);

function constSlot(expr?: ConstLiteral) {
  return t.newExpression(
    t.identifier("ESXSlot"),
    expr ? [expr] : []
  );
}

function newSlot(expr: Expression, dynamics: Expression[]) {
  //possibly we can also count const vars of const literals or of top-level arrow functions
  //but, it's not clear how it should be hoisted now
  const dynamic = !isConstLiteral(expr);
  const e = constSlot(dynamic ? undefined : expr);
  if (dynamic) {
    dynamics.push(expr);
    t.addComment(e, "leading", dynamics.length.toString());
  }
  return e;
}

const isElementPath = (path: JsxPath): path is NodePath<JSXElement> =>
  t.isJSXElement(path.node);

const transformAttributesList = (path: NodePath<JSXOpeningElement>, dynamics: Expression[]) =>
  t.arrayExpression(path.get("attributes").map(a => transformAttribute(a, dynamics)));

function transformElement(path: JsxPath, dynamics: Expression[]): Expression {
  let elem, attrs;
  if (isElementPath(path)) {
    const { node } = path;
    const jsxElementName = node.openingElement.name;

    let element;
    if (
      t.isJSXNamespacedName(jsxElementName) ||
      (t.isJSXIdentifier(jsxElementName) && /^[a-z]/.test(jsxElementName.name))
    ) {
      element = jsxToString(jsxElementName);
    } else {
      element = jsxToJS(jsxElementName);
    }
    elem = newSlot(element, dynamics);
    attrs = transformAttributesList(path.get("openingElement"), dynamics);
  } else {
    elem = t.nullLiteral();
    attrs = t.arrayExpression();
  }
  const children = getChildren(path, dynamics);

  return t.newExpression(
    t.identifier("ESXTag"),
    [
      elem,
      attrs,
      t.arrayExpression(children)
    ]
  );
}

const newAttr = (name: string | null, value: Expression, dynamics: Expression[]) =>
  t.newExpression(
    t.identifier("ESXAttribute"),
    [name ? t.stringLiteral(name) : t.nullLiteral(), newSlot(value, dynamics)]
  );

function transformAttribute(path: NodePath<JSXAttribute | JSXSpreadAttribute>, dynamics: Expression[]) {
  const node = path.node;

  if (t.isJSXSpreadAttribute(node)) {
    // {...obj}
    return t.inherits(newAttr(null, node.argument, dynamics), node);
  }

  let name: StringLiteral, value: Expression;
  if (t.isJSXExpressionContainer(node.value)) {
    name = jsxToString(node.name);
    //empty expression in arguments is syntax error in babel jsx parser
    value = node.value.expression as Expression;
  } else if (t.isJSXElement(node.value) || t.isJSXFragment(node.value)) {
    throw (path as NodePath<JSXAttribute>)
      .get("value")
      .buildCodeFrameError(
        "JSX elements are not supported as static attributes. Please wrap it in { }."
      );
  } else if (node.value) {
    name = jsxToString(node.name);
    value = node.value;
  } else {
    name = jsxToString(node.name);
    value = t.booleanLiteral(true);
  }

  return t.inherits(
    newAttr(name.value, value, dynamics),
    node
  );
}

function transformChild(path: NodePath<JSXElement["children"][number]>, dynamics: Expression[]): Expression | null {
  const node = path.node;

  if (t.isJSXExpressionContainer(node)) {
    if (t.isJSXEmptyExpression(node.expression))
      return null;
    return newSlot(node.expression, dynamics);
  } else if (t.isJSXSpreadChild(node)) {
    // <div>{...foo}</div>
    throw path.buildCodeFrameError(
      "Spread children are not supported. Please delete the ... token."
    );
  } else if (t.isJSXText(node)) {
    // Empty text to insert a new line in the code, skip it
    if (node.value.trim() === "" && /[\r\n]/.test(node.value)) {
      return null;
    }
    return constSlot(t.stringLiteral(node.value));
  } else if (t.isJSXElement(node) || t.isJSXFragment(node)) {
    return transformElement(path as JsxPath, dynamics);
  }

  assertUnreachable(node);
}

function assertUnreachable(x: never): never {
  throw new Error(`Should be unreachable, but got ${x}`);
}