import type { Binding, Expr } from "../ast.ts";
import { diagnosticError } from "../diagnostics.ts";
import {
  type Env,
  type FfiObligation,
  ftv,
  generalize,
  prune,
  quoteType,
  type Scheme,
  show,
  type Ty,
  type TypeDeclInfo,
  type TypeEnv,
  typeFromAst,
  type TypeVarScope,
} from "../types.ts";
import { resultExpr } from "./ast_utils.ts";
import {
  findAccidentalMatchFnInFunction,
  hasTrailingStatementLikeResult,
} from "./decl_match_hint.ts";
import { inferExpr } from "./expr.ts";
import { isVectorExhaustive } from "./exhaustiveness.ts";
import { inferBindingPattern } from "./patterns.ts";
import {
  constrainAt,
  expressionTypeEvidence,
  provenanceForType,
  recursiveResultEvidence,
  type TypeProvenance,
} from "./provenance.ts";
import { inferRecordExpr } from "./records.ts";

export function generalizeBinding(env: Env, type: Ty, value: Expr): Scheme {
  return isNonExpansive(value, env)
    ? { ...generalize(env, type), status: "value" }
    : { vars: [], type, constraints: [], status: "value" };
}

export function withFfiObligations(
  scheme: Scheme,
  value: Expr,
  types: Map<Expr, Ty>,
  inferredObligations: FfiObligation[] = [],
): Scheme {
  const obligations = [...collectFfiObligations(value, types), ...inferredObligations].filter((
    obligation,
  ) => obligationMentionsSchemeVar(obligation, scheme));
  return obligations.length ? { ...scheme, ffiObligations: obligations } : scheme;
}

function obligationMentionsSchemeVar(obligation: FfiObligation, scheme: Scheme): boolean {
  const vars = new Set(scheme.vars);
  return [...ftv(obligation.receiver), ...ftv(obligation.value), ...ftv(obligation.result)].some((
    id,
  ) => vars.has(id));
}

function collectFfiObligations(expr: Expr, types: Map<Expr, Ty>): FfiObligation[] {
  const obligations: FfiObligation[] = [];
  visitFfiObligations(expr, types, obligations);
  return obligations;
}

function visitFfiObligations(expr: Expr, types: Map<Expr, Ty>, obligations: FfiObligation[]) {
  if (expr.kind === "FfiGet") {
    const receiver = types.get(expr.receiver);
    const result = types.get(expr);
    const value = result && ffiGetValueType(result);
    if (receiver && result && value) {
      obligations.push({
        source: expr,
        receiverExpr: expr.receiver,
        path: expr.path,
        receiver,
        value,
        result,
      });
    }
    visitFfiObligations(expr.receiver, types, obligations);
    return;
  }
  if (expr.kind === "FfiCall") {
    const receiver = types.get(expr.receiver);
    const result = types.get(expr);
    const value = result && ffiGetValueType(result);
    if (receiver && result && value) {
      obligations.push({
        source: expr,
        receiverExpr: expr.receiver,
        path: expr.path,
        receiver,
        value,
        result,
      });
    }
    visitFfiObligations(expr.receiver, types, obligations);
    expr.args.forEach((arg) => visitFfiObligations(arg, types, obligations));
    return;
  }
  switch (expr.kind) {
    case "Tuple":
      expr.items.forEach((item) => visitFfiObligations(item, types, obligations));
      return;
    case "Record":
    case "JsonObject":
      expr.fields.forEach((field) => visitFfiObligations(field.value, types, obligations));
      return;
    case "JsonArray":
      expr.items.forEach((item) => visitFfiObligations(item, types, obligations));
      return;
    case "Lambda":
      visitFfiObligations(expr.body, types, obligations);
      return;
    case "Call":
      visitFfiObligations(expr.callee, types, obligations);
      expr.args.forEach((arg) => visitFfiObligations(arg, types, obligations));
      return;
    case "If":
      visitFfiObligations(expr.cond, types, obligations);
      visitFfiObligations(expr.thenExpr, types, obligations);
      visitFfiObligations(expr.elseExpr, types, obligations);
      return;
    case "Match":
      visitFfiObligations(expr.value, types, obligations);
      expr.arms.forEach((arm) => visitFfiObligations(arm.body, types, obligations));
      return;
    case "Panic":
      visitFfiObligations(expr.message, types, obligations);
      return;
    case "Block":
      for (const item of expr.items) {
        if (item.kind === "LetDecl") {
          item.bindings.forEach((binding) =>
            visitFfiObligations(binding.value, types, obligations)
          );
        } else if (
          item.kind !== "ImportDecl" && item.kind !== "JsImportDecl" &&
          item.kind !== "ForeignTypeDecl" && item.kind !== "RecordDecl" && item.kind !== "TypeDecl"
        ) {
          visitFfiObligations(item, types, obligations);
        }
      }
      visitFfiObligations(expr.result, types, obligations);
      return;
    case "Binary":
      visitFfiObligations(expr.left, types, obligations);
      visitFfiObligations(expr.right, types, obligations);
      return;
    case "Unary":
      visitFfiObligations(expr.value, types, obligations);
      return;
    case "Pipe":
      visitFfiObligations(expr.left, types, obligations);
      visitFfiObligations(expr.right, types, obligations);
      return;
  }
}

