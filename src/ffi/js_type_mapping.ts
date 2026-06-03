import ts from "typescript";
import type { TypeExpr } from "../ast.ts";
import { typeOfSymbol } from "./js_reflect_host.ts";
import type {
  JsCallableVariant,
  JsCallArgHint,
  JsCallbackParamRefs,
  JsMemberType,
  JsTypeRef,
} from "./js_types.ts";
import { fn, name, option, varType } from "./type_expr.ts";

const maxReflectedRestArity = 8;

export function jsMemberTypeFromTsType(
  checker: ts.TypeChecker,
  type: ts.Type,
  resultRef?: (index: number, signature: ts.Signature) => JsTypeRef | undefined,
  callbackParamRef?: (
    signatureIndex: number,
    paramIndex: number,
    callbackParamIndex: number,
    callbackParamType: ts.Type,
    signature: ts.Signature,
  ) => JsTypeRef | undefined,
): Omit<JsMemberType, "name"> | undefined {
  const variants = dedupeVariants(
    type.getCallSignatures().flatMap((signature, index) =>
      functionVariantsFromSignature(
        checker,
        signature,
        (paramIndex, callbackParamIndex, callbackParamType) =>
          callbackParamRef?.(index, paramIndex, callbackParamIndex, callbackParamType, signature),
      ).map((variant) => ({
        ...variant,
        resultRef: resultRef?.(index, signature),
      }))
    ),
  );
  const overloads = variants.map((variant) => variant.type);
  if (variants.length === 0) return undefined;
  return {
    type: variants[0].type,
    overloads: overloads.length > 1 ? overloads : undefined,
    variants,
  };
}

export function typeExprFromTsType(
  checker: ts.TypeChecker,
  type: ts.Type,
  position: "param" | "result" = "result",
): TypeExpr | undefined {
  if (
    position === "param" && /\b(BodyInit|XMLHttpRequestBodyInit)\b/.test(checker.typeToString(type))
  ) {
    return name("String");
  }
  const nullish = nullishUnionParts(type);
  if (nullish) {
    const inner = nullish.value
      ? (typeExprFromTsType(checker, nullish.value, position) ?? name("Js.Value"))
      : name("Js.Value");
    return option(inner);
  }
  if (type.isUnion()) {
    if (position === "param" && type.types.some(isStringLike)) return name("String");
    if (type.types.some(isObjectLike)) {
      if (position === "result" && type.types.every(isObjectLike)) return name("Js.Object");
      return position === "param" && type.types.some(isStringLike) && type.types
          .filter(isObjectLike)
          .every((item) => checker.typeToString(item) === "URL")
        ? name("String")
        : name("Js.Value");
    }
    if (type.types.some(isStringLike)) return name("String");
    const mapped = type.types.map((item) => typeExprFromTsType(checker, item, position));
    if (mapped.some((item) => item?.kind === "TName" && item.name === "Js.Value")) {
      return name("Js.Value");
    }
    if (mapped.some((item) => item?.kind === "TName" && item.name === "String")) {
      return name("String");
    }
  }
  const signature = type.getCallSignatures()[0];
  if (signature) return functionTypeFromSignature(checker, signature);
  if (isTsType(checker, type, "number")) return name("Number");
  if (isTsType(checker, type, "string")) return name("String");
  if (isTsType(checker, type, "boolean")) return name("Bool");
  if (type.flags & ts.TypeFlags.StringLiteral) return name("String");
  if (type.flags & ts.TypeFlags.NumberLiteral) return name("Number");
  if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return name("Void");
  if (position === "result" && isObjectLike(type)) return name("Js.Object");
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint) {
      return typeExprFromTsType(checker, constraint, position) ?? name("Js.Value");
    }
  }
  return name("Js.Value");
}

function nullishUnionParts(type: ts.Type): { value?: ts.Type } | undefined {
  if (!type.isUnion()) return undefined;
  const valueTypes = type.types.filter((item) => !isNullish(item));
  if (valueTypes.length === type.types.length) return undefined;
  if (valueTypes.length === 0) return {};
  if (valueTypes.length === 1) return { value: valueTypes[0] };
  return {};
}

