import type { Decl, Expr, TypeExpr } from "../ast.ts";
import { diagnosticError } from "../diagnostics.ts";
import type { InferResult } from "../infer.ts";
import { prune, show, type Ty } from "../types.ts";
import {
  addVariants,
  callArgHint,
  callHintKey,
  type FfiBinding,
  type FfiElaboration,
  type FfiVariant,
  fn,
  generatedReceiverJsImports,
  isDecl,
  memberVariants,
  name,
  prependReceiver,
  refsForCallbackArg,
  selectVariant,
} from "./shared.ts";
import { rewriteExprCalls } from "./elab.ts";
import { type JsMemberType, jsRefCallMember, jsRefMember, type JsTypeRef } from "./js_types.ts";

type ResolveOptions = {
  receiverTypes?: Map<Expr, Ty>;
  foreignTypeRefs?: Map<string, JsTypeRef>;
};

export function resolveDelayedFfiElaboration(
  ffi: FfiElaboration,
  result: InferResult,
  options: ResolveOptions = {},
): FfiElaboration {
  const selected = new Set<string>();
  const module = {
    ...ffi.module,
    decls: ffi.module.decls.map((decl) => resolveDelayedDecl(decl, ffi, result, selected, options)),
  };
  const foreignDecls = generatedForeignDeclsForOverrides(module.decls, options.receiverTypes);
  const imports = generatedReceiverJsImports(ffi.bindings, selected);
  const split = module.decls.findIndex((decl) => decl.kind !== "ForeignTypeDecl");
  const prefixLength = split === -1 ? module.decls.length : split;
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

function resolveDelayedDecl(
  decl: Decl,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
): Decl {
  if (decl.kind !== "LetDecl") return decl;
  return {
    ...decl,
    bindings: decl.bindings.map((binding) => ({
      ...binding,
      value: resolveDelayedExpr(binding.value, ffi, result, selected, options),
    })),
  };
}

function resolveDelayedExpr(
  expr: Expr,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
): Expr {
  switch (expr.kind) {
    case "FfiGet":
      return resolveDelayedFfiGet(expr, ffi, result, selected, options);
    case "FfiCall":
      return resolveDelayedFfiCall(expr, ffi, result, selected, options);
    case "Call":
      return {
        ...expr,
        callee: resolveDelayedExpr(expr.callee, ffi, result, selected, options),
        args: expr.args.map((arg) => resolveDelayedExpr(arg, ffi, result, selected, options)),
      };
    case "Tuple":
      return {
        ...expr,
        items: expr.items.map((item) => resolveDelayedExpr(item, ffi, result, selected, options)),
      };
    case "Record":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: resolveDelayedExpr(field.value, ffi, result, selected, options),
        })),
      };
    case "JsonObject":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: resolveDelayedExpr(field.value, ffi, result, selected, options),
        })),
      };
    case "JsonArray":
      return {
        ...expr,
        items: expr.items.map((item) => resolveDelayedExpr(item, ffi, result, selected, options)),
      };
    case "Lambda":
      return { ...expr, body: resolveDelayedExpr(expr.body, ffi, result, selected, options) };
    case "If":
      return {
        ...expr,
        cond: resolveDelayedExpr(expr.cond, ffi, result, selected, options),
        thenExpr: resolveDelayedExpr(expr.thenExpr, ffi, result, selected, options),
        elseExpr: resolveDelayedExpr(expr.elseExpr, ffi, result, selected, options),
      };
    case "Match":
      return {
        ...expr,
        value: resolveDelayedExpr(expr.value, ffi, result, selected, options),
        arms: expr.arms.map((arm) => ({
          ...arm,
          body: resolveDelayedExpr(arm.body, ffi, result, selected, options),
        })),
      };
    case "Panic":
      return { ...expr, message: resolveDelayedExpr(expr.message, ffi, result, selected, options) };
    case "Block":
      return {
        ...expr,
        items: expr.items.map((item) =>
          isDecl(item)
            ? resolveDelayedDecl(item, ffi, result, selected, options)
            : resolveDelayedExpr(item, ffi, result, selected, options)
        ),
        result: resolveDelayedExpr(expr.result, ffi, result, selected, options),
      };
    case "Binary":
      return {
        ...expr,
        left: resolveDelayedExpr(expr.left, ffi, result, selected, options),
        right: resolveDelayedExpr(expr.right, ffi, result, selected, options),
      };
    case "Unary":
      return { ...expr, value: resolveDelayedExpr(expr.value, ffi, result, selected, options) };
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
): Expr {
  const receiverType = options.receiverTypes?.get(expr) ?? result.types.get(expr.receiver);
  const receiver = resolveDelayedExpr(expr.receiver, ffi, result, selected, options);
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
): Expr {
  const receiverType = options.receiverTypes?.get(expr) ?? result.types.get(expr.receiver);
  const receiver = resolveDelayedExpr(expr.receiver, ffi, result, selected, options);
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
      );
    }
    throw diagnosticError(
      new Error(`cannot resolve JS FFI method ${expr.path.join(".")} on ${foreign.ref.key}`),
      expr.node,
    );
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
      type: fn([{ kind: "TVar", name: "a" }], { kind: "TVar", name: "b" }),
    },
    `__dynamic.${expr.path.join(".")}`,
    ffi,
    result,
    selected,
    options,
  );
}

function isJsObjectTy(type: Ty): boolean {
  const target = prune(type);
  return target.tag === "named" && target.name === "Js.Object";
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
        resolveDelayedCallArg(arg, index + 1, variant, ffi, result, selected, options)
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
): Expr {
  const callbackRefs = variant.callbackParamRefs?.find((item) => item.argIndex === argIndex);
  const rewritten = rewriteExprCalls(
    arg,
    ffi.bindings,
    selected,
    refsForCallbackArg(new Map(), arg, callbackRefs?.params),
    new Map(),
    new Map(),
    ffi.foreignTypeRefs,
  );
  return resolveDelayedExpr(rewritten, ffi, result, selected, options);
}
