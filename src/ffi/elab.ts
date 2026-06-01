import type {
  Decl,
  Expr,
  JsImportSpec,
  JsTarget,
  Module,
  Param,
  Pattern,
  TypeExpr,
} from "../ast.ts";
import { diagnosticError } from "../diagnostics.ts";
import type { InferResult } from "../infer.ts";
import { prune, show, type Ty } from "../types.ts";
import {
  type JsCallArgHint,
  type JsCallbackParamRefs,
  jsConstructMember,
  jsGlobalMember,
  jsGlobalMembers,
  jsGlobalMemberTypeRef,
  jsGlobalTypeRef,
  jsGlobalValueRef,
  type JsMemberType,
  jsModuleMember,
  jsModuleMembers,
  jsModuleTypeRef,
  jsRefCallMember,
  jsRefMember,
  type JsTypeRef,
} from "./js_types.ts";

export type FfiElaboration = {
  module: Module;
  bindings: Map<string, FfiBinding>;
  foreignTypeRefs: Map<string, JsTypeRef>;
  selected: Set<string>;
};

export type FfiBinding = {
  surfaceName: string;
  variants: FfiVariant[];
  node?: Decl["node"];
};

export type FfiVariant = {
  internalName: string;
  memberName: string;
  target: JsTarget;
  type: TypeExpr;
  resultRef?: JsTypeRef;
  callbackParamRefs?: JsCallbackParamRefs[];
  fallible: boolean;
  node?: JsImportSpec["node"];
};

type ObjectAccess =
  | { kind: "ref"; ref: JsTypeRef; receiverType?: TypeExpr }
  | { kind: "dynamic" }
  | { kind: "unresolved" };

export function prepareFfiElaboration(module: Module): FfiElaboration {
  const bindings = new Map<string, FfiBinding>();
  const importedRefs = new Map<string, JsTypeRef>();
  const importedTypeRefs = new Map<string, JsTypeRef>();
  for (const decl of module.decls) {
    if (decl.kind !== "JsImportDecl") continue;
    collectFfiDecl(bindings, importedRefs, importedTypeRefs, decl);
  }
  const selected = new Set<string>();
  const refs = new Map(importedRefs);
  const resultRefs = new Map<string, JsTypeRef>();
  const objectAccess = new Map<string, ObjectAccess>();
  const rewrittenDecls: Decl[] = [];
  for (const decl of module.decls) {
    if (decl.kind === "JsImportDecl") {
      if (!decl.typeOnly) rewrittenDecls.push(decl);
      continue;
    }
    const rewritten = rewriteDeclCalls(
      decl,
      bindings,
      selected,
      refs,
      resultRefs,
      objectAccess,
      importedTypeRefs,
    );
    rememberLetRefs(rewritten, bindings, refs, resultRefs, objectAccess, importedTypeRefs);
    rewrittenDecls.push(rewritten);
  }
  const decls = [
    ...generatedTypeAliases(importedTypeRefs),
    ...generatedReceiverJsImports(bindings, selected),
    ...rewrittenDecls.flatMap((decl) =>
      decl.kind === "JsImportDecl" ? generatedJsImports(decl, bindings, selected) : [decl]
    ),
  ];
  return { module: { ...module, decls }, bindings, foreignTypeRefs: importedTypeRefs, selected };
}

