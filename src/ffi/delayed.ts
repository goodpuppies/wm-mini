import type { Decl, Expr, Param, TypeExpr } from "../ast.ts";
import { diagnosticError } from "../diagnostics.ts";
import type { InferResult } from "../infer.ts";
import { prune, show, type Ty } from "../types.ts";
import {
  addVariants,
  callArgHint,
  callHintKey,
  dynamicReceiverArgType,
  type FfiBinding,
  type FfiElaboration,
  type FfiVariant,
  fn,
  generatedReceiverJsImports,
  isDecl,
  memberVariants,
  name,
  nameArgs,
  paramBinder,
  prependReceiver,
  refsForCallbackArg,
  selectVariant,
  tvar,
} from "./shared.ts";
import { rewriteExprCalls } from "./elab.ts";
import { resultRefForExpr } from "./receiver.ts";
import {
  type JsMemberType,
  jsPrimitiveValueRef,
  jsRefCallMember,
  jsRefMember,
  jsRefTypeExpr,
  type JsTypeRef,
} from "./js_types.ts";

type ResolveOptions = {
  receiverTypes?: Map<Expr, Ty>;
  foreignTypeRefs?: Map<string, JsTypeRef>;
};

export function resolveDelayedFfiElaboration(
  ffi: FfiElaboration,
  result: InferResult,
  options: ResolveOptions = {},
): FfiElaboration {
  rejectAnnotatedDynamicCallbacks(ffi.module.decls, ffi.bindings);
  const selected = new Set<string>();
  const valueRefs = new Map<string, JsTypeRef>();
  const decls: Decl[] = [];
  for (const decl of ffi.module.decls) {
    const resolved = resolveDelayedDecl(decl, ffi, result, selected, options, valueRefs);
    rememberDelayedLetRefs(resolved, ffi, valueRefs);
    decls.push(resolved);
  }
  const module = {
    ...ffi.module,
    decls,
  };
  const foreignDecls = generatedForeignDeclsForOverrides(module.decls, options.receiverTypes);
  const imports = generatedReceiverJsImports(ffi.bindings, selected);
  const prefixLength = generatedImportInsertionIndex(module.decls);
  return {
    ...ffi,
    module: imports.length || foreignDecls.length
      ? {
        ...module,
        decls: [
          ...module.decls.slice(0, prefixLength),
          ...foreignDecls,
          ...imports,
          ...module.decls.slice(prefixLength),
        ],
      }
      : module,
    selected: new Set([...ffi.selected, ...selected]),
  };
}

function generatedImportInsertionIndex(decls: Decl[]): number {
  let lastTypeDecl = -1;
  for (let index = 0; index < decls.length; index++) {
    const kind = decls[index].kind;
    if (kind === "ForeignTypeDecl" || kind === "RecordDecl" || kind === "TypeDecl") {
      lastTypeDecl = index;
    }
  }
  if (lastTypeDecl !== -1) return lastTypeDecl + 1;
  const firstLet = decls.findIndex((decl) => decl.kind === "LetDecl");
  return firstLet === -1 ? decls.length : firstLet;
}

