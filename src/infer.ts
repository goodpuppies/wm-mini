import type { Binding, Decl, Expr, Module, Param } from "./ast.ts";
import { diagnosticError, type FrontendDiagnostic, warningDiagnostic } from "./diagnostics.ts";
import {
  baseEnv,
  baseTypeEnv,
  BoolTy,
  Env,
  fn,
  fresh,
  freshTypeInfo,
  generalize,
  instantiate,
  named,
  NumberTy,
  prune,
  Scheme,
  StringTy,
  tuple,
  Ty,
  TypeDeclInfo,
  TypeEnv,
  typeFromAst,
  TypeVarScope,
  VoidTy,
} from "./types.ts";
import { checkExhaustive, isVectorExhaustive, mentionsLocalType } from "./infer/exhaustiveness.ts";
import {
  hasUnguardedRecursiveRef,
  referencesTypeName,
  rejectDuplicates,
  warnRedundantMatchArms,
} from "./infer/decl_helpers.ts";
import { addAdts, addImport } from "./infer/imports.ts";
import {
  inferBindingPattern,
  inferPattern,
  patternBinders,
  showPattern,
} from "./infer/patterns.ts";
import {
  addExportableTypes,
  assertExportableRecord,
  assertExportableType,
  exportedAdts,
} from "./infer/module_exports.ts";
import { inferDottedVar, inferRecordExpr } from "./infer/records.ts";
import { snapshotEnv, type TypeSnapshot } from "./infer/snapshots.ts";
import { callArg, constrain } from "./infer/shared.ts";

export type StructureEnv = { values: Env; types: TypeEnv; adts: Map<number, TypeDeclInfo> };

export type InferResult = {
  structure: StructureEnv;
  exportedStructure: StructureEnv;
  env: Env;
  exports: Env;
  typeEnv: TypeEnv;
  typeExports: TypeEnv;
  types: Map<Expr, Ty>;
  adts: Map<number, TypeDeclInfo>;
  warnings: string[];
  diagnostics: FrontendDiagnostic[];
};

export { describeEnv, type TypeSnapshot } from "./infer/snapshots.ts";
export type InferStep = { declIndex: number; env: Map<string, TypeSnapshot> };

export function inferModule(module: Module, imports = new Map<string, InferResult>()): InferResult {
  return inferModuleWithSteps(module, imports).result;
}

export function inferModuleWithSteps(
  module: Module,
  imports = new Map<string, InferResult>(),
): { result: InferResult; steps: InferStep[] } {
  const env = baseEnv();
  const exports: Env = new Map();
  const typeEnv = baseTypeEnv();
  const typeExports: TypeEnv = new Map();
  const adts = new Map<number, TypeDeclInfo>();
  const exportableTypeIds = new Set([...typeEnv.values()].map((info) => info.id));
  const types = new Map<Expr, Ty>();
  const warnings: string[] = [];
  const diagnostics: FrontendDiagnostic[] = [];
  const steps: InferStep[] = [];
  for (const [declIndex, decl] of module.decls.entries()) {
    if (decl.kind === "ImportDecl") {
      try {
        const imported = imports.get(decl.path);
        if (!imported) throw new Error(`unknown import ${decl.path}`);
        addImport(env, typeEnv, decl.clause, imported);
        addAdts(adts, imported.exportedStructure.adts);
        addExportableTypes(exportableTypeIds, imported.exportedStructure.types);
      } catch (error) {
        throw diagnosticError(error, decl.node);
      }
      continue;
    }
    try {
      inferDecl(
        decl,
        env,
        exports,
        typeEnv,
        typeExports,
        adts,
        types,
        warnings,
        diagnostics,
        exportableTypeIds,
      );
    } catch (error) {
      throw diagnosticError(error, decl.node);
    }
    steps.push({ declIndex, env: snapshotEnv(env) });
  }
  const structure: StructureEnv = { values: env, types: typeEnv, adts };
  const exportedStructure: StructureEnv = {
    values: exports,
    types: typeExports,
    adts: exportedAdts(adts, typeExports),
  };
  return {
    result: {
      structure,
      exportedStructure,
      env,
      exports,
      typeEnv,
      typeExports,
      types,
      adts,
      warnings,
      diagnostics,
    },
    steps,
  };
}

function isDecl(value: Decl | Expr): value is Decl {
  return value.kind === "ImportDecl" || value.kind === "LetDecl" ||
    value.kind === "TypeDecl" || value.kind === "RecordDecl";
}

