import type { Expr, Module } from "./ast.ts";
import {
  type CoreProgram,
  coreProgramFromAnalysis,
  coreProgramFromModule,
} from "./core/artifact.ts";
import { emitCoreProgram } from "./core/emit_js.ts";
import { coreFromSurface } from "./core/from_surface.ts";
import { resolveDelayedFfiElaboration } from "./ffi/delayed/delayed.ts";
import { prepareFfiElaboration } from "./ffi/elab.ts";
import { inferModule, inferModuleWithSteps, type InferResult, type InferStep } from "./infer.ts";
import {
  loadModuleGraph,
  type ModuleGraph,
  type ModuleGraphOptions,
  type VirtualFileSystem,
} from "./module_graph.ts";
import { parse, type Surface } from "./parser.ts";
import { prune, show, type Ty } from "./types.ts";

export type CompileOptions = ModuleGraphOptions;

export type VirtualCompileOptions = CompileOptions & {
  virtualFs: VirtualFileSystem;
};

export async function compile(
  source: string,
  options: CompileOptions = {},
  filePath?: string,
): Promise<string> {
  const { module: ast, result } = checkPreparedModuleWithoutImports(
    await parse(source, options.surface, filePath),
  );
  return emitCoreProgram(coreProgramFromModule(ast, result));
}

export type CheckSourceOptions = { surface?: Surface };
export type CoreSourceResult = { module: ReturnType<typeof coreFromSurface>; result: InferResult };
export type CoreFileResult = {
  graph: ModuleGraph;
  results: Map<string, InferResult>;
  core: CoreProgram;
};

export class ModuleAnalysisError extends Error {
  path: string;
  source: string;
  originalError: unknown;

  constructor(path: string, source: string, originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = "ModuleAnalysisError";
    this.path = path;
    this.source = source;
    this.originalError = originalError;
  }
}

export async function checkSource(
  source: string,
  options: CheckSourceOptions = {},
  filePath?: string,
): Promise<InferResult> {
  return checkPreparedModuleWithoutImports(await parse(source, options.surface, filePath)).result;
}

export async function coreSource(
  source: string,
  options: CheckSourceOptions = {},
  filePath?: string,
): Promise<CoreSourceResult> {
  const { module, result } = checkPreparedModuleWithoutImports(
    await parse(source, options.surface, filePath),
  );
  return { module: coreFromSurface(module), result };
}

export async function checkSourceSteps(
  source: string,
  options: CheckSourceOptions = {},
  filePath?: string,
): Promise<InferStep[]> {
  const module = prepareFfiElaboration(await parse(source, options.surface, filePath)).module;
  if (module.decls.some((decl) => decl.kind === "ImportDecl")) {
    throw new Error("source strings with imports require checkFile");
  }
  return inferModuleWithSteps(module).steps;
}

export async function compileFile(input: string, options: CompileOptions = {}): Promise<string> {
  return emitCoreProgram((await coreFile(input, options)).core);
}

export async function checkFile(input: string): Promise<Map<string, InferResult>> {
  return (await analyzeFile(input)).results;
}

export async function coreFile(
  input: string,
  options: ModuleGraphOptions = {},
): Promise<CoreFileResult> {
  const { graph, results } = await analyzeFile(input, options);
  return { graph, results, core: coreProgramFromAnalysis(graph, results) };
}

