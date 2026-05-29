import ts from "typescript";
import type { TypeExpr } from "./ast.ts";

export type JsMemberType = {
  name: string;
  type: TypeExpr;
};

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  skipLibCheck: true,
};

const memberCache = new Map<string, JsMemberType | undefined>();
const namespaceCache = new Map<string, JsMemberType[]>();
const nodeTypesPath = new URL(import.meta.resolve("npm:@types/node/index.d.ts")).pathname;

export function jsGlobalMembers(path: string): JsMemberType[] {
  const cached = namespaceCache.get(path);
  if (cached) return cached;
  const reflected = reflectSource(
    path,
    `const __wm_target = ${path};`,
    (checker, sourceFile) => {
      const target = findVariable(sourceFile, "__wm_target")?.initializer;
      if (!target) return [];
      const members: JsMemberType[] = [];
      for (const symbol of checker.getTypeAtLocation(target).getProperties()) {
        const type = typeOfSymbol(checker, symbol);
        const mapped = type ? typeExprFromTsType(checker, type) : undefined;
        if (mapped?.kind === "TFn") members.push({ name: symbol.getName(), type: mapped });
      }
      return members;
    },
  );
  namespaceCache.set(path, reflected);
  return reflected;
}

export function jsGlobalMember(path: string, name: string): JsMemberType | undefined {
  return jsTargetMember(jsGlobalSource(path), name);
}

export function jsModuleMembers(specifier: string): JsMemberType[] {
  const target = jsModuleSource(specifier);
  const cached = namespaceCache.get(target.key);
  if (cached) return cached;
  const reflected = reflectSource(
    target.key,
    target.source,
    (checker, sourceFile) => {
      const target = findVariable(sourceFile, "__wm_target")?.initializer;
      if (!target) return [];
      const members: JsMemberType[] = [];
      for (const symbol of checker.getTypeAtLocation(target).getProperties()) {
        const type = typeOfSymbol(checker, symbol);
        const mapped = type ? typeExprFromTsType(checker, type) : undefined;
        if (mapped?.kind === "TFn") members.push({ name: symbol.getName(), type: mapped });
      }
      return members;
    },
  );
  namespaceCache.set(target.key, reflected);
  return reflected;
}

export function jsModuleMember(specifier: string, name: string): JsMemberType | undefined {
  return jsTargetMember(jsModuleSource(specifier), name);
}

function jsTargetMember(target: JsReflectionSource, name: string): JsMemberType | undefined {
  const key = `${target.key}.${name}`;
  if (memberCache.has(key)) return memberCache.get(key);
  const reflected = reflectSource(
    key,
    `${target.source}\nconst __wm_member = __wm_target.${name};`,
    (checker, sourceFile) => {
      const member = findVariable(sourceFile, "__wm_member")?.initializer;
      if (!member) return undefined;
      const mapped = typeExprFromTsType(checker, checker.getTypeAtLocation(member));
      return mapped ? { name, type: mapped } : undefined;
    },
  );
  memberCache.set(key, reflected);
  return reflected;
}

type JsReflectionSource = { key: string; source: string };

function jsGlobalSource(path: string): JsReflectionSource {
  return { key: `global:${path}`, source: `const __wm_target = ${path};` };
}

function jsModuleSource(specifier: string): JsReflectionSource {
  return {
    key: `module:${specifier}`,
    source: `/// <reference path="${nodeTypesPath}" />\nimport * as __wm_target from ${
      JSON.stringify(specifier)
    };`,
  };
}

function reflectSource<T>(
  label: string,
  source: string,
  read: (
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
  ) => T,
): T {
  const fileName = `/__wm_js_reflect_${sanitize(label)}.ts`;
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : originalGetSourceFile.call(
        host,
        name,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
  const program = ts.createProgram([fileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`cannot reflect JS target ${label}`);
  return read(program.getTypeChecker(), sourceFile);
}

function findVariable(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function typeOfSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | undefined {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : undefined;
}

function typeExprFromTsType(checker: ts.TypeChecker, type: ts.Type): TypeExpr | undefined {
  const signature = type.getCallSignatures()[0];
  if (signature) return functionTypeFromSignature(checker, signature);
  if (isTsType(checker, type, "number")) return name("Number");
  if (isTsType(checker, type, "string")) return name("String");
  if (isTsType(checker, type, "boolean")) return name("Bool");
  if (type.flags & ts.TypeFlags.Void) return name("Void");
  return name("Js.Value");
}

function functionTypeFromSignature(checker: ts.TypeChecker, signature: ts.Signature): TypeExpr {
  const declaration = signature.getDeclaration();
  const parameters = signature.getParameters().flatMap((symbol, index) => {
    const declarationParam = declaration?.parameters[index];
    if (declarationParam?.questionToken || declarationParam?.initializer) return [];
    const type = typeOfSymbol(checker, symbol) ?? checker.getAnyType();
    if (declarationParam?.dotDotDotToken) {
      const element = restElementType(checker, type) ?? checker.getAnyType();
      if (isAnyOrUnknown(element)) return [varType("a")];
      const mapped = typeExprFromTsType(checker, element) ?? name("Js.Value");
      return [mapped, mapped];
    }
    const mapped = typeExprFromTsType(checker, type) ?? name("Js.Value");
    return [mapped];
  });
  const result = typeExprFromTsType(checker, checker.getReturnTypeOfSignature(signature)) ??
    name("Js.Value");
  return fn(parameters, result);
}

function restElementType(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const ref = type as ts.TypeReference;
  if (ref.typeArguments?.length === 1) return ref.typeArguments[0];
  const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return numberIndex;
}

function isTsType(checker: ts.TypeChecker, type: ts.Type, expected: string): boolean {
  return checker.typeToString(type) === expected;
}

function isAnyOrUnknown(type: ts.Type): boolean {
  return !!(type.flags & ts.TypeFlags.Any) || !!(type.flags & ts.TypeFlags.Unknown);
}

function name(name: string): TypeExpr {
  return { kind: "TName", name, args: [] };
}

function varType(name: string): TypeExpr {
  return { kind: "TVar", name };
}

function fn(params: TypeExpr[], result: TypeExpr): TypeExpr {
  return { kind: "TFn", params, result };
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_]/g, "_");
}