function ffiGetValueType(result: Ty): Ty | undefined {
  const resolved = prune(result);
  if (resolved.tag === "named" && resolved.name === "Result") return resolved.args[0];
  return undefined;
}

function isNonExpansive(expr: Expr, env: Env): boolean {
  switch (expr.kind) {
    case "Int":
    case "Float":
    case "String":
    case "Bool":
    case "Void":
    case "Var":
    case "Lambda":
    case "Panic":
      return true;
    case "Tuple":
      return expr.items.every((item) => isNonExpansive(item, env));
    case "Record":
      return expr.fields.every((field) => isNonExpansive(field.value, env));
    case "JsonObject":
    case "JsonArray":
      return false;
    case "Call":
      return isConstructorExpr(expr.callee, env) &&
        expr.args.every((arg) => isNonExpansive(arg, env));
    default:
      return false;
  }
}

function isConstructorExpr(expr: Expr, env: Env): boolean {
  return expr.kind === "Var" && env.get(expr.name)?.status === "constructor";
}

export function withSchemeProvenance(
  scheme: Scheme,
  type: Ty,
  provenance: TypeProvenance,
): Scheme {
  const notes = provenanceForType(type, provenance);
  return notes.length ? { ...scheme, provenance: notes } : scheme;
}

export function inferBinding(
  b: Binding,
  env: Env,
  typeEnv: TypeEnv,
  adts: Map<number, TypeDeclInfo>,
  types: Map<Expr, Ty>,
  warnings: string[],
  diagnostics: import("../diagnostics.ts").FrontendDiagnostic[],
  annotationVars: TypeVarScope,
  provenance: TypeProvenance,
  ffiObligations: FfiObligation[],
): { bound: Map<string, Ty>; refutable: boolean; ffiObligations: FfiObligation[] } {
  try {
    const annotated = b.annotation ? typeFromAst(b.annotation, typeEnv, annotationVars) : undefined;
    const bindingFfiObligations: FfiObligation[] = [];
    const t = annotated && b.value.kind === "Record"
      ? inferRecordExpr(
        b.value,
        typeEnv,
        (value) =>
          inferExpr(
            value,
            env,
            typeEnv,
            adts,
            types,
            warnings,
            diagnostics,
            provenance,
            bindingFfiObligations,
          ),
        annotated,
      )
      : inferExpr(
        b.value,
        env,
        typeEnv,
        adts,
        types,
        warnings,
        diagnostics,
        provenance,
        bindingFfiObligations,
      );
    ffiObligations.push(...bindingFfiObligations);
    if (annotated && dynamicFfiWithoutJsonAssert(b.value, env)) {
      throw new Error(
        "type annotations cannot cast dynamic JS/JSON values; use Json.assert for an explicit dynamic shape assertion",
      );
    }
    if (annotated) constrainAt(t, annotated, resultExpr(b.value));
    const bound = new Map<string, Ty>();
    inferBindingPattern(b.pattern, t, env, typeEnv, bound);
    const refutable = !isVectorExhaustive([[b.pattern]], [t], typeEnv, adts);
    return { bound, refutable, ffiObligations: bindingFfiObligations };
  } catch (error) {
    throw diagnosticError(error, b.node);
  }
}