export async function analyzeFile(
  input: string,
  options: ModuleGraphOptions = {},
): Promise<{ graph: ModuleGraph; results: Map<string, InferResult> }> {
  const graph = await loadModuleGraph(input, options);
  const ffi = new Map<string, ReturnType<typeof prepareFfiElaboration>>();
  for (const node of graph.nodes.values()) {
    const prepared = prepareFfiElaboration(node.module);
    ffi.set(node.path, prepared);
    node.module = prepared.module;
  }
  const results = new Map<string, InferResult>();
  const firstResults = new Map<string, InferResult>();
  for (const path of graph.order) {
    const node = graph.nodes.get(path)!;
    const imports = new Map<string, InferResult>();
    for (const edge of node.imports) {
      imports.set(edge.specifier, firstResults.get(edge.path)!);
    }
    try {
      firstResults.set(path, inferModule(node.module, imports));
    } catch (error) {
      throw new ModuleAnalysisError(path, node.source, error);
    }
  }
  const receiverOverrides = delayedReceiverOverrides(graph, firstResults);
  const foreignTypeRefs = new Map(
    [...ffi.values()].flatMap((item) =>
      [...item.foreignTypeRefs.values()].map((ref) => [ref.key, ref])
    ),
  );
  for (const path of graph.order) {
    const node = graph.nodes.get(path)!;
    try {
      const prepared = ffi.get(path)!;
      const resolved = resolveDelayedFfiElaboration(prepared, firstResults.get(path)!, {
        receiverTypes: receiverOverrides.get(path),
        foreignTypeRefs,
      });
      node.module = resolved.module;
    } catch (error) {
      throw new ModuleAnalysisError(path, node.source, error);
    }
  }
  for (const path of graph.order) {
    const node = graph.nodes.get(path)!;
    const imports = new Map<string, InferResult>();
    for (const edge of node.imports) {
      imports.set(edge.specifier, results.get(edge.path)!);
    }
    try {
      results.set(path, inferModule(node.module, imports));
    } catch (error) {
      throw new ModuleAnalysisError(path, node.source, error);
    }
  }
  return { graph, results };
}

function delayedReceiverOverrides(
  graph: ModuleGraph,
  results: Map<string, InferResult>,
): Map<string, Map<Expr, Ty>> {
  const sourceOwners = new Map<Expr, string>();
  for (const node of graph.nodes.values()) {
    collectFfiGetSources(node.module, (expr) => sourceOwners.set(expr, node.path));
  }
  const overrides = new Map<string, Map<Expr, Ty>>();
  for (const result of results.values()) {
    for (const obligation of result.ffiObligations) {
      const path = sourceOwners.get(obligation.source);
      if (!path) continue;
      const receiver = prune(obligation.receiver);
      const moduleOverrides = overrides.get(path) ?? new Map<Expr, Ty>();
      const existing = moduleOverrides.get(obligation.source);
      if (existing && show(prune(existing)) !== show(receiver)) {
        if (isUnresolvedTypeVar(receiver)) {
          continue;
        }
        if (isUnresolvedTypeVar(existing)) {
          moduleOverrides.set(obligation.source, receiver);
          overrides.set(path, moduleOverrides);
          continue;
        }
        throw new Error(
          `conflicting JS FFI receiver types for ${obligation.path.join(".")}: ${
            show(prune(existing))
          } vs ${show(receiver)}`,
        );
      }
      moduleOverrides.set(obligation.source, receiver);
      overrides.set(path, moduleOverrides);
    }
  }
  return overrides;
}

function isUnresolvedTypeVar(type: Ty): boolean {
  return prune(type).tag === "var";
}

function collectFfiGetSources(
  module: Module,
  visit: (expr: Extract<Expr, { kind: "FfiGet" | "FfiCall" }>) => void,
) {
  for (const decl of module.decls) {
    if (decl.kind === "LetDecl") {
      for (const binding of decl.bindings) collectFfiGetExprs(binding.value, visit);
    }
  }
}