function rejectAnnotatedDynamicCallbacks(
  decls: Decl[],
  bindings: Map<string, FfiBinding>,
) {
  const annotatedLambdas = annotatedLambdaBindings(decls);
  const variants = new Map<string, FfiVariant>();
  for (const binding of bindings.values()) {
    for (const variant of binding.variants) variants.set(variant.internalName, variant);
    if (binding.variants.length === 1) variants.set(binding.surfaceName, binding.variants[0]);
  }
  const visit = (expr: Expr) => {
    switch (expr.kind) {
      case "FfiCall":
        expr.args.forEach((arg) => rejectAnnotatedCallbackArg(arg, annotatedLambdas));
        visit(expr.receiver);
        expr.args.forEach(visit);
        return;
      case "Call": {
        const variant = expr.callee.kind === "Var" ? variants.get(expr.callee.name) : undefined;
        if (variant?.target.kind === "JsReceiver" && expr.callee.kind === "Var") {
          const dynamic = expr.callee.name.includes("__dynamic");
          if (dynamic) expr.args.forEach((arg) => rejectAnnotatedCallbackArg(arg, annotatedLambdas));
        }
        visit(expr.callee);
        expr.args.forEach(visit);
        return;
      }
      case "Tuple":
      case "JsonArray":
        expr.items.forEach(visit);
        return;
      case "Record":
      case "JsonObject":
        expr.fields.forEach((field) => visit(field.value));
        return;
      case "Lambda":
        visit(expr.body);
        return;
      case "If":
        visit(expr.cond);
        visit(expr.thenExpr);
        visit(expr.elseExpr);
        return;
      case "Match":
        visit(expr.value);
        expr.arms.forEach((arm) => visit(arm.body));
        return;
      case "Panic":
        visit(expr.message);
        return;
      case "Block":
        for (const item of expr.items) {
          if (isDecl(item)) visitDecl(item);
          else visit(item);
        }
        visit(expr.result);
        return;
      case "Binary":
        visit(expr.left);
        visit(expr.right);
        return;
      case "Unary":
        visit(expr.value);
        return;
      case "Pipe":
        visit(expr.left);
        visit(expr.right);
        return;
    }
  };
  const visitDecl = (decl: Decl) => {
    if (decl.kind !== "LetDecl") return;
    for (const binding of decl.bindings) visit(binding.value);
  };
  decls.forEach(visitDecl);
}

function annotatedLambdaBindings(decls: Decl[]): Map<string, Expr> {
  const result = new Map<string, Expr>();
  const visitDecl = (decl: Decl) => {
    if (decl.kind !== "LetDecl") return;
    for (const binding of decl.bindings) {
      if (
        binding.pattern.kind === "PVar" && binding.value.kind === "Lambda" &&
        binding.value.params.some((param) => param.annotation)
      ) {
        result.set(binding.pattern.name, binding.value);
      }
      visitExpr(binding.value);
    }
  };
  const visitExpr = (expr: Expr) => {
    if (expr.kind === "Block") {
      expr.items.forEach((item) => {
        if (isDecl(item)) visitDecl(item);
      });
    }
  };
  decls.forEach(visitDecl);
  return result;
}

function rejectAnnotatedCallbackArg(arg: Expr, annotatedLambdas: Map<string, Expr>) {
  if (
    arg.kind === "Lambda" &&
    arg.params.some((param) => param.annotation)
  ) {
    throw diagnosticError(
      new Error(
        "JS callback parameter annotations cannot cast dynamic callback arguments; use reflection or an explicit assertion inside the callback",
      ),
      arg.node,
    );
  }
  if (arg.kind === "Var" && annotatedLambdas.has(arg.name)) {
    throw diagnosticError(
      new Error(
        "JS callback parameter annotations cannot cast dynamic callback arguments; use reflection or an explicit assertion inside the callback",
      ),
      arg.node ?? annotatedLambdas.get(arg.name)?.node,
    );
  }
}

function generatedForeignDeclsForOverrides(
  decls: Decl[],
  receiverTypes: Map<Expr, Ty> | undefined,
): Decl[] {
  if (!receiverTypes) return [];
  const existing = new Set(
    decls
      .filter((decl) => decl.kind === "ForeignTypeDecl")
      .map((decl) => `${decl.name}:${decl.foreignKey ?? ""}`),
  );
  const generated: Decl[] = [];
  for (const type of receiverTypes.values()) {
    const target = prune(type);
    if (target.tag !== "named" || !target.foreign) continue;
    const key = `${target.name}:${target.foreignKey ?? ""}`;
    if (existing.has(key)) continue;
    existing.add(key);
    generated.push({
      kind: "ForeignTypeDecl",
      name: target.name,
      foreignKey: target.foreignKey,
    });
  }
  return generated;
}

function rememberDelayedLetRefs(
  decl: Decl,
  ffi: FfiElaboration,
  valueRefs: Map<string, JsTypeRef>,
) {
  if (decl.kind !== "LetDecl") return;
  for (const binding of decl.bindings) {
    if (binding.pattern.kind !== "PVar") continue;
    if (binding.annotation?.kind === "TName" && binding.annotation.name === "Js.Object") continue;
    const ref = resultRefForExpr(binding.value, ffi.bindings, valueRefs, ffi.passThroughRefs);
    if (ref) valueRefs.set(binding.pattern.name, ref);
  }
}

