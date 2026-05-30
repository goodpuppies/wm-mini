# Compiler Infrastructure Checklist

This checklist tracks the move from the current JavaScript smoke-test emitter to a real SML-subset
compiler pipeline.

Status legend:

- Done: implemented and covered by tests or direct source evidence.
- Partial: implemented with known limitations or weak coverage.
- Gap: not yet implemented or not sufficiently verified.
- Later: intentionally deferred until the core compiler pipeline exists.

## Scope Decisions

- The semantic target is an SML Core/Modules subset, not Workman syntax directly.
- Workman and `wmsml` are surface spellings that should elaborate to the same Core where they
  overlap.
- JavaScript is a backend for the dynamic semantics, not the semantic definition.
- The first real backend milestone should favor semantic faithfulness over performance.
- Optimizer IR, closure conversion, exceptions, refs, mutation, equality types, and full Basis
  behavior are not required for the initial compiler-infra milestone.
- JS interop requires SML-style value restriction before useful effectful externals are added.

## Existing State

| Area                                         | Status  | Evidence / Notes                                                                                                            |
| -------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Workman parser                               | Done    | `src/grammar.peggy`; current frontend tests.                                                                                |
| `wmsml` parser                               | Partial | `src/grammar.wmsml.peggy`; covers verification subset, not full SML.                                                        |
| Type inference                               | Partial | HM-style inference exists, but does not yet produce a complete typed Core artifact.                                         |
| File-as-structure module graph               | Done    | `src/module_graph.ts`; module/import tests.                                                                                 |
| Static exports and import environments       | Done    | `inferModule`; module tests.                                                                                                |
| JS emitter                                   | Partial | `src/core/emit_js.ts` emits from Core artifacts; still needs Runtime Core lowering and interpreter parity tests.            |
| CLI run/compile/check                        | Partial | Command shape exists; `compile`/`run` emit through the Core backend.                                                        |
| Core interpreter                             | Gap     | Needed as dynamic-semantics oracle.                                                                                         |
| Runtime Core / backend IR                    | Gap     | Needed before the JS backend can stop carrying semantic decisions.                                                          |
| Runtime nominal constructor identity         | Partial | `coreFile` artifacts assign distinct constructor IDs; checked JS emission now uses those IDs for constructors and patterns. |
| Workman/`wmsml` elaboration equivalence test | Partial | Static type-shape tests exist; no complete Core equivalence artifact yet.                                                   |

## SML Definition Runtime Review

Checked against `research/The-Definition-of-Standard-ML-Revised/dyncor.tex`:

- Dynamic evaluation order is left-to-right by the state convention; current JS emission mostly
  inherits this for calls, tuples, records, and blocks.
- Function expressions are closures over a whole `match`; `CoreFn` keeps `arms` and JS application
  raises `Match` when no arm matches.
- JS runtime tests now cover ordinary closure environment capture and mutually recursive closure
  bindings, matching the Definition's closure/`Rec` intent for the current subset.
- `val`/`let` pattern failure raises `Bind`; JS emission now emits explicit `Bind` failure points
  for refutable non-recursive bindings.
- Datatype constructors are constants or unary value constructors; Core and JS emission represent
  constructor payloads as zero-or-one payload value, with tuple payloads for multi-field syntax.
- Record values are semantic finite maps by label; JS equality now compares record keys independent
  of insertion order.
- Partial: Core artifacts now assign value binding IDs and JS emission uses them for local
  references, so sequential shadowing no longer depends on source-name JS locals.
- Still missing: complete resolved-reference facts by source node, import value IDs, and full SML
  identifier-status/environment modification.
- Still missing: Runtime Core/interpreter rules for exception-packet propagation, explicit match
  failure nodes, recursive closure environments, and primitive Basis behavior.

## SML Definition Static Review: Value Restriction

Checked against `research/The-Definition-of-Standard-ML-Revised/statcor.tex` and
`research/The-Definition-of-Standard-ML-Revised/whatisnew.tex`:

- SML 97 uses value polymorphism: a `val` binding gets a non-trivial polymorphic scheme only when
  the expression that produced the bound value is non-expansive.
- The Definition's non-expansive class includes special constants, value identifiers, records of
  non-expansive fields, constructor application to non-expansive payloads, annotations, and
  `fn match`.
- All other expressions are expansive. For wm-mini, ordinary function application and external JS
  application must be expansive.
- Closure/generalization is applied to the value environment produced by a value binding, not as a
  backend concern.
- Top-level free type variables introduced by expansive bindings are rejected after the whole module
  is inferred; later declarations may still constrain the monotype before that final check.

Initial wm-mini rule:

- Generalize free type variables only for non-expansive binding RHSs.
- Keep expansive binding RHSs monomorphic.
- Start conservative; later widen non-expansive classification only when it matches the Definition
  and current Core forms.