function collectFfiGetExprs(
  expr: Expr,
  visit: (expr: Extract<Expr, { kind: "FfiGet" | "FfiCall" }>) => void,
) {
  if (expr.kind === "FfiGet") {
    visit(expr);
    collectFfiGetExprs(expr.receiver, visit);
    return;
  }
  if (expr.kind === "FfiCall") {
    visit(expr);
    collectFfiGetExprs(expr.receiver, visit);
    expr.args.forEach((arg) => collectFfiGetExprs(arg, visit));
    return;
  }
  switch (expr.kind) {
    case "Tuple":
    case "JsonArray":
      expr.items.forEach((item) => collectFfiGetExprs(item, visit));
      return;
    case "Record":
    case "JsonObject":
      expr.fields.forEach((field) => collectFfiGetExprs(field.value, visit));
      return;
    case "Lambda":
      collectFfiGetExprs(expr.body, visit);
      return;
    case "Call":
      collectFfiGetExprs(expr.callee, visit);
      expr.args.forEach((arg) => collectFfiGetExprs(arg, visit));
      return;
    case "If":
      collectFfiGetExprs(expr.cond, visit);
      collectFfiGetExprs(expr.thenExpr, visit);
      collectFfiGetExprs(expr.elseExpr, visit);
      return;
    case "Match":
      collectFfiGetExprs(expr.value, visit);
      expr.arms.forEach((arm) => collectFfiGetExprs(arm.body, visit));
      return;
    case "Panic":
      collectFfiGetExprs(expr.message, visit);
      return;
    case "Block":
      for (const item of expr.items) {
        if (item.kind === "LetDecl") {
          item.bindings.forEach((binding) => collectFfiGetExprs(binding.value, visit));
        } else if (
          item.kind !== "ImportDecl" && item.kind !== "JsImportDecl" &&
          item.kind !== "ForeignTypeDecl" && item.kind !== "RecordDecl" && item.kind !== "TypeDecl"
        ) {
          collectFfiGetExprs(item, visit);
        }
      }
      collectFfiGetExprs(expr.result, visit);
      return;
    case "Binary":
      collectFfiGetExprs(expr.left, visit);
      collectFfiGetExprs(expr.right, visit);
      return;
    case "Unary":
      collectFfiGetExprs(expr.value, visit);
      return;
    case "Pipe":
      collectFfiGetExprs(expr.left, visit);
      collectFfiGetExprs(expr.right, visit);
      return;
  }
}

function checkPreparedModuleWithoutImports(
  module: Module,
): { module: Module; result: InferResult } {
  const prepared = prepareFfiElaboration(module);
  const first = checkModuleWithoutImports(prepared.module);
  const resolved = resolveDelayedFfiElaboration(prepared, first);
  return { module: resolved.module, result: checkModuleWithoutImports(resolved.module) };
}

function checkModuleWithoutImports(module: Module): InferResult {
  if (module.decls.some((decl) => decl.kind === "ImportDecl")) {
    throw new Error("source strings with imports require checkFile");
  }
  return inferModule(module);
}

export async function compileVirtual(
  entryPath: string,
  virtualFs: VirtualFileSystem,
  options: Omit<CompileOptions, "virtualFs"> = {},
): Promise<string> {
  return emitCoreProgram((await coreVirtual(entryPath, virtualFs, options)).core);
}

export async function checkVirtual(
  entryPath: string,
  virtualFs: VirtualFileSystem,
  options: Omit<CompileOptions, "virtualFs"> = {},
): Promise<Map<string, InferResult>> {
  return (await analyzeVirtual(entryPath, virtualFs, options)).results;
}

export async function coreVirtual(
  entryPath: string,
  virtualFs: VirtualFileSystem,
  options: Omit<CompileOptions, "virtualFs"> = {},
): Promise<CoreFileResult> {
  const { graph, results } = await analyzeVirtual(entryPath, virtualFs, options);
  return { graph, results, core: coreProgramFromAnalysis(graph, results) };
}

export async function analyzeVirtual(
  entryPath: string,
  virtualFs: VirtualFileSystem,
  options: Omit<CompileOptions, "virtualFs"> = {},
): Promise<{ graph: ModuleGraph; results: Map<string, InferResult> }> {
  return analyzeFile(entryPath, { ...options, virtualFs });
}
