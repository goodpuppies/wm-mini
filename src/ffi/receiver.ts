import type { Decl, Expr, Param, Pattern, TypeExpr } from "../ast.ts";
import { type JsCallArgHint, type JsMemberType, jsRefMember, type JsTypeRef } from "./js_types.ts";
import {
  addVariants,
  callArgHint,
  type FfiBinding,
  type FfiVariant,
  fn,
  memberVariants,
  name,
  paramBinder,
  prependReceiver,
  selectVariant,
} from "./shared.ts";

export type ObjectAccess =
  | { kind: "ref"; ref: JsTypeRef; receiverType?: TypeExpr }
  | { kind: "dynamic" }
  | { kind: "unresolved" };

export type ReflectedReceiverCall = {
  callee: Expr;
  args: Expr[];
  variant: FfiVariant;
};

export function reflectedReceiverCallCandidate(
  name: string,
  args: Expr[],
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  jsRefCallMember: (
    ref: JsTypeRef,
    path: string[],
    args: JsCallArgHint[],
  ) => JsMemberType | undefined,
): ReflectedReceiverCall | undefined {
  const parts = name.split(".");
  if (parts.length < 2) return undefined;
  const baseName = parts[0];
  const ref = refs.get(baseName);
  if (!ref) return undefined;
  const path = parts.slice(1);
  const member = jsRefCallMember(ref, path, args.map(callArgHint)) ?? jsRefMember(ref, path);
  if (!member) return undefined;
  const surfaceName = `__receiver.${ref.key}.${path.join(".")}`;
  addVariants(
    bindings,
    surfaceName,
    path.at(-1)!,
    { kind: "JsReceiver", path },
    memberVariants(member).map((variant) => ({
      type: prependReceiver(variant.type),
      resultRef: variant.resultRef,
      callbackParamRefs: variant.callbackParamRefs?.map((item) => ({
        argIndex: item.argIndex + 1,
        params: item.params,
      })),
    })),
    true,
  );
  const allArgs = [{ kind: "Var" as const, name: baseName }, ...args];
  const variant = selectVariant(bindings.get(surfaceName)?.variants ?? [], allArgs);
  if (!variant) return undefined;
  selected.add(variant.internalName);
  return {
    callee: { kind: "Var", name: variant.internalName },
    args: allArgs,
    variant,
  };
}

export function reflectedReceiverProperty(
  name: string,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  receiverType?: TypeExpr,
): Expr | undefined {
  const parts = name.split(".");
  if (parts.length < 2) return undefined;
  const baseName = parts[0];
  const ref = refs.get(baseName);
  if (!ref) return undefined;
  const path = parts.slice(1);
  const member = jsRefMember(ref, path);
  if (!member) return undefined;
  const surfaceName = `__receiver.${ref.key}.${path.join(".")}`;
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
  const variant = selectVariant(bindings.get(surfaceName)?.variants ?? [], [{
    kind: "Var",
    name: baseName,
  }]);
  if (!variant) return undefined;
  selected.add(variant.internalName);
  return {
    kind: "Call",
    callee: { kind: "Var", name: variant.internalName },
    args: [{ kind: "Var", name: baseName }],
  };
}

export function objectReceiverProperty(
  exprName: string,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  objectAccess: Map<string, ObjectAccess>,
): Expr | undefined {
  const parts = exprName.split(".");
  if (parts.length < 2) return undefined;
  const baseName = parts[0];
  const access = objectAccess.get(baseName);
  if (!access) return undefined;
  const path = parts.slice(1);
  if (access.kind === "ref") {
    return reflectedReceiverProperty(
      exprName,
      bindings,
      selected,
      new Map([[baseName, access.ref]]),
      access.receiverType,
    );
  }
  if (access.kind === "unresolved") {
    return {
      kind: "FfiGet",
      receiver: { kind: "Var", name: baseName },
      path,
    };
  }
  const surfaceName = `__dynamic.${path.join(".")}`;
  addVariants(
    bindings,
    surfaceName,
    path.at(-1)!,
    { kind: "JsReceiver", path },
    [{ type: fn([name("Js.Object")], { kind: "TVar", name: "a" }) }],
    true,
  );
  const variant = selectVariant(bindings.get(surfaceName)?.variants ?? [], [{
    kind: "Var",
    name: baseName,
  }]);
  if (!variant) return undefined;
  selected.add(variant.internalName);
  return {
    kind: "Call",
    callee: { kind: "Var", name: variant.internalName },
    args: [{ kind: "Var", name: baseName }],
  };
}

