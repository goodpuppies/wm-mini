import type { Module } from "./ast.ts";
import { emitBundle, emitModule } from "./emit.ts";
import { inferModule, inferModuleWithSteps, type InferResult, type InferStep } from "./infer.ts";
import { loadModuleGraph, type ModuleGraph, type ModuleGraphOptions } from "./module_graph.ts";
import { parse, type Surface } from "./parser.ts";

export type CompileOptions = { check?: boolean; surface?: Surface };

export async function compile(source: string, options: CompileOptions = {}): Promise<string> {
  const ast = await parse(source, options.surface);
  if (options.check ?? true) checkModuleWithoutImports(ast);
  return emitModule(ast);
}

export type CheckSourceOptions = { surface?: Surface };

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
): Promise<InferResult> {
  return checkModuleWithoutImports(await parse(source, options.surface));
}

export async function checkSourceSteps(
  source: string,
  options: CheckSourceOptions = {},
): Promise<InferStep[]> {
  const module = await parse(source, options.surface);
  if (module.decls.some((decl) => decl.kind === "ImportDecl")) {
    throw new Error("source strings with imports require checkFile");
  }
  return inferModuleWithSteps(module).steps;
}

export async function compileFile(input: string, options: CompileOptions = {}): Promise<string> {
  const { graph } = await analyzeFile(input, options);
  const entry = graph.nodes.get(graph.entry)!.module;
  if (!(options.check ?? true)) return emitModule(entry);
  const importedUnits = graph.order
    .filter((path) => path !== graph.entry)
    .map((path) => {
      const node = graph.nodes.get(path)!;
      return { name: node.emitName, module: node.module };
    });
  return emitBundle(importedUnits, entry);
}

export async function checkFile(input: string): Promise<Map<string, InferResult>> {
  return (await analyzeFile(input)).results;
}

export async function analyzeFile(
  input: string,
  options: ModuleGraphOptions = {},
): Promise<{ graph: ModuleGraph; results: Map<string, InferResult> }> {
  const graph = await loadModuleGraph(input, options);
  const results = new Map<string, InferResult>();
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

function checkModuleWithoutImports(module: Module): InferResult {
  if (module.decls.some((decl) => decl.kind === "ImportDecl")) {
    throw new Error("source strings with imports require checkFile");
  }
  return inferModule(module);
}