function inferDecl(
  decl: Decl,
  env: Env,
  exports: Env,
  typeEnv: TypeEnv,
  typeExports: TypeEnv,
  adts: Map<number, TypeDeclInfo>,
  types: Map<Expr, Ty>,
  warnings: string[],
  diagnostics: FrontendDiagnostic[],
  exportableTypeIds: Set<number>,
) {
  if (decl.kind === "ImportDecl") return;
  if (decl.kind === "RecordDecl") {
    if (typeEnv.has(decl.name)) throw new Error(`duplicate type declaration ${decl.name}`);
    rejectDuplicates(decl.params, "type parameter");
    rejectDuplicates(decl.fields.map((field) => field.name), "record field");
    const info = freshTypeInfo(decl.name, decl.params.length);
    typeEnv.set(decl.name, info);
    if (decl.exported) typeExports.set(decl.name, info);
    const vars = new Map(decl.params.map((p) => [p, fresh(p)] as const));
    info.recordFields = decl.fields.map((field) => ({
      name: field.name,
      type: typeFromAst(field.type, typeEnv, vars, { allowFreeVars: false }),
    }));
    info.recordParams = decl.params.map((p) => {
      const v = prune(vars.get(p)!);
      if (v.tag !== "var") throw new Error("invalid record type parameter");
      return v.id;
    });
    if (decl.exported) {
      exportableTypeIds.add(info.id);
      assertExportableRecord(info, exportableTypeIds);
    }
    return;
  }
  if (decl.kind === "TypeDecl") {
    if (typeEnv.has(decl.name)) throw new Error(`duplicate type declaration ${decl.name}`);
    rejectDuplicates(decl.params, "type parameter");
    const info = freshTypeInfo(decl.name, decl.params.length);
    typeEnv.set(decl.name, info);
    if (decl.exported) typeExports.set(decl.name, info);
    if (decl.alias) {
      if (referencesTypeName(decl.alias, decl.name, new Set(decl.params))) {
        throw new Error(`cyclic type alias ${decl.name}`);
      }
      const vars = new Map(decl.params.map((p) => [p, fresh(p)] as const));
      info.alias = typeFromAst(decl.alias, typeEnv, vars, { allowFreeVars: false });
      info.aliasParams = decl.params.map((p) => {
        const v = prune(vars.get(p)!);
        if (v.tag !== "var") throw new Error("invalid type alias parameter");
        return v.id;
      });
      if (decl.exported) {
        exportableTypeIds.add(info.id);
        assertExportableType(info.alias, exportableTypeIds, `exported type ${decl.name}`);
      }
      return;
    }
    rejectDuplicates(decl.ctors.map((c) => c.name), "constructor");
    const vars = new Map(decl.params.map((p) => [p, fresh(p)] as const));
    const result = named(info, decl.params.map((p) => vars.get(p)!));
    const paramTypeIds = decl.params.map((p) => {
      const v = prune(vars.get(p)!);
      if (v.tag !== "var") throw new Error("invalid datatype type parameter");
      return v.id;
    });
    if (decl.exported) exportableTypeIds.add(info.id);
    const ctorTypes: Ty[][] = [];
    for (const c of decl.ctors) {
      const args = c.args.map((x) => typeFromAst(x, typeEnv, vars, { allowFreeVars: false }));
      ctorTypes.push(args);
      if (decl.exported) {
        args.forEach((arg) =>
          assertExportableType(arg, exportableTypeIds, `exported type ${decl.name}`)
        );
      }
      const t = args.length === 0 ? result : fn([callArg(args)], result);
      const scheme = generalize(env, t);
      env.set(c.name, scheme);
      if (decl.exported) exports.set(c.name, scheme);
    }
    adts.set(info.id, { ...decl, type: info, paramTypeIds, ctorTypes });
    return;
  }
  rejectDuplicates(decl.bindings.flatMap((b) => patternBinders(b.pattern)), "binding");
  const annotationVars: TypeVarScope = new Map();
  if (!decl.recursive) {
    const base = new Map(env);
    const inferred = decl.bindings.map((b) =>
      inferBinding(b, base, typeEnv, adts, types, warnings, diagnostics, annotationVars)
    );
    inferred.forEach((result, i) => {
      if (result.refutable) {
        const message = `refutable let pattern may fail at runtime: ${
          showPattern(decl.bindings[i].pattern)
        }`;
        warnings.push(message);
        diagnostics.push(
          warningDiagnostic(message, decl.bindings[i].pattern.node, "pattern.refutable-let"),
        );
      }
      for (const [name, type] of result.bound) {
        const scheme = generalize(base, type);
        env.set(name, scheme);
        if (decl.exported) {
          assertExportableType(scheme.type, exportableTypeIds, `exported value ${name}`);
          exports.set(name, scheme);
        }
      }
    });
    return;
  }
  const base = new Map(env);
  for (const b of decl.bindings) {
    if (b.pattern.kind !== "PVar") throw new Error("recursive bindings must bind one name");
  }
  const recursiveNames = new Set(decl.bindings.map((b) => (b.pattern as { name: string }).name));
  for (const b of decl.bindings) {
    if (hasUnguardedRecursiveRef(b.value, recursiveNames)) {
      throw new Error("recursive references must be guarded by a function");
    }
  }
  const placeholders = decl.bindings.map(() => fresh());
  decl.bindings.forEach((b, i) =>
    env.set((b.pattern as { name: string }).name, { vars: [], type: placeholders[i] })
  );
  decl.bindings.forEach((b, i) => {
    constrain(
      placeholders[i],
      inferExpr(b.value, env, typeEnv, adts, types, warnings, diagnostics),
    );
    if (b.annotation) {
      constrain(placeholders[i], typeFromAst(b.annotation, typeEnv, annotationVars));
    }
  });
  decl.bindings.forEach((b, i) => {
    const scheme = generalize(base, placeholders[i]);
    const name = (b.pattern as { name: string }).name;
    env.set(name, scheme);
    if (decl.exported) {
      assertExportableType(scheme.type, exportableTypeIds, `exported value ${name}`);
      exports.set(name, scheme);
    }
  });
}