export function objectReceiverCall(
  exprName: string,
  args: Expr[],
  objectAccess: Map<string, ObjectAccess>,
): Expr | undefined {
  const parts = exprName.split(".");
  if (parts.length < 2) return undefined;
  const baseName = parts[0];
  const access = objectAccess.get(baseName);
  if (access?.kind !== "unresolved") return undefined;
  return {
    kind: "FfiCall",
    receiver: { kind: "Var", name: baseName },
    path: parts.slice(1),
    args,
  };
}

export function rememberObjectParams(
  params: Param[],
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
) {
  for (const param of params) {
    const binder = paramBinder(param);
    if (!binder) continue;
    const access = objectAccessForType(param.annotation, importedTypeRefs);
    if (access) objectAccess.set(binder, access);
  }
}

export function rememberUnannotatedParams(
  params: Param[],
  objectAccess: Map<string, ObjectAccess>,
) {
  for (const param of params) {
    if (param.annotation) continue;
    const binder = paramBinder(param);
    if (binder && !objectAccess.has(binder)) objectAccess.set(binder, { kind: "unresolved" });
  }
}

function objectAccessForType(
  type: TypeExpr | undefined,
  importedTypeRefs: Map<string, JsTypeRef>,
): ObjectAccess | undefined {
  if (isJsObjectType(type)) return { kind: "dynamic" };
  if (type?.kind !== "TName" || type.args.length !== 0) return undefined;
  const ref = importedTypeRefs.get(type.name);
  return ref ? { kind: "ref", ref, receiverType: type } : undefined;
}

function isJsObjectType(type: TypeExpr | undefined): boolean {
  return type?.kind === "TName" && type.name === "Js.Object" && type.args.length === 0;
}

export function rememberLetRefs(
  decl: Decl,
  bindings: Map<string, FfiBinding>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
) {
  if (decl.kind !== "LetDecl") return;
  for (const binding of decl.bindings) {
    if (binding.pattern.kind !== "PVar") continue;
    const access = objectAccessForType(binding.annotation, importedTypeRefs);
    if (access) objectAccess.set(binding.pattern.name, access);
    const ref = resultRefForExpr(binding.value, bindings, resultRefs);
    if (!ref) continue;
    refs.set(binding.pattern.name, ref);
    resultRefs.set(binding.pattern.name, ref);
  }
}

export function resultRefForExpr(
  expr: Expr,
  bindings: Map<string, FfiBinding>,
  resultRefs: Map<string, JsTypeRef>,
): JsTypeRef | undefined {
  if (expr.kind === "Var") return resultRefs.get(expr.name);
  const callRef = variantFromCall(expr, bindings)?.resultRef;
  if (callRef) return callRef;
  if (expr.kind !== "Match") return undefined;
  const matchedRef = resultRefForExpr(expr.value, bindings, resultRefs);
  if (!matchedRef) return undefined;
  return matchPassThroughsOkPayload(expr) ? matchedRef : undefined;
}

function variantFromCall(expr: Expr, bindings: Map<string, FfiBinding>): FfiVariant | undefined {
  if (expr.kind !== "Call" || expr.callee.kind !== "Var") return undefined;
  const calleeName = expr.callee.name;
  for (const binding of bindings.values()) {
    const found = binding.variants.find((variant) => variant.internalName === calleeName);
    if (found) return found;
  }
  return undefined;
}

function matchPassThroughsOkPayload(expr: Extract<Expr, { kind: "Match" }>): boolean {
  return expr.arms.some((arm) => {
    const bodyVar = passThroughVar(arm.body);
    if (!bodyVar) return false;
    return okPayloadBinders(arm.pattern).includes(bodyVar);
  });
}

function passThroughVar(expr: Expr): string | undefined {
  if (expr.kind === "Var") return expr.name;
  if (expr.kind === "Block" && expr.items.length === 0 && expr.result.kind === "Var") {
    return expr.result.name;
  }
  return undefined;
}

export function okPayloadBinders(pattern: Pattern): string[] {
  if (pattern.kind !== "PCtor" || pattern.name.split(".").at(-1) !== "Ok") return [];
  const payload = pattern.args[0];
  return payload ? patternBinders(payload) : [];
}

function patternBinders(pattern: Pattern): string[] {
  switch (pattern.kind) {
    case "PVar":
      return [pattern.name];
    case "PTuple":
      return pattern.items.flatMap(patternBinders);
    case "PRecord":
      return pattern.fields.flatMap((field) => patternBinders(field.pattern));
    case "PCtor":
      return pattern.args.flatMap(patternBinders);
    default:
      return [];
  }
}