function resolveDelayedDecl(
  decl: Decl,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
  valueRefs: Map<string, JsTypeRef>,
): Decl {
  if (decl.kind !== "LetDecl") return decl;
  return {
    ...decl,
    bindings: decl.bindings.map((binding) => {
      const bindingValueRefs = delayedValueRefsForBinding(binding, ffi, valueRefs);
      return {
        ...binding,
        value: resolveDelayedExpr(binding.value, ffi, result, selected, options, bindingValueRefs),
      };
    }),
  };
}

function delayedValueRefsForBinding(
  binding: Extract<Decl, { kind: "LetDecl" }>["bindings"][number],
  ffi: FfiElaboration,
  valueRefs: Map<string, JsTypeRef>,
): Map<string, JsTypeRef> {
  if (binding.pattern.kind !== "PVar" || binding.value.kind !== "Lambda") return valueRefs;
  const callbackRefs = ffi.namedCallbackRefs.get(binding.pattern.name);
  if (!callbackRefs?.length) return valueRefs;
  const localValueRefs = new Map(valueRefs);
  rememberLambdaParamRefs(binding.value.params, callbackRefs, localValueRefs);
  return localValueRefs;
}

function rememberLambdaParamRefs(
  params: Param[],
  refs: JsTypeRef[],
  valueRefs: Map<string, JsTypeRef>,
) {
  for (let index = 0; index < params.length; index++) {
    const binder = paramBinder(params[index]);
    const ref = refs[index];
    if (binder && ref) valueRefs.set(binder, ref);
  }
}

function resolveDelayedExpr(
  expr: Expr,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
  valueRefs: Map<string, JsTypeRef>,
): Expr {
  switch (expr.kind) {
    case "FfiGet":
      return resolveDelayedFfiGet(expr, ffi, result, selected, options, valueRefs);
    case "FfiCall":
      return resolveDelayedFfiCall(expr, ffi, result, selected, options, valueRefs);
    case "Call":
      return {
        ...expr,
        callee: resolveDelayedExpr(expr.callee, ffi, result, selected, options, valueRefs),
        args: expr.args.map((arg) =>
          resolveDelayedExpr(arg, ffi, result, selected, options, valueRefs)
        ),
      };
    case "Tuple":
      return {
        ...expr,
        items: expr.items.map((item) =>
          resolveDelayedExpr(item, ffi, result, selected, options, valueRefs)
        ),
      };
    case "Record":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: resolveDelayedExpr(field.value, ffi, result, selected, options, valueRefs),
        })),
      };
    case "JsonObject":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: resolveDelayedExpr(field.value, ffi, result, selected, options, valueRefs),
        })),
      };
    case "JsonArray":
      return {
        ...expr,
        items: expr.items.map((item) =>
          resolveDelayedExpr(item, ffi, result, selected, options, valueRefs)
        ),
      };
    case "Lambda":
      return {
        ...expr,
        body: resolveDelayedExpr(expr.body, ffi, result, selected, options, new Map(valueRefs)),
      };
    case "If":
      return {
        ...expr,
        cond: resolveDelayedExpr(expr.cond, ffi, result, selected, options, valueRefs),
        thenExpr: resolveDelayedExpr(expr.thenExpr, ffi, result, selected, options, valueRefs),
        elseExpr: resolveDelayedExpr(expr.elseExpr, ffi, result, selected, options, valueRefs),
      };
    case "Match":
      return {
        ...expr,
        value: resolveDelayedExpr(expr.value, ffi, result, selected, options, valueRefs),
        arms: expr.arms.map((arm) => ({
          ...arm,
          body: resolveDelayedExpr(arm.body, ffi, result, selected, options, new Map(valueRefs)),
        })),
      };
    case "Panic":
      return {
        ...expr,
        message: resolveDelayedExpr(expr.message, ffi, result, selected, options, valueRefs),
      };
    case "Block": {
      const localValueRefs = new Map(valueRefs);
      const items = expr.items.map((item) => {
        const resolved = isDecl(item)
          ? resolveDelayedDecl(item, ffi, result, selected, options, localValueRefs)
          : resolveDelayedExpr(item, ffi, result, selected, options, localValueRefs);
        if (isDecl(resolved)) rememberDelayedLetRefs(resolved, ffi, localValueRefs);
        return resolved;
      });
      return {
        ...expr,
        items,
        result: resolveDelayedExpr(expr.result, ffi, result, selected, options, localValueRefs),
      };
    }
    case "Binary":
      return {
        ...expr,
        left: resolveDelayedExpr(expr.left, ffi, result, selected, options, valueRefs),
        right: resolveDelayedExpr(expr.right, ffi, result, selected, options, valueRefs),
      };
    case "Unary":
      return {
        ...expr,
        value: resolveDelayedExpr(expr.value, ffi, result, selected, options, valueRefs),
      };
    case "Pipe":
      return {
        ...expr,
        left: resolveDelayedExpr(expr.left, ffi, result, selected, options, valueRefs),
        right: resolveDelayedExpr(expr.right, ffi, result, selected, options, valueRefs),
      };
    default:
      return expr;
  }
}

