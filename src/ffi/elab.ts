import type { Decl, Expr, Module } from "../ast.ts";
import type { JsTypeRef } from "./reflect/types.ts";
import { collectFfiDecl, generatedJsImports, generatedTypeAliases } from "./imports.ts";
import {
  letBindingPassesThroughOkPayload,
  type ObjectAccess,
  rememberLetRefs,
  resultRefForExpr,
} from "./receiver/receiver.ts";
import { rewriteDeclCalls } from "./receiver/rewrite_decl.ts";
import { rewriteExprCalls, setActiveRecordFields } from "./receiver/rewrite_expr.ts";
import {
  type FfiBinding,
  type FfiElaboration,
  type FfiVariant,
  generatedReceiverJsImports,
} from "./shared.ts";

export function prepareFfiElaboration(module: Module): FfiElaboration {
  const previousRecordFields = setActiveRecordFields(recordFieldNames(module));
  try {
    return prepareFfiElaborationInner(module);
  } finally {
    setActiveRecordFields(previousRecordFields);
  }
}

function prepareFfiElaborationInner(module: Module): FfiElaboration {
  const bindings = new Map<string, FfiBinding>();
  const importedRefs = new Map<string, JsTypeRef>();
  const importedTypeRefs = new Map<string, JsTypeRef>();
  for (const decl of module.decls) {
    if (decl.kind !== "JsImportDecl" || !decl.typeOnly) continue;
    collectFfiDecl(bindings, importedRefs, importedTypeRefs, decl);
  }
  for (const decl of module.decls) {
    if (decl.kind !== "JsImportDecl" || decl.typeOnly) continue;
    collectFfiDecl(bindings, importedRefs, importedTypeRefs, decl);
  }
  collectReflectedCallbackTypeRefs(bindings, importedTypeRefs);
  const selected = new Set<string>();
  const refs = new Map(importedRefs);
  const resultRefs = new Map<string, JsTypeRef>();
  const objectAccess = new Map<string, ObjectAccess>();
  const passThroughRefs = new Set<string>();
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
      passThroughRefs,
      rewriteExprCalls,
    );
    for (const name of letBindingPassesThroughOkPayload(rewritten)) passThroughRefs.add(name);
    rememberLetRefs(
      rewritten,
      bindings,
      refs,
      resultRefs,
      objectAccess,
      importedTypeRefs,
      passThroughRefs,
    );
    rewrittenDecls.push(rewritten);
  }
  const decls = [
    ...generatedTypeAliases(importedTypeRefs),
    ...generatedReceiverJsImports(bindings, selected),
    ...rewrittenDecls.flatMap((decl) =>
      decl.kind === "JsImportDecl" ? generatedJsImports(decl, bindings, selected) : [decl]
    ),
  ];
  const expressionRefs = collectExpressionRefs(
    rewrittenDecls,
    bindings,
    resultRefs,
    passThroughRefs,
  );
  const namedCallbackRefs = collectNamedCallbackRefs(rewrittenDecls, bindings);
  return {
    module: { ...module, decls },
    bindings,
    foreignTypeRefs: importedTypeRefs,
    expressionRefs,
    namedCallbackRefs,
    passThroughRefs,
    selected,
  };
}

function recordFieldNames(module: Module): Set<string> {
  const fields = new Set<string>();
  for (const decl of module.decls) {
    if (decl.kind !== "RecordDecl") continue;
    for (const field of decl.fields) fields.add(field.name);
  }
  return fields;
}

function collectReflectedCallbackTypeRefs(
  bindings: Map<string, FfiBinding>,
  foreignTypeRefs: Map<string, JsTypeRef>,
) {
  for (const binding of bindings.values()) {
    for (const variant of binding.variants) {
      for (const callback of variant.callbackParamRefs ?? []) {
        for (const ref of callback.params) {
          if (ref.type?.kind !== "TName" || ref.type.args.length !== 0) continue;
          const name = ref.type.name;
          if (name.includes(".")) continue;
          if (name === "String" || name === "Number" || name === "Bool" || name.startsWith("Js.")) {
            continue;
          }
          foreignTypeRefs.set(name, ref);
          foreignTypeRefs.set(ref.key, ref);
        }
      }
    }
  }
}

function collectNamedCallbackRefs(
  decls: Decl[],
  bindings: Map<string, FfiBinding>,
): Map<string, JsTypeRef[]> {
  const refs = new Map<string, JsTypeRef[]>();
  const variants = new Map<string, FfiVariant>();
  for (const binding of bindings.values()) {
    for (const variant of binding.variants) variants.set(variant.internalName, variant);
    if (binding.variants.length === 1) variants.set(binding.surfaceName, binding.variants[0]);
  }
  const visit = (expr: Expr) => {
    switch (expr.kind) {
      case "Call": {
        const variant = expr.callee.kind === "Var" ? variants.get(expr.callee.name) : undefined;
        if (variant?.callbackParamRefs) {
          for (const item of variant.callbackParamRefs) {
            const arg = expr.args[item.argIndex];
            if (arg?.kind === "Var") refs.set(arg.name, item.params);
          }
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
      case "FfiGet":
        visit(expr.receiver);
        return;
      case "FfiCall":
        visit(expr.receiver);
        expr.args.forEach(visit);
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
          if (item.kind === "LetDecl") {
            item.bindings.forEach((binding) => visit(binding.value));
          } else if (
            item.kind !== "ImportDecl" && item.kind !== "JsImportDecl" &&
            item.kind !== "ForeignTypeDecl" && item.kind !== "RecordDecl" &&
            item.kind !== "TypeDecl"
          ) {
            visit(item);
          }
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
  for (const decl of decls) {
    if (decl.kind === "LetDecl") {
      decl.bindings.forEach((binding) => visit(binding.value));
    }
  }
  return refs;
}

function collectExpressionRefs(
  decls: Decl[],
  bindings: Map<string, FfiBinding>,
  resultRefs: Map<string, JsTypeRef>,
  passThroughRefs: Set<string>,
): Map<Expr, JsTypeRef> {
  const refs = new Map<Expr, JsTypeRef>();
  const visit = (expr: Expr) => {
    const ref = resultRefForExpr(expr, bindings, resultRefs, passThroughRefs);
    if (ref) refs.set(expr, ref);
    switch (expr.kind) {
      case "Tuple":
      case "JsonArray":
        expr.items.forEach(visit);
        return;
      case "Record":
      case "JsonObject":
        expr.fields.forEach((field) => visit(field.value));
        return;
      case "FfiGet":
        visit(expr.receiver);
        return;
      case "FfiCall":
        visit(expr.receiver);
        expr.args.forEach(visit);
        return;
      case "Lambda":
        visit(expr.body);
        return;
      case "Call":
        visit(expr.callee);
        expr.args.forEach(visit);
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
          if (item.kind === "LetDecl") {
            item.bindings.forEach((binding) => visit(binding.value));
          } else if (
            item.kind !== "ImportDecl" && item.kind !== "JsImportDecl" &&
            item.kind !== "ForeignTypeDecl" && item.kind !== "RecordDecl" &&
            item.kind !== "TypeDecl"
          ) {
            visit(item);
          }
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
  for (const decl of decls) {
    if (decl.kind === "LetDecl") {
      decl.bindings.forEach((binding) => visit(binding.value));
    }
  }
  return refs;
}