## Phase 1: Core Data Model

| Task                                                                                | Status  | Notes                                                                                                                          |
| ----------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Add internal ID types for variables, constructors, type names, records, and modules | Partial | `src/core/ids.ts` defines allocators; constructor IDs are wired into `coreFile` artifacts.                                     |
| Define elaborated Core AST                                                          | Partial | `src/core/ast.ts` starts the Core shape with unary app/constructor payloads and `fn match`; references are still source names. |
| Define Core module artifact                                                         | Partial | `src/core/artifact.ts` carries Core declarations, imports, analysis, module order, binding IDs, and dynamic exports.           |
| Define typed node facts                                                             | Gap     | Binding schemes, instantiated expression types, resolved references by source node ID.                                         |
| Add pretty-printer or structural snapshot format for Core                           | Partial | `src/core/snapshot.ts` covers the initial Core shape.                                                                          |

## Phase 2: Elaboration Boundary

| Task                                                                | Status  | Notes                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Split parse AST from elaborated Core in compiler APIs               | Partial | `coreSource` and `coreFile` expose checked Core artifacts without changing existing compile/check APIs.                                                                         |
| Have inference produce resolved variable references                 | Partial | Core artifacts assign local binding IDs for JS emission; source-node facts and import value IDs are still missing.                                                              |
| Have inference produce resolved constructor references              | Partial | `coreFile` resolves constructor declarations and expression/pattern constructor refs; full binding/status facts are still missing.                                              |
| Preserve SML identifier status in elaboration output                | Gap     | Values vs constructors now matter beyond type inference.                                                                                                                        |
| Classify expressions as expansive/non-expansive                     | Partial | Conservative context/status-based classifier exists; ordinary calls are expansive, constructor apps can be non-expansive.                                                       |
| Apply value restriction during generalization                       | Partial | Non-recursive bindings now generalize only non-expansive RHSs; unresolved top-level expansive monotypes are rejected; recursive and future external bindings still need review. |
| Lower Workman list syntax before or during elaboration              | Partial | Parser already lowers list syntax to `Nil`/`Cons`; this should become explicit in the Core story.                                                                               |
| Elaborate imports into structure environments and module references | Partial | Static side exists; Core file artifacts now carry import edges, but dynamic initialization lowering is missing.                                                                 |
| Add Core equivalence tests for Workman and `wmsml` examples         | Gap     | Start with val/let, fn/lambda, datatype/case, tuple call.                                                                                                                       |

## Phase 3: Core Interpreter

| Task                                              | Status | Notes                                                                            |
| ------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| Implement runtime value model                     | Gap    | Include numbers, strings, booleans, void, tuples, records, closures, ADT values. |
| Use constructor IDs in ADT values                 | Gap    | Display names are not semantic identity.                                         |
| Evaluate literals, variables, lambda, call, let   | Gap    | Small first slice.                                                               |
| Evaluate constructors and constructor application | Gap    | Nullary constructors may be singleton values.                                    |
| Evaluate tuples and records                       | Gap    | Match current frontend subset.                                                   |
| Evaluate high-level match or lowered match        | Gap    | Ordered semantics first is acceptable.                                           |
| Raise/capture `Bind` and `Match` failures         | Gap    | Should align with current JS behavior and SML dynamic semantics.                 |
| Capture primitive `print` output for tests        | Gap    | Needed for JS parity tests.                                                      |

## Phase 4: Runtime Core

| Task                                               | Status  | Notes                                                                                                             |
| -------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| Define runtime Core AST                            | Gap     | Lowered enough for interpreter and JS emitter to share.                                                           |
| Compile pattern matching to explicit tests/tree    | Gap     | Keep diagnostics in frontend; backend gets failure points.                                                        |
| Make refutable let binding failure explicit        | Gap     | `Bind` point should not be an emitter guess.                                                                      |
| Make function argument pattern failure explicit    | Gap     | `Match` point should not be an emitter guess.                                                                     |
| Make module initialization order explicit          | Gap     | Derived from module graph order.                                                                                  |
| Alpha-rename or otherwise backend-safe local names | Partial | JS emission uses Core binding IDs for local binders/references; import aliases and full source-node facts remain. |

## Phase 5: JavaScript Backend Rework