function resolveDelayedFfiGet(
  expr: Extract<Expr, { kind: "FfiGet" }>,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
  valueRefs: Map<string, JsTypeRef>,
): Expr {
  const receiverType = options.receiverTypes?.get(expr) ?? result.types.get(expr.receiver);
  const receiver = resolveDelayedExpr(expr.receiver, ffi, result, selected, options, valueRefs);
  const foreignTypeRefs = foreignTypeRefLookup(ffi.foreignTypeRefs, options.foreignTypeRefs);
  const foreign = receiverType ? foreignReceiver(receiverType, foreignTypeRefs) : undefined;
  if (foreign) {
    const member = jsRefMember(foreign.ref, expr.path);
    if (member) {
      return materializeReceiverProperty(
        receiver,
        expr.path,
        foreign.type,
        member,
        `__receiver.${foreign.ref.key}.${expr.path.join(".")}`,
        ffi.bindings,
        selected,
      );
    }
    throw diagnosticError(
      new Error(`cannot resolve JS FFI property ${expr.path.join(".")} on ${foreign.ref.key}`),
      expr.node,
    );
  }
  const array = jsArrayReceiver(receiverType);
  const arrayMember = array ? jsArrayMember(array, expr.path) : undefined;
  if (array && arrayMember) {
    return materializeReceiverProperty(
      receiver,
      expr.path,
      array.type,
      arrayMember,
      `__dynamic_array.${typeExprKey(array.type)}.${expr.path.join(".")}`,
      ffi.bindings,
      selected,
    );
  }
  const expressionRef = expressionRefForReceiver(expr.receiver, receiver, ffi, valueRefs);
  if (expressionRef) {
    const member = jsRefMember(expressionRef, expr.path);
    if (member) {
      return materializeReceiverProperty(
        receiver,
        expr.path,
        receiverTypeForRef(expressionRef),
        member,
        `__receiver.${expressionRef.key}.${expr.path.join(".")}`,
        ffi.bindings,
        selected,
      );
    }
  }
  if (!receiverType || !isJsObjectTy(receiverType)) {
    throw diagnosticError(
      new Error(
        `cannot resolve JS FFI property ${expr.path.join(".")} for receiver type ${
          receiverType ? show(receiverType) : "unknown"
        }`,
      ),
      expr.node,
    );
  }
  return materializeReceiverProperty(
    receiver,
    expr.path,
    name("Js.Object"),
    { name: expr.path.at(-1)!, type: { kind: "TVar", name: "a" } },
    `__dynamic.${expr.path.join(".")}`,
    ffi.bindings,
    selected,
  );
}