export function resolveDelayedFfiElaboration(
  ffi: FfiElaboration,
  result: InferResult,
): FfiElaboration {
  const selected = new Set<string>();
  const module = {
    ...ffi.module,
    decls: ffi.module.decls.map((decl) => resolveDelayedDecl(decl, ffi, result, selected)),
  };
  const imports = generatedReceiverJsImports(ffi.bindings, selected);
  const split = module.decls.findIndex((decl) => decl.kind !== "ForeignTypeDecl");
  const prefixLength = split === -1 ? module.decls.length : split;
  return {
    ...ffi,
    module: imports.length
      ? {
        ...module,
        decls: [
          ...module.decls.slice(0, prefixLength),
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
): Decl {
  if (decl.kind !== "LetDecl") return decl;
  return {
    ...decl,
    bindings: decl.bindings.map((binding) => ({
      ...binding,
      value: resolveDelayedExpr(binding.value, ffi, result, selected),
    })),
  };
}

function resolveDelayedExpr(
  expr: Expr,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
): Expr {
  switch (expr.kind) {
    case "FfiGet":
      return resolveDelayedFfiGet(expr, ffi, result, selected);
    case "Call":
      return {
        ...expr,
        callee: resolveDelayedExpr(expr.callee, ffi, result, selected),
        args: expr.args.map((arg) => resolveDelayedExpr(arg, ffi, result, selected)),
      };
    case "Tuple":
      return {
        ...expr,
        items: expr.items.map((item) => resolveDelayedExpr(item, ffi, result, selected)),
      };
    case "Record":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: resolveDelayedExpr(field.value, ffi, result, selected),
        })),
      };
    case "JsonObject":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: resolveDelayedExpr(field.value, ffi, result, selected),
        })),
      };
    case "JsonArray":
      return {
        ...expr,
        items: expr.items.map((item) => resolveDelayedExpr(item, ffi, result, selected)),
      };
    case "Lambda":
      return { ...expr, body: resolveDelayedExpr(expr.body, ffi, result, selected) };
    case "If":
      return {
        ...expr,
        cond: resolveDelayedExpr(expr.cond, ffi, result, selected),
        thenExpr: resolveDelayedExpr(expr.thenExpr, ffi, result, selected),
        elseExpr: resolveDelayedExpr(expr.elseExpr, ffi, result, selected),
      };
    case "Match":
      return {
        ...expr,
        value: resolveDelayedExpr(expr.value, ffi, result, selected),
        arms: expr.arms.map((arm) => ({
          ...arm,
          body: resolveDelayedExpr(arm.body, ffi, result, selected),
        })),
      };
    case "Panic":
      return { ...expr, message: resolveDelayedExpr(expr.message, ffi, result, selected) };
    case "Block":
      return {
        ...expr,
        items: expr.items.map((item) =>
          isDecl(item)
            ? resolveDelayedDecl(item, ffi, result, selected)
            : resolveDelayedExpr(item, ffi, result, selected)
        ),
        result: resolveDelayedExpr(expr.result, ffi, result, selected),
      };
    case "Binary":
      return {
        ...expr,
        left: resolveDelayedExpr(expr.left, ffi, result, selected),
        right: resolveDelayedExpr(expr.right, ffi, result, selected),
      };
    case "Unary":
      return { ...expr, value: resolveDelayedExpr(expr.value, ffi, result, selected) };
    default:
      return expr;
  }
}