function isNullish(type: ts.Type): boolean {
  return !!(type.flags & ts.TypeFlags.Null) || !!(type.flags & ts.TypeFlags.Undefined);
}

function functionTypeFromSignature(checker: ts.TypeChecker, signature: ts.Signature): TypeExpr {
  return functionVariantsFromSignature(checker, signature)[0].type;
}

export function functionVariantsFromSignature(
  checker: ts.TypeChecker,
  signature: ts.Signature,
  callbackParamRef?: (
    paramIndex: number,
    callbackParamIndex: number,
    callbackParamType: ts.Type,
  ) => JsTypeRef | undefined,
): JsCallableVariant[] {
  const declaration = signature.getDeclaration();
  type ReflectedParam = {
    type: TypeExpr;
    optional: boolean;
    rest: boolean;
    callbackRefs?: JsTypeRef[];
  };
  const parameters: ReflectedParam[] = signature
    .getParameters()
    .flatMap((symbol, index): ReflectedParam[] => {
      const declarationParam = declaration?.parameters[index];
      const type = typeOfSymbol(checker, symbol) ?? checker.getAnyType();
      if (declarationParam?.dotDotDotToken) {
        const element = restElementType(checker, type) ?? checker.getAnyType();
        const mapped = paramTypeExpr(checker, element, index);
        return [{
          type: mapped,
          optional: false,
          rest: true,
          callbackRefs: callbackRefsForParam(checker, element, index, callbackParamRef),
        }];
      }
      const optional = !!declarationParam?.questionToken || !!declarationParam?.initializer;
      const mapped = stripOptionForOptional(paramTypeExpr(checker, type, index), optional);
      return [{
        type: mapped,
        optional,
        rest: false,
        callbackRefs: callbackRefsForParam(checker, type, index, callbackParamRef),
      }];
    });
  const result = typeExprFromTsType(checker, checker.getReturnTypeOfSignature(signature)) ??
    name("Js.Value");
  const restIndex = parameters.findIndex((param) => param.rest);
  if (restIndex !== -1) {
    const fixed = parameters.slice(0, restIndex);
    const required = lastRequiredParameter(fixed) + 1;
    const overloads: JsCallableVariant[] = [];
    for (let count = required; count <= maxReflectedRestArity; count++) {
      const params: TypeExpr[] = [];
      for (let index = 0; index < Math.min(count, fixed.length); index++) {
        params.push(fixed[index].type);
      }
      for (let index = params.length; index < count; index++) {
        params.push(restSlotType(parameters[restIndex].type, index));
      }
      overloads.push({
        type: fn(params, result),
        callbackParamRefs: callbackParamRefsForArity(parameters, count),
      });
    }
    return overloads;
  }
  const required = lastRequiredParameter(parameters) + 1;
  const overloads: JsCallableVariant[] = [];
  for (let count = required; count <= parameters.length; count++) {
    overloads.push({
      type: fn(parameters.slice(0, count).map((param) => param.type), result),
      callbackParamRefs: callbackParamRefsForArity(parameters, count),
    });
  }
  return overloads.length ? overloads : [{ type: fn([], result) }];
}

function callbackRefsForParam(
  checker: ts.TypeChecker,
  type: ts.Type,
  paramIndex: number,
  callbackParamRef:
    | ((
      paramIndex: number,
      callbackParamIndex: number,
      callbackParamType: ts.Type,
    ) => JsTypeRef | undefined)
    | undefined,
): JsTypeRef[] | undefined {
  const signature = type.getCallSignatures()[0];
  if (!signature) return undefined;
  return signature.getParameters()
    .map((symbol, callbackParamIndex) => {
      const paramType = typeOfSymbol(checker, symbol) ?? checker.getAnyType();
      return callbackParamRef?.(paramIndex, callbackParamIndex, paramType);
    })
    .filter((ref): ref is JsTypeRef => !!ref);
}