function resolveDelayedFfiCall(
  expr: Extract<Expr, { kind: "FfiCall" }>,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
  valueRefs: Map<string, JsTypeRef>,
): Expr {
  const receiverType = options.receiverTypes?.get(expr) ?? result.types.get(expr.receiver);
  const receiver = resolveDelayedExpr(expr.receiver, ffi, result, selected, options, valueRefs);
  const foreignTypeRefs = foreignTypeRefLookup(ffi.foreignTypeRefs, options.foreignTypeRefs);
  const foreign = receiverType ? foreignReceiver(receiverType, foreignTypeRefs) : undefined;
  if (foreign) {
    const callMember = jsRefCallMember(foreign.ref, expr.path, expr.args.map(callArgHint));
    const member = callMember ?? jsRefMember(foreign.ref, expr.path);
    if (member) {
      return materializeReceiverCall(
        receiver,
        expr.path,
        expr.args,
        foreign.type,
        member,
        `__receiver.${foreign.ref.key}.${expr.path.join(".")}${
          callMember ? `(${callHintKey(expr.args)})` : ""
        }`,
        ffi,
        result,
        selected,
        options,
        valueRefs,
      );
    }
    throw diagnosticError(
      new Error(`cannot resolve JS FFI method ${expr.path.join(".")} on ${foreign.ref.key}`),
      expr.node,
    );
  }
  const array = jsArrayReceiver(receiverType);
  const arrayMember = array ? jsArrayMember(array, expr.path) : undefined;
  if (array && arrayMember) {
    return materializeReceiverCall(
      receiver,
      expr.path,
      expr.args,
      array.type,
      arrayMember,
      `__dynamic_array.${typeExprKey(array.type)}.${expr.path.join(".")}`,
      ffi,
      result,
      selected,
      options,
      valueRefs,
    );
  }
  const expressionRef = expressionRefForReceiver(expr.receiver, receiver, ffi, valueRefs);
  const promise = jsPromiseReceiver(receiverType);
  const reflectedPromiseMember = promise && expressionRef
    ? jsRefCallMember(expressionRef, expr.path, expr.args.map(callArgHint))
    : undefined;
  const promiseMember = promise
    ? withCallbackParamRefs(
      jsPromiseMember(
        promise,
        expr.path,
        promiseCallbackResultType(expr.args[0], result),
        ffiCallPromiseElement(inferredType(result, expr)),
      ),
      reflectedPromiseMember,
    )
    : undefined;
  if (promise && promiseMember) {
    const callbackResult = promiseCallbackResultType(expr.args[0], result);
    return materializeReceiverCall(
      receiver,
      expr.path,
      expr.args,
      promise.type,
      promiseMember,
      `__dynamic_promise.${typeExprKey(promise.type)}.${expr.path.join(".")}${
        callbackResult ? `.${typeExprKey(tyToTypeExpr(callbackResult))}` : ""
      }`,
      ffi,
      result,
      selected,
      options,
      valueRefs,
    );
  }
  if (expressionRef) {
    const promiseRef = jsPromiseReceiverTypeExpr(jsRefTypeExpr(expressionRef));
    const reflectedPromiseMember = promiseRef
      ? jsRefCallMember(expressionRef, expr.path, expr.args.map(callArgHint))
      : undefined;
    const promiseRefMember = promiseRef
      ? withCallbackParamRefs(
        jsPromiseMember(
          promiseRef,
          expr.path,
          promiseCallbackResultType(expr.args[0], result),
          ffiCallPromiseElement(inferredType(result, expr)),
        ),
        reflectedPromiseMember,
      )
      : undefined;
    if (promiseRef && promiseRefMember) {
      const callbackResult = promiseCallbackResultType(expr.args[0], result);
      return materializeReceiverCall(
        receiver,
        expr.path,
        expr.args,
        promiseRef.type,
        promiseRefMember,
        `__dynamic_promise.${typeExprKey(promiseRef.type)}.${expr.path.join(".")}${
          callbackResult ? `.${typeExprKey(tyToTypeExpr(callbackResult))}` : ""
        }`,
        ffi,
        result,
        selected,
        options,
        valueRefs,
      );
    }
    const callMember = jsRefCallMember(expressionRef, expr.path, expr.args.map(callArgHint));
    const member = callMember ?? jsRefMember(expressionRef, expr.path);
    if (member) {
      return materializeReceiverCall(
        receiver,
        expr.path,
        expr.args,
        receiverTypeForRef(expressionRef),
        member,
        `__receiver.${expressionRef.key}.${expr.path.join(".")}${
          callMember ? `(${callHintKey(expr.args)})` : ""
        }`,
        ffi,
        result,
        selected,
        options,
        valueRefs,
      );
    }
  }
  if (!receiverType || !isJsObjectTy(receiverType)) {
    throw diagnosticError(
      new Error(
        `cannot resolve JS FFI method ${expr.path.join(".")} for receiver type ${
          receiverType ? show(receiverType) : "unknown"
        }`,
      ),
      expr.node,
    );
  }
  return materializeReceiverCall(
    receiver,
    expr.path,
    expr.args,
    name("Js.Object"),
    {
      name: expr.path.at(-1)!,
      type: fn(expr.args.map(dynamicReceiverArgType), { kind: "TVar", name: "b" }),
    },
    `__dynamic.${expr.path.join(".")}`,
    ffi,
    result,
    selected,
    options,
    valueRefs,
  );
}

