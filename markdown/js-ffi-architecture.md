# JS FFI Architecture Notes

The JS FFI goal is an 80/20 split:

- common JS code should port with reflected types, receiver calls, callback parameter refs, and
  promise shapes handled automatically;
- genuinely dynamic or structurally unclear JS should require explicit Workman code, usually through
  a whole-value assertion such as `Json.assert` or a small user helper.

The compiler should not grow an ad hoc model of every awkward JS pattern. If a case cannot be solved
from real reflection metadata or ordinary HM constraints, prefer a clear escape hatch over a clever
partial inference rule.

## Current File Layout

`src/ffi` is organized around three phases:

```txt
src/ffi/
  elab.ts              # pre-HM FFI elaboration entry point
  imports.ts           # JS import collection and generated import declarations
  shared.ts            # generated binding and overload-selection helpers
  type_expr.ts         # small TypeExpr constructors

  reflect/
    host.ts            # TypeScript reflection host/program setup
    types.ts           # reflection queries for globals, modules, refs, members, calls
    type_mapping.ts    # TypeScript type -> Workman TypeExpr mapping
    type_refs.ts       # JS reflection metadata shapes

  receiver/
    receiver.ts        # receiver refs, object access state, ref pass-through recognition
    rewrite_expr.ts    # pre-HM expression rewrite for reflected receivers
    rewrite_blocks.ts  # block/match rewrite helpers with local ref scopes
    rewrite_decl.ts    # declaration rewrite helper

  delayed/
    delayed.ts         # post-HM delayed receiver resolution entry point
    annotations.ts     # rejects callback annotations used as dynamic casts
    bindings.ts        # delayed ref bookkeeping and generated foreign decls
    materialize.ts     # turns delayed receiver access into generated FFI calls
    receiver_models.ts # built-in Js.Array/Js.Promise/foreign receiver models
    types.ts           # delayed resolver options
```

## Reflection Metadata

`JsTypeRef` is the compiler's handle on real TypeScript reflection information. It carries:

- the reflected source needed to ask TypeScript more questions later;
- an expression name for the reflected value;
- optionally, the Workman type we already mapped.

Refs are most valuable for coarse opaque values: DOM objects, responses, requests, crypto keys,
headers, promises, arrays, and imported nominal JS types. Primitive values do not need much ref
machinery because their receiver surfaces are small and can be modeled directly.

The intended invariant is:

> If a value originated from reflected JS and passes through ordinary Workman code without changing
> identity, its ref should pass through too.

The current implementation does not fully satisfy that invariant. It has specific recognition for
`Ok`-payload pass-through helpers so functions like `try` can preserve refs. That was useful for the
webhook work, but it is too shape-specific. We should either make ref propagation genuinely general
for identity-preserving functions or stop pretending arbitrary helpers preserve refs and force a
clearer user-level boundary.

## Dynamic Receivers

Dynamic `Js.Object` receiver calls currently exist as an escape hatch for code like:

```wm
object :> .method(arg)
object :> .property
```

when no concrete reflected receiver is known. This solves a real ergonomic problem, but the current
model is risky because dynamic calls can manufacture fresh generic-looking result types. That is too
close to the old fake-cast problem: the compiler appears to know something precise even though it
only knows "some JS happened".

Refactor direction:

- keep reflected receiver calls precise when a real `JsTypeRef` exists;
- keep delayed receiver resolution when HM later constrains the receiver to a reflected/foreign
  type;
- stop giving arbitrary dynamic `Js.Object` members fresh precise type variables;
- use a coarse result such as `Result<Js.Value, Js.Error>` or `Result<Js.Object, Js.Error>` until
  the user performs an explicit assertion/check;
- for JSON, prefer one whole-shape assertion over gradual property digging.

## TypeScript Mapping Policy

`reflect/type_mapping.ts` should stay pragmatic:

- primitives map to Workman primitives;
- arrays and typed arrays map to `Js.Array<T>` when the element is reasonably knowable;
- promises map to `Js.Promise<T>`;
- nullish returns map to `Option<T>`;
- object-like results map to `Js.Object` when no better nominal type is available;
- unknown, `any`, and hard unions should fall back to `Js.Value`.

Unions are a permanent risk area. The mapper should support common DOM/JS cases, but it should not
try to encode TypeScript's full union logic in Workman. If a union is not obviously useful, collapse
it to `Js.Value` and make the user handle it.

## Promise And Array Models

`delayed/receiver_models.ts` currently has small built-in models for:

- `Js.Promise<T>.then`
- `Js.Promise<T>.catch`
- `Js.Array<T>.map`
- `Js.Array<T>.join`
- `Js.Array<T>.length`

Promise support is part of the 80% path for JS interop and should stay. Array support is useful for
ported JS examples, but it should remain a small common subset. Avoid growing this into a full JS
standard-library model inside the compiler.

## Refactor Candidates

Highest value:

1. Replace shape-specific `try`/`Ok` ref pass-through with either general identity-preserving ref
   propagation or an explicit basis/helper convention.
2. Replace dynamic receiver fresh type variables with coarse dynamic results plus explicit
   assertions.
3. Keep moving policy decisions out of the recursive rewrite functions and into small modules with
   clear names.

Lower value:

- modeling more JS array/string/object methods by hand;
- expanding TypeScript union mapping beyond common DOM/web APIs;
- making JSON property-level checks part of the language;
- adding more special cases for callback annotations instead of improving reflection or requiring an
  explicit user assertion.