function callbackParamRefsForArity(
  parameters: { callbackRefs?: JsTypeRef[] }[],
  arity: number,
): JsCallbackParamRefs[] | undefined {
  const refs = parameters.slice(0, arity)
    .map((param, argIndex) =>
      param.callbackRefs?.length ? { argIndex, params: param.callbackRefs } : undefined
    )
    .filter((item): item is JsCallbackParamRefs => !!item);
  return refs.length ? refs : undefined;
}

export function callbackParamRefsFromCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  args: JsCallArgHint[],
  typeRefFromTsType: (key: string, checker: ts.TypeChecker, type: ts.Type) => JsTypeRef,
): JsCallbackParamRefs[] | undefined {
  const refs = call.arguments.map((arg, argIndex) => {
    if (args[argIndex]?.kind !== "function" || !ts.isArrowFunction(arg)) return undefined;
    const params = arg.parameters.map((param, callbackParamIndex) => {
      const key = `call:${call.getStart()}:callback:${argIndex}:${callbackParamIndex}`;
      return typeRefFromTsType(key, checker, checker.getTypeAtLocation(param));
    });
    return params.length ? { argIndex, params } : undefined;
  }).filter((item): item is JsCallbackParamRefs => !!item);
  return refs.length ? refs : undefined;
}

function paramTypeExpr(checker: ts.TypeChecker, type: ts.Type, index: number): TypeExpr {
  if (isAnyOrUnknown(type)) return varType(`a${index}`);
  const signature = type.getCallSignatures()[0];
  if (signature && signatureHasRest(signature)) {
    return fn(
      [name("Js.Value")],
      typeExprFromTsType(checker, checker.getReturnTypeOfSignature(signature)) ?? name("Void"),
    );
  }
  if (signature) return callbackFunctionTypeFromSignature(checker, signature);
  return typeExprFromTsType(checker, type, "param") ?? name("Js.Value");
}

function callbackFunctionTypeFromSignature(
  checker: ts.TypeChecker,
  signature: ts.Signature,
): TypeExpr {
  const params = signature.getParameters().map((symbol, index) => {
    const type = typeOfSymbol(checker, symbol) ?? checker.getAnyType();
    return callbackParamTypeExpr(checker, type, index);
  });
  const result = typeExprFromTsType(checker, checker.getReturnTypeOfSignature(signature)) ??
    name("Void");
  return fn(params, result);
}

function callbackParamTypeExpr(checker: ts.TypeChecker, type: ts.Type, index: number): TypeExpr {
  if (isAnyOrUnknown(type)) return varType(`a${index}`);
  if (isObjectLike(type)) return name("Js.Object");
  return typeExprFromTsType(checker, type, "param") ?? name("Js.Value");
}

function restSlotType(type: TypeExpr, index: number): TypeExpr {
  return type.kind === "TVar" ? varType(`a${index}`) : type;
}

function stripOptionForOptional(type: TypeExpr, optional: boolean): TypeExpr {
  return optional && type.kind === "TName" && type.name === "Option" && type.args.length === 1
    ? type.args[0]
    : type;
}

function lastRequiredParameter(parameters: { optional: boolean }[]): number {
  for (let i = parameters.length - 1; i >= 0; i--) {
    if (!parameters[i].optional) return i;
  }
  return -1;
}

export function dedupeVariants(variants: JsCallableVariant[]): JsCallableVariant[] {
  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = typeKey(variant.type);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function restElementType(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const ref = type as ts.TypeReference;
  if (ref.typeArguments?.length === 1) return ref.typeArguments[0];
  return checker.getIndexTypeOfType(type, ts.IndexKind.Number);
}

function isTsType(checker: ts.TypeChecker, type: ts.Type, expected: string): boolean {
  return checker.typeToString(type) === expected;
}

function isAnyOrUnknown(type: ts.Type): boolean {
  return !!(type.flags & ts.TypeFlags.Any) || !!(type.flags & ts.TypeFlags.Unknown);
}

function signatureHasRest(signature: ts.Signature): boolean {
  return !!signature.getDeclaration()?.parameters.some((param) => !!param.dotDotDotToken);
}

function isObjectLike(type: ts.Type): boolean {
  return !!(type.flags & ts.TypeFlags.Object);
}

function isStringLike(type: ts.Type): boolean {
  return !!(type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral));
}