function isJsObjectTy(type: Ty): boolean {
  const target = prune(type);
  return target.tag === "named" && target.name === "Js.Object";
}

function jsArrayReceiver(type: Ty | undefined): { element: TypeExpr; type: TypeExpr } | undefined {
  if (!type) return undefined;
  const target = prune(type);
  if (target.tag !== "named" || target.name !== "Js.Array" || target.args.length !== 1) {
    return undefined;
  }
  const element = tyToTypeExpr(target.args[0]);
  return { element, type: nameArgs("Js.Array", [element]) };
}

function jsArrayMember(
  array: { element: TypeExpr; type: TypeExpr },
  path: string[],
): JsMemberType | undefined {
  if (path.length !== 1) return undefined;
  const member = path[0];
  if (member === "length") return { name: member, type: name("Number") };
  if (member === "join") {
    return {
      name: member,
      type: fn([name("String")], name("String")),
      variants: [
        { type: fn([], name("String")) },
        { type: fn([name("String")], name("String")) },
      ],
    };
  }
  if (member === "map") {
    const mapped = tvar("mapped");
    return {
      name: member,
      type: fn(
        [fn([array.element, name("Number"), array.type], mapped)],
        nameArgs("Js.Array", [mapped]),
      ),
    };
  }
  return undefined;
}

function jsPromiseReceiver(type: Ty | undefined): { element: TypeExpr; type: TypeExpr } | undefined {
  if (!type) return undefined;
  const target = prune(type);
  if (target.tag !== "named" || target.name !== "Js.Promise" || target.args.length !== 1) {
    return undefined;
  }
  const element = tyToTypeExpr(target.args[0]);
  return { element, type: nameArgs("Js.Promise", [element]) };
}

function jsPromiseReceiverTypeExpr(
  type: TypeExpr | undefined,
): { element: TypeExpr; type: TypeExpr } | undefined {
  if (type?.kind !== "TName" || type.name !== "Js.Promise" || type.args.length !== 1) {
    return undefined;
  }
  return { element: type.args[0], type };
}

function jsPromiseMember(
  promise: { element: TypeExpr; type: TypeExpr },
  path: string[],
  callbackResultType?: Ty,
  callResultElement?: TypeExpr,
): JsMemberType | undefined {
  if (path.length !== 1) return undefined;
  const member = path[0];
  if (member === "then") {
    const mapped = tvar("mapped");
    const callback = callbackResultType
      ? promiseCallbackType(promise.element, callbackResultType)
      : undefined;
    if (callback) {
      return {
        name: member,
        type: fn([
          callback.type,
        ], nameArgs("Js.Promise", [dynamicPromiseElement(callResultElement ?? callback.element)])),
      };
    }
    return {
      name: member,
      type: fn([fn([promise.element], mapped)], nameArgs("Js.Promise", [
        dynamicPromiseElement(callResultElement ?? mapped),
      ])),
    };
  }
  if (member === "catch") {
    return {
      name: member,
      type: fn([fn([name("Js.Value")], tvar("handled"))], promise.type),
    };
  }
  return undefined;
}

function promiseCallbackType(
  element: TypeExpr,
  callbackResultType: Ty,
): { type: TypeExpr; element: TypeExpr } | undefined {
  const result = tyToTypeExpr(callbackResultType);
  return {
    type: fn([element], result),
    element: promiseElementTypeExpr(result) ?? result,
  };
}

