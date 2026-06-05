import type { Decl, Expr, TypeExpr } from "../../ast.ts";
import { diagnosticError } from "../../diagnostics.ts";
import type { InferResult } from "../../infer.ts";
import { show } from "../../types.ts";
import { rejectAnnotatedDynamicCallbacks } from "./annotations.ts";
import {
  delayedValueRefsForBinding,
  generatedForeignDeclsForOverrides,
  generatedImportInsertionIndex,
  rememberDelayedLetRefs,
} from "./bindings.ts";
import { materializeReceiverCall, materializeReceiverProperty } from "./materialize.ts";
import {
  expressionRefForReceiver,
  ffiCallPromiseElement,
  foreignReceiver,
  foreignTypeRefLookup,
  inferredType,
  isJsObjectTy,
  jsArrayMember,
  jsArrayReceiver,
  jsPromiseMember,
  jsPromiseReceiver,
  jsPromiseReceiverTypeExpr,
  promiseCallbackResultType,
  receiverTypeForRef,
  typeExprKey,
  tyToTypeExpr,
  withCallbackParamRefs,
} from "./receiver_models.ts";
import type { ResolveOptions } from "./types.ts";
import {
  callArgHint,
  callHintKey,
  dynamicReceiverArgType,
  type FfiElaboration,
  fn,
  generatedReceiverJsImports,
  isDecl,
  name,
} from "../shared.ts";
import { jsRefCallMember, jsRefMember, jsRefTypeExpr, type JsTypeRef } from "../reflect/types.ts";

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
        resolveDelayedExpr,
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
      resolveDelayedExpr,
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
      resolveDelayedExpr,
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
        resolveDelayedExpr,
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
        resolveDelayedExpr,
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
    resolveDelayedExpr,
  );
}