function resolveDelayedFfiGet(
  expr: Extract<Expr, { kind: "FfiGet" }>,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
): Expr {
  const receiverType = result.types.get(expr.receiver);
  const receiver = resolveDelayedExpr(expr.receiver, ffi, result, selected);
  const foreign = receiverType ? foreignReceiver(receiverType, ffi.foreignTypeRefs) : undefined;
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
      new Error(
        `cannot resolve JS FFI property ${expr.path.join(".")} on ${foreign.ref.key}`,
      ),
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

function isJsObjectTy(type: Ty): boolean {
  const target = prune(type);
  return target.tag === "named" && target.name === "Js.Object";
}

function foreignReceiver(
  type: Ty,
  foreignTypeRefs: Map<string, JsTypeRef>,
): { ref: JsTypeRef; type: TypeExpr } | undefined {
  const target = prune(type);
  if (target.tag !== "named" || !(target.foreign || foreignTypeRefs.has(target.name))) {
    return undefined;
  }
  const ref = foreignTypeRefs.get(target.name);
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

function collectFfiDecl(
  bindings: Map<string, FfiBinding>,
  importedRefs: Map<string, JsTypeRef>,
  importedTypeRefs: Map<string, JsTypeRef>,
  decl: Extract<Decl, { kind: "JsImportDecl" }>,
) {
  if (decl.typeOnly) {
    collectFfiTypeDecl(importedTypeRefs, decl);
    return;
  }
  if (decl.clause.kind === "Namespace") {
    for (const member of jsTargetMembers(decl.target)) {
      addVariants(
        bindings,
        `${decl.clause.alias}.${member.name}`,
        member.name,
        decl.target,
        memberVariants(member),
        !decl.clause.unsafe,
        decl.node,
      );
    }
    return;
  }
  for (const spec of decl.clause.specs) {
    if (decl.target.kind === "JsGlobalRoot" && !spec.type) {
      const localName = spec.alias ?? spec.name;
      const surfaceName = decl.clause.alias ? `${decl.clause.alias}.${localName}` : localName;
      const ref = jsGlobalValueRef(spec.name);
      importedRefs.set(surfaceName, ref);
      const construct = jsConstructMember(ref);
      if (construct) {
        addVariants(
          bindings,
          `${surfaceName}.new`,
          "new",
          { kind: "JsConstructor", path: spec.name },
          memberVariants(construct),
          !decl.clause.unsafe,
          spec.node,
        );
      }
      continue;
    }
    const reflected = !spec.type;
    const member = spec.type
      ? { name: spec.name, type: spec.type }
      : jsTargetMember(decl.target, spec.name);
    if (!member) continue;
    const localName = spec.alias ?? spec.name;
    const surfaceName = decl.clause.alias ? `${decl.clause.alias}.${localName}` : localName;
    addVariants(
      bindings,
      surfaceName,
      spec.name,
      decl.target,
      memberVariants(member),
      reflected && !decl.clause.unsafe,
      spec.node,
    );
  }
}

function collectFfiTypeDecl(
  importedTypeRefs: Map<string, JsTypeRef>,
  decl: Extract<Decl, { kind: "JsImportDecl" }>,
) {
  if (decl.clause.kind === "Namespace") {
    throw diagnosticError(new Error("JS type imports must name the imported types"), decl.node);
  }
  for (const spec of decl.clause.specs) {
    const localName = spec.alias ?? spec.name;
    const ref = jsTypeRefForTarget(decl.target, spec.name);
    if (ref) importedTypeRefs.set(localName, ref);
  }
}

function jsTypeRefForTarget(target: JsTarget, name: string): JsTypeRef | undefined {
  if (target.kind === "JsGlobalRoot") return jsGlobalTypeRef(name);
  if (target.kind === "JsGlobal") return jsGlobalMemberTypeRef(target.path, name);
  if (target.kind === "JsModule") return jsModuleTypeRef(target.specifier, name);
  return undefined;
}

function addVariants(
  bindings: Map<string, FfiBinding>,
  surfaceName: string,
  memberName: string,
  target: JsTarget,
  variants: { type: TypeExpr; resultRef?: JsTypeRef; callbackParamRefs?: JsCallbackParamRefs[] }[],
  fallible: boolean,
  node?: JsImportSpec["node"],
) {
  const binding = bindings.get(surfaceName) ?? { surfaceName, variants: [] };
  for (const variant of dedupeVariantSpecs(variants)) {
    const index = binding.variants.length;
    binding.variants.push({
      internalName: ffiInternalName(surfaceName, memberName, index),
      memberName,
      target,
      type: fallible ? fallibleType(variant.type) : variant.type,
      resultRef: variant.resultRef,
      callbackParamRefs: variant.callbackParamRefs,
      fallible,
      node,
    });
  }
  bindings.set(surfaceName, binding);
}

function generatedJsImports(
  decl: Extract<Decl, { kind: "JsImportDecl" }>,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
): Decl[] {
  if (decl.clause.kind === "Namespace") {
    const specs = [...bindings.values()]
      .filter((binding) => binding.surfaceName.startsWith(`${decl.clause.alias}.`))
      .flatMap((binding) =>
        binding.variants
          .filter((variant) => selected.has(variant.internalName))
          .map((variant) => ({
            name: variant.memberName,
            alias: variant.internalName,
            type: variant.type,
            fallible: variant.fallible,
            node: variant.node,
          }))
      );
    if (specs.length === 0) return [];
    return [{
      ...decl,
      clause: {
        kind: "Named",
        specs,
        node: decl.clause.node,
      },
    }];
  }
  const clauseNode = decl.clause.node;
  return decl.clause.specs.flatMap((spec) => {
    if (decl.target.kind === "JsGlobalRoot" && !spec.type) return [];
    const localName = spec.alias ?? spec.name;
    const surfaceName = decl.clause.alias ? `${decl.clause.alias}.${localName}` : localName;
    const binding = bindings.get(surfaceName);
    if (!binding) return [namedJsImportDecl(decl, [spec], clauseNode)];
    const variants = binding.variants;
    if (variants.length === 1 && !decl.clause.alias) {
      return [namedJsImportDecl(
        decl,
        [{ ...spec, type: variants[0].type, fallible: variants[0].fallible }],
        clauseNode,
      )];
    }
    const selectedVariants = variants.filter((variant) => selected.has(variant.internalName));
    if (selectedVariants.length === 0) return [];
    return [namedJsImportDecl(
      decl,
      selectedVariants.map((variant) => ({
        ...spec,
        name: variant.memberName,
        alias: variant.internalName,
        type: variant.type,
        fallible: variant.fallible,
      })),
      clauseNode,
    )];
  });
}

function generatedReceiverJsImports(
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
): Decl[] {
  const variants = [...bindings.values()]
    .flatMap((binding) => binding.variants)
    .filter((variant) =>
      selected.has(variant.internalName) &&
      (variant.target.kind === "JsReceiver" || variant.target.kind === "JsConstructor")
    );
  return variants.map((variant) => ({
    kind: "JsImportDecl" as const,
    target: variant.target,
    clause: {
      kind: "Named" as const,
      specs: [{
        name: variant.memberName,
        alias: variant.internalName,
        type: variant.type,
        fallible: variant.fallible,
        node: variant.node,
      }],
    },
  }));
}

function generatedTypeAliases(importedTypeRefs: Map<string, JsTypeRef>): Decl[] {
  return [...importedTypeRefs.keys()].map((typeName) => ({
    kind: "ForeignTypeDecl" as const,
    name: typeName,
  }));
}

function namedJsImportDecl(
  decl: Extract<Decl, { kind: "JsImportDecl" }>,
  specs: JsImportSpec[],
  node: Extract<Decl, { kind: "JsImportDecl" }>["clause"]["node"],
): Extract<Decl, { kind: "JsImportDecl" }> {
  return {
    ...decl,
    clause: { kind: "Named", specs, node },
  };
}

function rewriteDeclCalls(
  decl: Decl,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
): Decl {
  if (decl.kind !== "LetDecl") return decl;
  return {
    ...decl,
    bindings: decl.bindings.map((binding) => ({
      ...binding,
      value: rewriteExprCalls(
        binding.value,
        bindings,
        selected,
        refs,
        resultRefs,
        objectAccess,
        importedTypeRefs,
      ),
    })),
  };
}

function rewriteExprCalls(
  expr: Expr,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
): Expr {
  switch (expr.kind) {
    case "Var": {
      const property = reflectedReceiverProperty(expr.name, bindings, selected, refs);
      return property ??
        objectReceiverProperty(expr.name, bindings, selected, objectAccess) ??
        expr;
    }
    case "Call": {
      if (expr.callee.kind === "Var") {
        const variants = bindings.get(expr.callee.name)?.variants ?? [];
        const variant = variants.length > 1 || expr.callee.name.includes(".")
          ? selectVariant(variants, expr.args)
          : undefined;
        if (variant) {
          selected.add(variant.internalName);
          const args = rewriteArgsWithVariant(
            expr.args,
            variant,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          );
          return { ...expr, callee: { ...expr.callee, name: variant.internalName }, args };
        }
        if (variants.length > 0 && (variants.length > 1 || expr.callee.name.includes("."))) {
          throw diagnosticError(
            new Error(ffiOverloadMessage(expr.callee.name, variants, expr.args)),
            expr.node,
          );
        }
        const receiver = reflectedReceiverCall(
          expr.callee.name,
          expr.args,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        );
        if (receiver) return { ...expr, callee: receiver.callee, args: receiver.args };
      }
      const args = expr.args.map((arg) =>
        rewriteExprCalls(
          arg,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        )
      );
      const callee = rewriteExprCalls(
        expr.callee,
        bindings,
        selected,
        refs,
        resultRefs,
        objectAccess,
        importedTypeRefs,
      );
      return { ...expr, callee, args };
    }
    case "Tuple":
      return {
        ...expr,
        items: expr.items.map((item) =>
          rewriteExprCalls(
            item,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          )
        ),
      };
    case "Record":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: rewriteExprCalls(
            field.value,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          ),
        })),
      };
    case "JsonObject":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: rewriteExprCalls(
            field.value,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          ),
        })),
      };
    case "JsonArray":
      return {
        ...expr,
        items: expr.items.map((item) =>
          rewriteExprCalls(
            item,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          )
        ),
      };
    case "Lambda": {
      const localObjectAccess = new Map(objectAccess);
      rememberObjectParams(expr.params, localObjectAccess, importedTypeRefs);
      rememberUnannotatedParams(expr.params, localObjectAccess);
      return {
        ...expr,
        body: rewriteExprCalls(
          expr.body,
          bindings,
          selected,
          refs,
          resultRefs,
          localObjectAccess,
          importedTypeRefs,
        ),
      };
    }
    case "If":
      return {
        ...expr,
        cond: rewriteExprCalls(
          expr.cond,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
        thenExpr: rewriteExprCalls(
          expr.thenExpr,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
        elseExpr: rewriteExprCalls(
          expr.elseExpr,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    case "Match":
      const value = rewriteExprCalls(
        expr.value,
        bindings,
        selected,
        refs,
        resultRefs,
        objectAccess,
        importedTypeRefs,
      );
      return {
        ...expr,
        value,
        arms: rewriteMatchArms(
          { ...expr, value },
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    case "Panic":
      return {
        ...expr,
        message: rewriteExprCalls(
          expr.message,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    case "Block":
      return rewriteBlock(
        expr,
        bindings,
        selected,
        refs,
        resultRefs,
        objectAccess,
        importedTypeRefs,
      );
    case "Binary":
      return {
        ...expr,
        left: rewriteExprCalls(
          expr.left,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
        right: rewriteExprCalls(
          expr.right,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    case "Unary":
      return {
        ...expr,
        value: rewriteExprCalls(
          expr.value,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    default:
      return expr;
  }
}

function jsTargetMembers(target: JsTarget) {
  if (target.kind === "JsGlobalRoot") return [];
  if (target.kind === "JsGlobal") return jsGlobalMembers(target.path);
  if (target.kind === "JsModule") return jsModuleMembers(target.specifier);
  return [];
}

function rewriteBlock(
  expr: Extract<Expr, { kind: "Block" }>,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
): Expr {
  const localRefs = new Map(refs);
  const localResultRefs = new Map(resultRefs);
  const localObjectAccess = new Map(objectAccess);
  const items = expr.items.map((item) => {
    const rewritten = isDecl(item)
      ? rewriteDeclCalls(
        item,
        bindings,
        selected,
        localRefs,
        localResultRefs,
        localObjectAccess,
        importedTypeRefs,
      )
      : rewriteExprCalls(
        item,
        bindings,
        selected,
        localRefs,
        localResultRefs,
        localObjectAccess,
        importedTypeRefs,
      );
    if (isDecl(rewritten)) {
      rememberLetRefs(
        rewritten,
        bindings,
        localRefs,
        localResultRefs,
        localObjectAccess,
        importedTypeRefs,
      );
    }
    return rewritten;
  });
  return {
    ...expr,
    items,
    result: rewriteExprCalls(
      expr.result,
      bindings,
      selected,
      localRefs,
      localResultRefs,
      localObjectAccess,
      importedTypeRefs,
    ),
  };
}

function rewriteMatchArms(
  expr: Extract<Expr, { kind: "Match" }>,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
): Extract<Expr, { kind: "Match" }>["arms"] {
  const matchedRef = resultRefForExpr(expr.value, bindings, resultRefs);
  return expr.arms.map((arm) => {
    const localRefs = new Map(refs);
    const localObjectAccess = new Map(objectAccess);
    if (matchedRef) {
      for (const binder of okPayloadBinders(arm.pattern)) {
        localRefs.set(binder, matchedRef);
      }
    }
    return {
      ...arm,
      body: rewriteExprCalls(
        arm.body,
        bindings,
        selected,
        localRefs,
        resultRefs,
        localObjectAccess,
        importedTypeRefs,
      ),
    };
  });
}

function jsTargetMember(target: JsTarget, name: string) {
  if (target.kind === "JsGlobalRoot") return undefined;
  if (target.kind === "JsGlobal") return jsGlobalMember(target.path, name);
  if (target.kind === "JsModule") return jsModuleMember(target.specifier, name);
  return undefined;
}

function memberVariants(
  member: JsMemberType,
): { type: TypeExpr; resultRef?: JsTypeRef; callbackParamRefs?: JsCallbackParamRefs[] }[] {
  if (member.variants) return member.variants;
  return [member.type, ...(member.overloads ?? [])].map((type) => ({ type }));
}

function rewriteArgsWithVariant(
  args: Expr[],
  variant: FfiVariant,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
): Expr[] {
  return args.map((arg, index) => {
    const callbackRefs = variant.callbackParamRefs?.find((item) => item.argIndex === index);
    return rewriteExprCalls(
      arg,
      bindings,
      selected,
      refsForCallbackArg(refs, arg, callbackRefs?.params),
      resultRefs,
      objectAccess,
      importedTypeRefs,
    );
  });
}

function refsForCallbackArg(
  refs: Map<string, JsTypeRef>,
  arg: Expr,
  paramRefs: JsTypeRef[] | undefined,
): Map<string, JsTypeRef> {
  if (arg.kind !== "Lambda" || !paramRefs?.length) return refs;
  const localRefs = new Map(refs);
  for (let index = 0; index < arg.params.length; index++) {
    const binder = paramBinder(arg.params[index]);
    const ref = paramRefs[index];
    if (binder && ref) localRefs.set(binder, ref);
  }
  return localRefs;
}

function paramBinder(param: Param): string | undefined {
  return param.pattern.kind === "PVar" ? param.pattern.name : undefined;
}

function reflectedReceiverCall(
  name: string,
  args: Expr[],
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
): { callee: Expr; args: Expr[] } | undefined {
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
  const receiverArg: Expr = { kind: "Var", name: baseName };
  const allArgs = [receiverArg, ...args];
  const variant = selectVariant(bindings.get(surfaceName)?.variants ?? [], allArgs);
  if (!variant) return undefined;
  selected.add(variant.internalName);
  return {
    callee: { kind: "Var", name: variant.internalName },
    args: rewriteArgsWithVariant(
      allArgs,
      variant,
      bindings,
      selected,
      refs,
      resultRefs,
      objectAccess,
      importedTypeRefs,
    ),
  };
}

function reflectedReceiverProperty(
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

function objectReceiverProperty(
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

function rememberObjectParams(
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

function rememberUnannotatedParams(params: Param[], objectAccess: Map<string, ObjectAccess>) {
  for (const param of params) {
    if (param.annotation) continue;
    const binder = paramBinder(param);
    if (binder && !objectAccess.has(binder)) objectAccess.set(binder, { kind: "unresolved" });
  }
}

function isJsObjectType(type: TypeExpr | undefined): boolean {
  return type?.kind === "TName" && type.name === "Js.Object" && type.args.length === 0;
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

function callArgHint(expr: Expr): JsCallArgHint {
  if (expr.kind === "String") return { kind: "string", value: expr.value };
  if (expr.kind === "Lambda") return { kind: "function", arity: expr.params.length };
  return { kind: "unknown" };
}

function prependReceiver(type: TypeExpr, receiverType: TypeExpr = name("Js.Object")): TypeExpr {
  if (type.kind !== "TFn") return fn([receiverType], type);
  return { ...type, params: [receiverType, ...type.params] };
}

function rememberLetRefs(
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

function variantFromCall(expr: Expr, bindings: Map<string, FfiBinding>): FfiVariant | undefined {
  if (expr.kind !== "Call" || expr.callee.kind !== "Var") return undefined;
  const calleeName = expr.callee.name;
  for (const binding of bindings.values()) {
    const found = binding.variants.find((variant) => variant.internalName === calleeName);
    if (found) return found;
  }
  return undefined;
}

function resultRefForExpr(
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

function okPayloadBinders(pattern: Pattern): string[] {
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

function ffiInternalName(surfaceName: string, memberName: string, index: number): string {
  return `__ffi_${sanitize(surfaceName)}_${sanitize(memberName)}_${index}`;
}

function typeCallArity(type: TypeExpr): number | undefined {
  return type.kind === "TFn" ? type.params.length : undefined;
}

function selectVariant(variants: FfiVariant[], args: Expr[]): FfiVariant | undefined {
  return variants
    .filter((candidate) => typeCallArity(candidate.type) === args.length)
    .map((candidate) => ({ candidate, score: callScore(candidate.type, args) }))
    .sort((left, right) => left.score - right.score)[0]?.candidate;
}

function ffiOverloadMessage(name: string, variants: FfiVariant[], args: Expr[]): string {
  const arities = [
    ...new Set(
      variants.map((variant) => typeCallArity(variant.type)).filter(
        (arity): arity is number => arity !== undefined,
      ),
    ),
  ].sort((left, right) => left - right);
  return `cannot determine JS FFI overload for ${name} with ${args.length} arguments${
    arities.length ? `; available arities: ${arities.join(", ")}` : ""
  }`;
}

function callScore(type: TypeExpr, args: Expr[]): number {
  if (type.kind !== "TFn") return Number.POSITIVE_INFINITY;
  return type.params.reduce((score, param, index) => score + argScore(param, args[index]), 0);
}

function argScore(expected: TypeExpr, arg: Expr): number {
  const actual = literalType(arg);
  if (!actual) return 1;
  if (expected.kind === "TName" && expected.name === actual) return 0;
  if (expected.kind === "TName" && expected.name === "Js.Value") return 2;
  return 10;
}

function literalType(expr: Expr): string | undefined {
  switch (expr.kind) {
    case "Int":
    case "Float":
      return "Number";
    case "String":
      return "String";
    case "Bool":
      return "Bool";
    case "Void":
      return "Void";
    case "JsonObject":
    case "JsonArray":
      return "Js.Value";
    default:
      return undefined;
  }
}

function dedupeVariantSpecs<T extends { type: TypeExpr }>(types: T[]): T[] {
  const seen = new Set<string>();
  return types.filter((type) => {
    const key = typeKey(type.type);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function name(typeName: string): TypeExpr {
  return { kind: "TName", name: typeName, args: [] };
}

function fn(params: TypeExpr[], result: TypeExpr): TypeExpr {
  return { kind: "TFn", params, result };
}

function fallibleType(type: TypeExpr): TypeExpr {
  if (type.kind !== "TFn") return result(type);
  return { ...type, result: result(type.result) };
}

function result(ok: TypeExpr): TypeExpr {
  return { kind: "TName", name: "Result", args: [ok, name("Js.Error")] };
}

function typeKey(type: TypeExpr): string {
  switch (type.kind) {
    case "TName":
      return `${type.name}<${type.args.map(typeKey).join(",")}>`;
    case "TVar":
      return `'${type.name}`;
    case "TTuple":
      return `(${type.items.map(typeKey).join(",")})`;
    case "TFn":
      return `(${type.params.map(typeKey).join(",")})->${typeKey(type.result)}`;
  }
}

function isDecl(value: Decl | Expr): value is Decl {
  return "kind" in value &&
    (value.kind === "ImportDecl" || value.kind === "JsImportDecl" || value.kind === "LetDecl" ||
      value.kind === "RecordDecl" || value.kind === "TypeDecl" || value.kind === "ForeignTypeDecl");
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_]/g, "_");
}