function promiseCallbackResultType(arg: Expr | undefined, result: InferResult): Ty | undefined {
  if (!arg) return undefined;
  if (arg.kind === "Lambda") return inferredType(result, arg.body);
  const type = inferredType(result, arg);
  const target = type ? prune(type) : undefined;
  return target?.tag === "fn" && target.params.length === 1 ? target.result : undefined;
}

function inferredType(result: InferResult, expr: Expr): Ty | undefined {
  const direct = result.types.get(expr);
  if (direct) return direct;
  const id = expr.node?.id;
  if (id === undefined) return undefined;
  for (const [candidate, type] of result.types) {
    if (candidate.node?.id === id) return type;
  }
  return undefined;
}

function withCallbackParamRefs(
  member: JsMemberType | undefined,
  refsFrom: JsMemberType | undefined,
): JsMemberType | undefined {
  if (!member || !refsFrom?.variants?.length) return member;
  return {
    ...member,
    variants: memberVariants(member).map((variant, index) => ({
      ...variant,
      callbackParamRefs: refsFrom.variants?.[index]?.callbackParamRefs ??
        refsFrom.variants?.[0]?.callbackParamRefs,
    })),
  };
}

function ffiCallPromiseElement(type: Ty | undefined): TypeExpr | undefined {
  const target = type ? prune(type) : undefined;
  if (target?.tag !== "named" || target.name !== "Result" || target.args.length !== 2) {
    return undefined;
  }
  const value = prune(target.args[0]);
  return value.tag === "named" && value.name === "Js.Promise" && value.args.length === 1
    ? tyToTypeExpr(value.args[0])
    : undefined;
}

function promiseElementTypeExpr(type: TypeExpr): TypeExpr | undefined {
  return type.kind === "TName" && type.name === "Js.Promise" && type.args.length === 1
    ? type.args[0]
    : undefined;
}

function dynamicPromiseElement(type: TypeExpr): TypeExpr {
  return type.kind === "TVar" ? name("Js.Value") : type;
}

function tyToTypeExpr(type: Ty): TypeExpr {
  const target = prune(type);
  switch (target.tag) {
    case "prim":
      return name(target.name);
    case "var":
      return tvar(target.name ?? `t${target.id}`);
    case "named":
      return nameArgs(target.name, target.args.map(tyToTypeExpr));
    case "tuple":
      return { kind: "TTuple", items: target.items.map(tyToTypeExpr) };
    case "fn":
      return {
        kind: "TFn",
        params: target.params.map(tyToTypeExpr),
        result: tyToTypeExpr(target.result),
      };
  }
}

function typeExprKey(type: TypeExpr): string {
  switch (type.kind) {
    case "TName":
      return type.args.length ? `${type.name}<${type.args.map(typeExprKey).join(",")}>` : type.name;
    case "TVar":
      return `'${type.name}`;
    case "TTuple":
      return `(${type.items.map(typeExprKey).join(",")})`;
    case "TFn":
      return `(${type.params.map(typeExprKey).join(",")})->${typeExprKey(type.result)}`;
  }
}

function expressionRefForReceiver(
  original: Expr,
  resolved: Expr,
  ffi: FfiElaboration,
  valueRefs: Map<string, JsTypeRef>,
): JsTypeRef | undefined {
  if (original.kind === "Var") {
    const ref = valueRefs.get(original.name);
    if (ref) return ref;
  }
  if (resolved.kind === "Var") {
    const ref = valueRefs.get(resolved.name);
    if (ref) return ref;
  }
  return ffi.expressionRefs.get(original) ??
    ffi.expressionRefs.get(resolved) ??
    resultRefForExpr(resolved, ffi.bindings, valueRefs, ffi.passThroughRefs);
}

function receiverTypeForRef(ref: JsTypeRef): TypeExpr {
  const type = jsRefTypeExpr(ref);
  if (type?.kind === "TName" && type.name === "Js.Value" && type.args.length === 0) {
    return name("Js.Object");
  }
  return type ?? name("Js.Object");
}