function inferBinding(
  b: Binding,
  env: Env,
  typeEnv: TypeEnv,
  adts: Map<number, TypeDeclInfo>,
  types: Map<Expr, Ty>,
  warnings: string[],
  diagnostics: FrontendDiagnostic[],
  annotationVars: TypeVarScope,
): { bound: Map<string, Ty>; refutable: boolean } {
  try {
    const annotated = b.annotation ? typeFromAst(b.annotation, typeEnv, annotationVars) : undefined;
    const t = annotated && b.value.kind === "Record"
      ? inferRecordExpr(
        b.value,
        typeEnv,
        (value) => inferExpr(value, env, typeEnv, adts, types, warnings, diagnostics),
        annotated,
      )
      : inferExpr(b.value, env, typeEnv, adts, types, warnings, diagnostics);
    if (annotated) constrain(t, annotated);
    const bound = new Map<string, Ty>();
    inferBindingPattern(b.pattern, t, env, typeEnv, bound);
    const refutable = !isVectorExhaustive([[b.pattern]], [t], typeEnv, adts);
    return { bound, refutable };
  } catch (error) {
    throw diagnosticError(error, b.node);
  }
}

function inferExpr(
  expr: Expr,
  env: Env,
  typeEnv: TypeEnv,
  adts: Map<number, TypeDeclInfo>,
  types: Map<Expr, Ty>,
  warnings: string[] = [],
  diagnostics: FrontendDiagnostic[] = [],
): Ty {
  try {
    return inferExprInner(expr, env, typeEnv, adts, types, warnings, diagnostics);
  } catch (error) {
    throw diagnosticError(error, expr.node);
  }
}