| Task                                                        | Status  | Notes                                                                                                                     |
| ----------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Move JS emitter input from surface AST to Core/Runtime Core | Partial | JS emission now consumes Core artifacts; Runtime Core is still missing.                                                   |
| Emit constructor metadata with numeric/string-stable IDs    | Partial | Checked Core emission uses constructor IDs where available; the runtime representation is still an early shape.           |
| Emit module namespaces from module artifacts                | Partial | Core emission builds module namespaces from module artifacts and dynamic exports; this still needs Runtime Core lowering. |
| Emit match code from lowered match representation           | Gap     | No frontend pattern logic in JS emitter.                                                                                  |
| Keep generated JS runtime helpers small and explicit        | Partial | Helpers are tiny; equality now handles tuples, constructors, and record-label order, but Basis behavior is incomplete.    |
| Add JS parity tests against Core interpreter                | Gap     | Prefer output/result equality over JS string includes.                                                                    |

## Phase 6: Diagnostics And Tooling Facts

| Task                                                    | Status  | Notes                                                                      |
| ------------------------------------------------------- | ------- | -------------------------------------------------------------------------- |
| Keep source node IDs through elaboration                | Partial | Parser has node payloads; Core artifact needs to preserve/source-map them. |
| Record resolved references by node ID                   | Gap     | Needed for go-to-definition and robust hover.                              |
| Record instantiated expression types by node ID         | Gap     | Existing hover infers from snapshots; Core facts can make this stronger.   |
| Record binding schemes by binding ID and source node ID | Partial | Environment snapshots exist; binding IDs do not.                           |
| Keep diagnostics independent of backend                 | Done    | Current frontend diagnostics already happen before emission.               |

## Phase 7: JS Interop Design

| Task                                            | Status  | Notes                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implement value restriction prerequisite        | Partial | Conservative value restriction is in inference; JS calls are ordinary expansive function calls.                                                                                                                                        |
| Design typed external binding declaration       | Partial | JS imports support inferred members, star namespace imports, aliases, manual annotations, and receiver-method elaboration; `src/ffi/elab.ts` resolves JS reflection before HM.                                                         |
| Support direct JS global/member names           | Partial | Core/JS path supports `Math.floor(...)`, `console.log(...)`, aliased locals like `jsmax(...)`, and reflected chains like `proc.stdout.on(...)`.                                                                                        |
| Define dynamic representation conversion rules  | Partial | Number/String/Bool/Void pass directly; tuple function arguments spread at the JS call boundary; `JSON{}`/`JSON[]` construct `Js.Value`; reflected object results are opaque `Js.Object`; reflected calls return `Result<_, Js.Error>`. |
| Reject or explicitly mark unsafe/raw boundaries | Partial | Reflected JS is fallible by default; manual typed imports remain the explicit raw boundary for now.                                                                                                                                    |
| Add no-bindgen smoke tests                      | Partial | `console.log`, `Math.max`, `Math.floor`, `Math.sqrt`, `node:crypto/createHash`, `node:child_process/spawn`, `Deno.readTextFileSync`, and JS throw-to-`Err` smoke tests exist.                                                          |

## Value Restriction Implementation Slice

1. Add an `isNonExpansive(expr, context)` classifier near inference/elaboration. [Partial]
2. Classify the existing subset conservatively:
   - literals, variables, function literals, constructor constants: non-expansive
   - tuples/records: non-expansive only when every field is non-expansive
   - constructor application: non-expansive only when the callee has constructor status in the
     current context and the payload is non-expansive
   - ordinary calls, matches, ifs, blocks, and future external calls: expansive initially [Partial]
3. Change `inferDecl`/binding generalization so each binder's scheme closes only when its unique RHS
   is non-expansive. [Partial]
4. Preserve current polymorphism for `let id = (x) => { x };`. [Done]
5. Add negative tests where `let x = makeEmpty();` cannot be used at two incompatible
   instantiations. [Done]
6. Add positive tests where non-expansive constructor constants and function literals still
   generalize. [Done]
7. Reject unresolved top-level free monotype variables after whole-module inference, while allowing
   later declarations to constrain them first. [Done]
8. Add typed JS imports after value restriction is green. [Partial]

## First Implementation Slice

1. Add `src/core/ids.ts` and `src/core/ast.ts`.
2. Add a Core snapshot printer for tests.
3. Add an elaboration API that returns `{ graph, results, coreModules }`.
4. Core-elaborate a tiny subset first: literals, variables, lambdas, calls, `let`, tuples.
5. Extend to datatypes, constructors, and match.
6. Add an interpreter for that same subset.
7. Move JS emission behind the Core boundary.
8. Replace JS string-fragment tests with interpreter-vs-JS behavioral tests where practical.

## Acceptance Criteria For This Milestone

- A valid Workman program can be parsed, checked, elaborated to Core, interpreted, emitted to JS,
  and run.
- An equivalent `wmsml` program elaborates to an equivalent Core snapshot for the shared subset.
- Same-spelled constructors from different modules are distinct in Core and at runtime.
- The JS emitter contains no source AST pattern-matching logic.
- CLI `wm run file.wm` executes through the Core/Runtime-Core backend path.
- Existing frontend tests remain green.