function foreignTypeRefLookup(
  localRefs: Map<string, JsTypeRef>,
  globalRefs: Map<string, JsTypeRef> | undefined,
): Map<string, JsTypeRef> {
  return new Map([
    ...[...localRefs].flatMap(([name, ref]) => [[name, ref], [ref.key, ref]] as const),
    ...(globalRefs ?? new Map()),
  ]);
}

function foreignReceiver(
  type: Ty,
  foreignTypeRefs: Map<string, JsTypeRef>,
): { ref: JsTypeRef; type: TypeExpr } | undefined {
  const target = prune(type);
  if (
    target.tag === "prim" &&
    (target.name === "String" || target.name === "Number" || target.name === "Bool")
  ) {
    return {
      ref: jsPrimitiveValueRef(target.name),
      type: { kind: "TName", name: target.name, args: [] },
    };
  }
  if (target.tag !== "named" || !(target.foreign || foreignTypeRefs.has(target.name))) {
    return undefined;
  }
  const ref = (target.foreignKey ? foreignTypeRefs.get(target.foreignKey) : undefined) ??
    foreignTypeRefs.get(target.name);
  if (!ref) return undefined;
  return { ref, type: { kind: "TName", name: target.name, args: [] } };
}

function materializeReceiverProperty(
  receiver: Expr,
  path: string[],
  receiverType: TypeExpr,
  member: JsMemberType,
  surfaceName: string,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
): Expr {
  addVariants(
    bindings,
    surfaceName,
    path.at(-1)!,
    { kind: "JsReceiver", path },
    memberVariants(member).map((variant) => ({
      type: prependReceiver(variant.type, receiverType),
      resultRef: variant.resultRef,
      callbackParamRefs: variant.callbackParamRefs?.map((item) => ({
        argIndex: item.argIndex + 1,
        params: item.params,
      })),
    })),
    true,
  );
  const variant = selectVariant(bindings.get(surfaceName)?.variants ?? [], [receiver]);
  if (!variant) return { kind: "FfiGet", receiver, path };
  selected.add(variant.internalName);
  return {
    kind: "Call",
    callee: { kind: "Var", name: variant.internalName },
    args: [receiver],
  };
}

function materializeReceiverCall(
  receiver: Expr,
  path: string[],
  args: Expr[],
  receiverType: TypeExpr,
  member: JsMemberType,
  surfaceName: string,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
  valueRefs: Map<string, JsTypeRef>,
): Expr {
  addVariants(
    ffi.bindings,
    surfaceName,
    path.at(-1)!,
    { kind: "JsReceiver", path },
    memberVariants(member).map((variant) => ({
      type: prependReceiver(variant.type, receiverType),
      resultRef: variant.resultRef,
      callbackParamRefs: variant.callbackParamRefs?.map((item) => ({
        argIndex: item.argIndex + 1,
        params: item.params,
      })),
    })),
    true,
  );
  const allArgs = [receiver, ...args];
  const variant = selectVariant(ffi.bindings.get(surfaceName)?.variants ?? [], allArgs);
  if (!variant) return { kind: "FfiCall", receiver, path, args };
  selected.add(variant.internalName);
  return {
    kind: "Call",
    callee: { kind: "Var", name: variant.internalName },
    args: [
      receiver,
      ...args.map((arg, index) =>
        resolveDelayedCallArg(arg, index + 1, variant, ffi, result, selected, options, valueRefs)
      ),
    ],
  };
}

function resolveDelayedCallArg(
  arg: Expr,
  argIndex: number,
  variant: FfiVariant,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
  valueRefs: Map<string, JsTypeRef>,
): Expr {
  const callbackRefs = variant.callbackParamRefs?.find((item) => item.argIndex === argIndex);
  const localValueRefs = refsForCallbackArg(new Map(valueRefs), arg, callbackRefs?.params);
  const rewritten = rewriteExprCalls(
    arg,
    ffi.bindings,
    selected,
    localValueRefs,
    new Map(),
    new Map(),
    ffi.foreignTypeRefs,
  );
  return resolveDelayedExpr(rewritten, ffi, result, selected, options, localValueRefs);
}
