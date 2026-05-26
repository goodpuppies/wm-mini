# Frontend Diagnostics Design

This note compares the Workman and workmangr span/error models and records the wm-mini direction for
the VS Code/LSP prerequisites.

## What Workman Tried

Workman v0 gives ordinary AST nodes a `SourceSpan` and `NodeId`.

- `SourceSpan` stores byte offsets and, when source text is available, line/column positions.
- Parser helpers construct spans from token offsets.
- Inference errors can carry an optional span.
- The later Hazel-inspired plan adds a separate marked AST that mirrors the normal AST and adds mark
  nodes such as free variable, inconsistent types, non-function application, and unfillable hole.
- The stated reason for node ids is constraint tracing: later phases can connect type information,
  diagnostics, and hovers back to stable syntax nodes.

That model is useful, but it is not just "spans". It is a multi-phase typing architecture:

1. Parser produces ordinary syntax with ids and spans.
2. Layer 1 becomes total and returns a marked AST instead of throwing type errors.
3. Holes/marks get unknown types with provenance.
4. Layer 2 solves constraints and produces normalized diagnostics.
5. Presentation/LSP consumes diagnostics and node views.

## What workmangr Tried

workmangr makes the total/recovering model explicit in the core AST design.

- Every syntax node has `Node { id, span }`.
- `Span` stores `line`, `col`, `start`, and `end`.
- The surface AST has real `Hole` and `Mark` variants for missing expressions, missing patterns,
  missing type expressions, missing blocks, missing tokens, unexpected tokens, and formatting
  repairs.
- Parser recovery creates synthetic holes or synthetic tokens, records marked diagnostics, and keeps
  returning an AST.
- Lowering preserves node ids and spans while translating surface AST to core AST.
- Core AST also has mark variants for type-facing issues like free variables, inconsistent types,
  unsupported expressions, pattern errors, and unknown type expressions.
- Diagnostics are structured values with stage, severity, message, span, and clues.

This is powerful because the editor can keep presenting a program even while it is broken. The cost
is that the whole frontend must become total: parser, lowering, inference, diagnostics, and later
queries all need to understand holes and marks.

## wm-mini Recommendation

wm-mini should adopt a recovery-capable AST now, but not the full Hazel/workmangr type system.

The corrected split is:

- Parser recovery and error nodes are the core editor feature.
- A fully marked type system with provenance holes and solver-level unfillable-hole reasoning is a
  later research feature.

This is different from a plain "spans plus diagnostics" plan. If wm-mini only adds diagnostics as a
side channel, then later parser recovery would require reshaping the AST, parser, inference, tests,
and LSP queries. Workman v0 already shows that retrofitting a parallel marked AST can become
expensive. workmangr shows that integrating nodes, spans, holes, marks, diagnostics, and lowering
from the start reduces later impedance.

wm-mini is small enough that the recovery-capable AST should be affordable if it is scoped to the
language we actually support.

## SML Definition Check

The SML Definition separates three phases: parsing, elaboration, and evaluation. Parsing determines
grammatical form; elaboration determines whether the phrase is well typed and well formed;
evaluation runs it.

The important point for wm-mini is in the Programs section: the Definition says an implementation
attempts to parse, elaborate, and evaluate a top-level phrase, but then explicitly leaves
parse-error handling to implementers because it depends on the parser being used. Execution, in that
section, is defined as the combined elaboration and evaluation after parsing.

So parser repair such as "inserted missing `end`" or "inserted missing `=`" is not a semantic
requirement of SML 97. It is an implementation/editor behavior that SML tools commonly provide.

The Definition does require or strongly specify non-fatal reporting for some well-parsed but
problematic phrases. In particular, match redundancy and exhaustiveness are diagnostics that should
be reported while the match still compiles. This is different from parser recovery: the phrase is
already grammatically valid, but elaboration/dynamic behavior carries warnings.

For wm-mini this means:

- SML rigor requires clear grammar acceptance/rejection and correct elaboration behavior.
- SML rigor supports warnings for non-exhaustive/redundant matches without rejecting the module.
- SML rigor does not force Hazel-style parser recovery or error nodes.
- Parser recovery is still a good LSP goal and should be part of the wm-mini frontend architecture,
  but it should be treated as an editor-quality implementation feature, not as part of the SML
  subset semantics.

## Modules, Files, And Project Analysis

The SML Definition gives wm-mini a semantic frame, but not a workspace/project system.

SML defines programs as sequences of top-level declarations. Elaboration happens relative to a
current basis. A successful top-level declaration extends the basis; a failed elaboration has no
effect. The Definition also notes that implementations may provide directives for including programs
from files, but leaves the effect of file inclusion and batch behavior to implementers.

So SML does not define:

- Workspace roots.
- File discovery.
- Import specifier resolution.
- Cross-file diagnostic scheduling.
- Unsaved editor buffers.
- Whether a file inclusion failure aborts an entire batch.
- LSP diagnostic publishing.

The closest SML idea is separate compilation: a compilation unit can be checked if the external
static basis it depends on is available. For wm-mini, the equivalent is explicit file imports and
per-file exported static bases.

wm-mini already has the right semantic skeleton:

- Each `.wm` file is an implicit module/structure.
- Imports are explicit dependency edges.
- Dependencies are analyzed before dependents.
- Import cycles are rejected.
- Namespace imports and named imports are supported.
- Values, types, and datatype constructors have explicit export boundaries.
- Same-spelled datatypes from different files are nominally distinct.

The LSP/project layer should preserve that model but expose it as an analysis service instead of a
compile-only helper.

The target API should look like:

```ts
export type AnalyzeProjectOptions = {
  entryPath: string;
  sourceOverrides?: Map<string, string>;
};

export type ModuleGraph = {
  entryPath: string;
  modules: Map<string, ModuleAnalysis>;
  dependencies: Map<string, string[]>;
  dependents: Map<string, string[]>;
};

export type ModuleAnalysis = {
  path: string;
  ast?: Module;
  imports: ResolvedImport[];
  result?: InferResult;
  diagnostics: Diagnostic[];
};

export type ProjectAnalysis = {
  graph: ModuleGraph;
  diagnosticsByPath: Map<string, Diagnostic[]>;
};
```

`sourceOverrides` is the key LSP feature: it lets the analysis use unsaved editor contents for open
documents while still resolving other files from disk.

Project analysis rules:

- Resolve imports relative to the importing file.
- Normalize paths once and use normalized paths as graph keys.
- Build a directed dependency graph from imports.
- Reject cycles with `module.import-cycle` diagnostics on the involved imports.
- Analyze dependencies before dependents.
- Cache each module's exported static basis: value exports, type exports, constructor exports, ADTs,
  and diagnostics.
- If a dependency has fatal diagnostics, still analyze the dependent as far as possible and emit a
  `module.dependency-invalid` diagnostic at the import site.
- Publish the real underlying diagnostics in the dependency's own file.
- Keep `diagnosticsByPath` as the authoritative LSP output.

For LSP invalidation:

- On an open document change, reanalyze that file and open dependents.
- On a disk file change, reanalyze that file and open dependents.
- On import graph changes, rebuild affected dependency/dependent edges.
- Fingerprint diagnostics per URI and skip republishing unchanged diagnostics.

This is not extra language semantics beyond SML. It is the implementation-level mechanism that gives
the SML-style basis model an editor/project shape.

The recommended first slice:

- Add `NodeId` and `Span` to all syntax nodes through a shared node envelope.
- Use byte offsets as authoritative and derive line/column for LSP presentation.
- Add a structured `Diagnostic` type with stage, severity, message, span, and optional code/details.
- Add recovery variants directly to the AST where they correspond to a missing or damaged syntactic
  category.
- Add a small recovery parser strategy for missing expressions, missing patterns, missing type
  expressions, missing blocks, missing semicolons, and unexpected tokens.