function inferExprInner(
  expr: Expr,
  env: Env,
  typeEnv: TypeEnv,
  adts: Map<number, TypeDeclInfo>,
  types: Map<Expr, Ty>,
  warnings: string[] = [],
  diagnostics: FrontendDiagnostic[] = [],
): Ty {
  let t: Ty;
  switch (expr.kind) {
    case "Int":
    case "Float":
      t = NumberTy;
      break;
    case "String":
      t = StringTy;
      break;
    case "Bool":
      t = BoolTy;
      break;
    case "Void":
      t = VoidTy;
      break;
    case "Var": {
      const scheme = env.get(expr.name);
      if (!scheme) {
        t = inferDottedVar(expr.name, env, typeEnv);
        break;
      }
      t = instantiate(scheme);
      break;
    }
    case "Tuple":
      t = tuple(
        expr.items.map((x) => inferExpr(x, env, typeEnv, adts, types, warnings, diagnostics)),
      );
      break;
    case "Record":
      t = inferRecordExpr(
        expr,
        typeEnv,
        (value) => inferExpr(value, env, typeEnv, adts, types, warnings, diagnostics),
      );
      break;
    case "Lambda": {
      const local = new Map(env);
      const annotationVars: TypeVarScope = new Map();
      const binders = new Set<string>();
      const params = expr.params.map((p) =>
        inferParam(p, local, typeEnv, adts, annotationVars, binders)
      );
      t = fn(
        [callArg(params)],
        inferExpr(expr.body, local, typeEnv, adts, types, warnings, diagnostics),
      );
      break;
    }
    case "Call": {
      const result = fresh();
      const arg = callArg(
        expr.args.map((a) => inferExpr(a, env, typeEnv, adts, types, warnings, diagnostics)),
      );
      constrain(
        inferExpr(expr.callee, env, typeEnv, adts, types, warnings, diagnostics),
        fn([arg], result),
      );
      t = result;
      break;
    }
    case "If":
      constrain(inferExpr(expr.cond, env, typeEnv, adts, types, warnings, diagnostics), BoolTy);
      t = inferExpr(expr.thenExpr, env, typeEnv, adts, types, warnings, diagnostics);
      constrain(t, inferExpr(expr.elseExpr, env, typeEnv, adts, types, warnings, diagnostics));
      break;
    case "Match": {
      const valueType = inferExpr(expr.value, env, typeEnv, adts, types, warnings, diagnostics);
      t = fresh();
      for (const arm of expr.arms) {
        const local = new Map(env);
        inferPattern(arm.pattern, valueType, local, typeEnv, adts);
        constrain(t, inferExpr(arm.body, local, typeEnv, adts, types, warnings, diagnostics));
      }
      const armPatterns = expr.arms.map((arm) => arm.pattern);
      warnRedundantMatchArms(armPatterns, valueType, typeEnv, adts, warnings, diagnostics);
      const exhaustiveWarning = checkExhaustive(armPatterns, valueType, typeEnv, adts);
      if (exhaustiveWarning) {
        warnings.push(exhaustiveWarning);
        diagnostics.push(warningDiagnostic(exhaustiveWarning, expr.node, "pattern.non-exhaustive"));
      }
      break;
    }
    case "Block": {
      const local = new Map(env);
      const localTypes = new Map(typeEnv);
      const outerTypeIds = new Set([...typeEnv.values()].map((info) => info.id));
      expr.items.forEach((s) =>
        isDecl(s)
          ? inferDecl(
            s,
            local,
            new Map(),
            localTypes,
            new Map(),
            adts,
            types,
            warnings,
            diagnostics,
            new Set([...localTypes.values()].map((info) => info.id)),
          )
          : inferExpr(s, local, localTypes, adts, types, warnings, diagnostics)
      );
      t = inferExpr(expr.result, local, localTypes, adts, types, warnings, diagnostics);
      if (mentionsLocalType(t, outerTypeIds)) throw new Error("local type escapes scope");
      break;
    }
    case "Binary": {
      const result = fresh();
      const op: Scheme | undefined = env.get(expr.op);
      if (!op) throw new Error(`unknown operator ${expr.op}`);
      constrain(
        instantiate(op),
        fn(
          [tuple([
            inferExpr(expr.left, env, typeEnv, adts, types, warnings, diagnostics),
            inferExpr(expr.right, env, typeEnv, adts, types, warnings, diagnostics),
          ])],
          result,
        ),
      );
      t = result;
      break;
    }
    case "Unary":
      if (expr.op === "-") {
        constrain(
          inferExpr(expr.value, env, typeEnv, adts, types, warnings, diagnostics),
          NumberTy,
        );
        t = NumberTy;
      } else {
        constrain(inferExpr(expr.value, env, typeEnv, adts, types, warnings, diagnostics), BoolTy);
        t = BoolTy;
      }
      break;
  }
  types.set(expr, t);
  return t;
}

function inferParam(
  param: Param,
  env: Env,
  typeEnv: TypeEnv,
  adts: Map<number, TypeDeclInfo>,
  vars: TypeVarScope,
  binders: Set<string>,
): Ty {
  const expected = param.annotation ? typeFromAst(param.annotation, typeEnv, vars) : fresh();
  return inferPattern(param.pattern, expected, env, typeEnv, adts, binders);
}