function dynamicFfiWithoutJsonAssert(expr: Expr, env: Env): boolean {
  let hasDynamicFfi = false;
  let hasJsonAssert = false;
  const visit = (node: Expr) => {
    if (node.kind === "Call" && node.callee.kind === "Var") {
      if (node.callee.name === "Json.assert") hasJsonAssert = true;
      const scheme = env.get(node.callee.name);
      if (scheme?.jsImport && node.callee.name.includes("__dynamic")) hasDynamicFfi = true;
    }
    if (node.kind === "Pipe" && node.right.kind === "Var" && node.right.name === "Json.assert") {
      hasJsonAssert = true;
    }
    if (
      node.kind === "Pipe" && node.right.kind === "Call" && node.right.callee.kind === "Var" &&
      node.right.callee.name === "Json.assert"
    ) {
      hasJsonAssert = true;
    }
    switch (node.kind) {
      case "Tuple":
      case "JsonArray":
        node.items.forEach(visit);
        return;
      case "Record":
      case "JsonObject":
        node.fields.forEach((field) => visit(field.value));
        return;
      case "FfiGet":
        hasDynamicFfi = true;
        visit(node.receiver);
        return;
      case "FfiCall":
        hasDynamicFfi = true;
        visit(node.receiver);
        node.args.forEach(visit);
        return;
      case "Lambda":
        visit(node.body);
        return;
      case "Call":
        visit(node.callee);
        node.args.forEach(visit);
        return;
      case "If":
        visit(node.cond);
        visit(node.thenExpr);
        visit(node.elseExpr);
        return;
      case "Match":
        visit(node.value);
        node.arms.forEach((arm) => visit(arm.body));
        return;
      case "Panic":
        visit(node.message);
        return;
      case "Block":
        for (const item of node.items) {
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
        visit(node.result);
        return;
      case "Binary":
        visit(node.left);
        visit(node.right);
        return;
      case "Unary":
        visit(node.value);
        return;
      case "Pipe":
        visit(node.left);
        visit(node.right);
        return;
    }
  };
  visit(expr);
  return hasDynamicFfi && !hasJsonAssert;
}

export function constrainBinding(
  name: string,
  expected: Ty,
  actual: Ty,
  value: Expr,
  bindingNode: Binding["pattern"]["node"],
  types: Map<Expr, Ty>,
  provenance: TypeProvenance,
) {
  const expectedFn = prune(expected);
  const actualFn = prune(actual);
  if (value.kind === "Lambda" && expectedFn.tag === "fn" && actualFn.tag === "fn") {
    if (expectedFn.params.length === actualFn.params.length) {
      actualFn.params.forEach((param, i) =>
        constrainAt(
          expectedFn.params[i],
          param,
          value.params[i],
          () => `type mismatch ${quoteType(expectedFn.params[i])} vs ${quoteType(param)}`,
        )
      );
      const evidence = recursiveResultEvidence(name, value, expectedFn.result, types);
      const bodyResult = resultExpr(value.body);
      const accidentalMatchFn = findAccidentalMatchFnInFunction(value.body);
      const trailingStatementLikeResult = hasTrailingStatementLikeResult(value.body);
      const listElementVsListHint = recursiveListElementVsListHint(
        expectedFn.result,
        actualFn.result,
        bodyResult,
      );
      const actualResult = prune(actualFn.result);
      const resultProvenance = provenanceForType(expectedFn.result, provenance).map((item) => ({
        ...item,
        primary: false,
      }));
      const primaryCallee = resultProvenance.find((item) =>
        item.message === "call argument" &&
        item.expectedCallTupleShape !== undefined &&
        item.actualCallTupleShape !== undefined &&
        item.expectedCallTupleShape !== item.actualCallTupleShape
      ) ??
        resultProvenance.find((item) => item.message.startsWith(`callee ${name}:`)) ??
        resultProvenance.find((item) => item.message.startsWith("callee "));
      const prioritizedResultProvenance = primaryCallee
        ? resultProvenance.map((item) => item === primaryCallee ? { ...item, primary: true } : item)
        : resultProvenance;
      const related = [
        {
          message: `body: ${show(actualFn.result)}`,
          node: bodyResult.node,
          span: bodyResult.node?.span,
        },
        ...(listElementVsListHint ? [listElementVsListHint] : []),
        ...(accidentalMatchFn
          ? [{
            message:
              "HINT: found `match(...) => { ... }` inside function body; did you mean `match(...) { ... }`?",
            node: accidentalMatchFn.node,
            span: accidentalMatchFn.node?.span,
          }]
          : []),
        ...((actualResult.tag === "prim" && actualResult.name === "Void" &&
            trailingStatementLikeResult)
          ? [{
            message: "HINT: returns Void; remove trailing `;` on last expression",
            node: bodyResult.node,
            span: bodyResult.node?.span,
          }]
          : []),
        ...(evidence.length > 0
          ? [{
            message: "rec: occurrences share one monomorphic type",
            node: bindingNode,
            span: bindingNode?.span,
          }]
          : []),
        ...expressionTypeEvidence(value, expectedFn.result, types),
        ...prioritizedResultProvenance,
        ...evidence.slice(1).map((item) => item.related),
      ];
      constrainAt(
        expectedFn.result,
        actualFn.result,
        evidence[0]?.expr ?? bodyResult,
        () => `type mismatch ${quoteType(expectedFn.result)} vs ${quoteType(actualFn.result)}`,
        related,
      );
      return;
    }
  }
  constrainAt(expected, actual, resultExpr(value));
}

function recursiveListElementVsListHint(expected: Ty, actual: Ty, expr: Expr) {
  const expectedTy = prune(expected);
  const actualTy = prune(actual);
  if (
    (expectedTy.tag === "var" && actualTy.tag === "named" && actualTy.name === "List") ||
    (actualTy.tag === "var" && expectedTy.tag === "named" && expectedTy.name === "List")
  ) {
    return {
      message: "HINT: list element vs List; use `..` to splice a tail list",
      node: expr.node,
      span: expr.node?.span,
    };
  }
  return undefined;
}