- Make inference tolerate recovery nodes with a simple `ErrorTy`.
- Convert type errors into diagnostics and keep checking the rest of the module where possible.
- Make exhaustiveness/redundancy warnings structured diagnostics instead of bare strings.
- Add a frontend API that returns a result object, not just throws or compiles.

The recommended second slice:

- Expand recovery coverage based on actual editor pain, not theoretical completeness.
- Add user-written holes only if Workman syntax wants them in wm-mini.
- Add hover/type views using node ids and inferred types.
- Add completion/definition support only after the AST and node id model is stable.

The recommended later slice:

- If wm-mini grows real interactive type exploration, introduce a marked AST or typed node view.
- Add unknown types with provenance.
- Move from simple tolerant HM to a full total marking/checking pass only when the language server
  needs Hazel-style hole solving, neutral blame, or unfillable-hole explanations.

## Why Not Full Hazel Immediately

Full Hazel-style marking is mainly valuable when the editor must keep rich semantic services alive
inside broken programs: partial hovers, typed holes, structural editing, repair UI, and high-quality
non-cascading diagnostics.

wm-mini's first LSP beta needs a recovery-capable tree, accurate diagnostics, and a stable frontend
API. It does not need a solver that tracks unknown provenance, computes partial type solutions, or
marks holes as unfillable.

The smaller integrated model still keeps the door open:

- Node ids are useful now and later.
- Spans are useful now and later.
- Structured diagnostics are useful now and later.
- A result-object frontend boundary is useful now and later.
- Recovery nodes are useful now and can later become true Hazel-style marks if needed.
- `ErrorTy` is useful now and can later become unknown types with provenance if needed.

## Concrete Data Shape

Use one small node/span model across parser, inference, module checking, and LSP:

```ts
export type NodeId = number;

export type Span = {
  line: number;
  col: number;
  start: number;
  end: number;
};

export type Located = {
  id: NodeId;
  span: Span;
};
```

This follows the workmangr span shape. `line` is 1-based and `col` is 0-based. They describe the
start of the span. `start` and `end` are the authoritative source offsets for slicing, ordering, and
range math.

Do not add `endLine` or `endCol` to `Span` initially. Multi-line end positions should be computed
from `end` using a line table when producing LSP ranges.

For delimiter matching, use token-level mates rather than extra span fields:

```ts
export type Token = {
  kind: TokenKind;
  span: Span;
  mate?: number; // start offset of the matching delimiter token
};
```

This mirrors workmangr's `mate: Option<Number>` token model. The mate is an offset, not a token id.
It is useful for parser recovery around `()`, `{}`, `[]`, and eventually type-argument delimiters if
wm-mini lexes them as paired delimiters. Recovery can jump to or report against the matching close
delimiter without making every AST span carry end-line metadata.

AST nodes should carry the envelope as a `node` field, following the workmangr shape:

```ts
export type Expr =
  | { kind: "Int"; node: Located; value: number }
  | { kind: "Var"; node: Located; name: string }
  | { kind: "Call"; node: Located; callee: Expr; args: Expr[] }
  | { kind: "MissingExpr"; node: Located; message: string }
  | { kind: "ErrorExpr"; node: Located; message: string };

export type Pattern =
  | { kind: "PWildcard"; node: Located }
  | { kind: "PVar"; node: Located; name: string }
  | { kind: "MissingPattern"; node: Located; message: string }
  | { kind: "ErrorPattern"; node: Located; message: string };

export type TypeExpr =
  | { kind: "TName"; node: Located; name: string; args: TypeExpr[] }
  | { kind: "TVar"; node: Located; name: string }
  | { kind: "MissingTypeExpr"; node: Located; message: string }
  | { kind: "ErrorTypeExpr"; node: Located; message: string };
```

Declarations and module/import nodes should follow the same rule. Every syntactic thing the LSP may
diagnose, hover, or navigate to should have a node.

Line/column should be computed from source text in a helper module:

```ts
export type LineCol = {
  line: number; // 1-based for CLI-style display
  column: number; // 0-based internally for LSP conversion
};
```

Use one diagnostic model. This should take the good part of workmangr's `CompilerError` shape, but
make the model more deliberate:

- Stable diagnostic codes instead of message-string matching.
- Optional `nodeId` so LSP/hover/indexing can connect diagnostics to syntax.
- Structured clues for expected/received/note/hint text.
- No global mutable diagnostic list.
- No direct dependency on thrown exception classes as the primary reporting path.

```ts
export type DiagnosticStage =
  | "lex"
  | "parse"
  | "lower"
  | "module"
  | "type"
  | "coverage"
  | "emit";

export type DiagnosticSeverity =
  | "error"
  | "warning"
  | "info"
  | "hint";

export type DiagnosticClue =
  | { kind: "expected"; message: string }
  | { kind: "received"; message: string }
  | { kind: "incomplete"; message: string }
  | { kind: "note"; message: string }
  | { kind: "hint"; message: string };

export type Diagnostic = {
  stage: DiagnosticStage;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  span: Span;
  nodeId?: NodeId;
  clues?: DiagnosticClue[];
};
```

Diagnostic codes should be stable kebab-case strings, grouped by stage:

```ts
"parse.missing-expr";
"parse.missing-token";
"parse.unexpected-token";
"module.import-cycle";
"module.unknown-import";
"type.unknown-value";
"type.unknown-type";
"type.mismatch";
"type.not-function";
"coverage.non-exhaustive";
"coverage.redundant-arm";
```

Messages can change for clarity, but codes should not change casually because tests, LSP clients,
future quick fixes, and docs can key on them.

Diagnostics should be collected through an explicit context or sink:

```ts
export type DiagnosticSink = {
  add(diagnostic: Diagnostic): void;
};

export type FrontendContext = {
  diagnostics: Diagnostic[];
  addDiagnostic(diagnostic: Diagnostic): void;
};
```

Each frontend phase may return diagnostics directly or receive a context, but should not write into
module-level mutable state. Thrown exceptions should be reserved for internal bugs, cancellation, or
temporary compatibility boundaries while the frontend is being migrated.

For LSP, map severity directly:

```ts
const lspSeverity = {
  error: 1,
  warning: 2,
  info: 3,
  hint: 4,
} as const;
```

LSP diagnostics should include `code`, `source: "wm-mini"`, and related/clue information once the
client support is useful. CLI diagnostics can render the same structure with source excerpts.

Add one simple type-recovery primitive:

```ts
export type Ty =
  | { tag: "error" }
  | { tag: "var"; id: number; name?: string; instance?: Ty }
  | { tag: "prim"; name: string }
  | { tag: "fn"; params: Ty[]; result: Ty }
  | { tag: "tuple"; items: Ty[] }
  | { tag: "named"; id: number; name: string; args: Ty[] };
```

Unification involving `ErrorTy` should not emit another mismatch. It should short-circuit so one
syntax or type error does not cascade through the module.

Inference should still be HM, but it should report-and-continue for common local failures:

- Unknown value name: diagnostic at the variable node, return `ErrorTy`.
- Unknown type name: diagnostic at the type-expression node, return `ErrorTy`.
- Non-function call: diagnostic at the call or callee node, return `ErrorTy`.
- Type mismatch: diagnostic at the most local useful node, return `ErrorTy` for the current join.
- Missing/error syntax node: diagnostic already exists from parsing, return `ErrorTy`.

## Decision

For wm-mini Goal 1 and the first VS Code extension:

- Do add a recovery-capable AST now.
- Do add spans, ids, and structured diagnostics now.
- Do add simple tolerant inference with `ErrorTy`.
- Do not add a parallel marked AST now.
- Do not add full Hazel-style unknown provenance, constraint solving, or unfillable-hole reasoning
  now.
- Do design recovery nodes and `ErrorTy` so they can evolve into richer marks/unknowns later without
  replacing the whole frontend shape.
