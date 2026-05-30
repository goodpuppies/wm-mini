import { assertEquals, assertRejects } from "@std/assert";
import { checkFile, checkVirtual } from "../src/compiler.ts";
import { loadModuleGraph } from "../src/module_graph.ts";
import { expectBinding } from "./type_helpers.ts";

Deno.test("imported type constructors and constructors remain available through namespace", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/option.wm", "export type Option<T> = None | Some<T>; export let wrap = (x) => { Some(x) };"],
    ["/test/main.wm", "from \"./option.wm\" import * as Opt; let value: Opt.Option<Number> = Opt.wrap(1); let get = match(value) => { Opt.Some(x) => { x }, Opt.None => { 0 } };"],
  ]);

  const results = await checkVirtual("/test/main.wm", virtualFs);
  const main = results.get("/test/main.wm");
  if (!main) throw new Error("missing main result");
  expectBinding(main.env, "get", { type: "(Option<Number>) => Number", vars: 0 });
});

Deno.test("named import allows a type and constructor to share one local spelling", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/lib.wm", "export type Box<T> = | Box<T>;"],
    ["/test/main.wm", 'from "./lib.wm" import { Box }; let x: Box<Number> = Box(1);'],
  ]);

  await checkVirtual("/test/main.wm", virtualFs);
});

Deno.test("named imports can replace basis option type and constructors together", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/lib.wm", "export type Option<T> = None | Some<T>;"],
    ["/test/main.wm", "from \"./lib.wm\" import { Option, Some, None }; let value: Option<Number> = Some(1); let get = match(value) => { Some(x) => { x }, None => { 0 } };"],
  ]);

  await checkVirtual("/test/main.wm", virtualFs);
});

Deno.test("star import without alias opens exported members", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/lib.wm", "export type Box<T> = | Box<T>; export let make = (x) => { Box(x) };"],
    ["/test/main.wm", 'from "./lib.wm" import *; let x: Box<Number> = make(1); let y = Box(2);'],
  ]);

  await checkVirtual("/test/main.wm", virtualFs);
});

Deno.test("star import without alias rejects collisions", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/a.wm", "export let value = 1;"],
    ["/test/b.wm", "export let value = 2;"],
    ["/test/main.wm", "from \"./a.wm\" import *; from \"./b.wm\" import *; let x = value;"],
  ]);

  await assertRejects(() => checkVirtual("/test/main.wm", virtualFs), Error, "duplicate value import value");
});

Deno.test("type imports reject collisions with existing local type declarations", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/lib.wm", "export type Box<T> = T;"],
    ["/test/main.wm", "type Box = | LocalBox; from \"./lib.wm\" import { Box }; let x = 1;"],
  ]);

  await assertRejects(() => checkVirtual("/test/main.wm", virtualFs), Error, "duplicate type import Box");
});

Deno.test("value imports reject collisions with imported constructors", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/a.wm", "export type A = | Ctor;"],
    ["/test/b.wm", "export type B = | Ctor;"],
    ["/test/main.wm", "from \"./a.wm\" import { Ctor }; from \"./b.wm\" import { Ctor }; let x = Ctor;"],
  ]);

  await assertRejects(() => checkVirtual("/test/main.wm", virtualFs), Error, "duplicate value import Ctor");
});

Deno.test("module graph exposes ordered nodes and import edges", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/base.wm", "export let value = 1;"],
    ["/test/main.wm", 'from "./base.wm" import * as Base; let x = Base.value;'],
  ]);

  const graph = await loadModuleGraph("/test/main.wm", { virtualFs });
  const basePath = "/test/base.wm";
  const mainPath = "/test/main.wm";

  assertEquals(graph.entry, mainPath);
  assertEquals(graph.order, [basePath, mainPath]);
  assertEquals(graph.nodes.get(basePath)?.emitName, "Base");
  assertEquals(graph.nodes.get(basePath)?.source, "export let value = 1;");
  assertEquals(graph.nodes.get(mainPath)?.imports.map((edge) => edge.path), [basePath]);
});

Deno.test("file elaboration exposes SML-like structure environments", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/lib.wm", "let hidden = 1; export type Box<T> = | Box<T>; export let shown = Box(hidden);"],
    ["/test/main.wm", 'from "./lib.wm" import * as Lib; let x = Lib.shown;'],
  ]);

  const results = await checkVirtual("/test/main.wm", virtualFs);
  const lib = results.get("/test/lib.wm");
  if (!lib) throw new Error("missing lib result");

  assertEquals(lib.structure.values.has("hidden"), true);
  assertEquals(lib.exportedStructure.values.has("hidden"), false);
  assertEquals(lib.exportedStructure.values.has("shown"), true);
  assertEquals(lib.exportedStructure.types.has("Box"), true);
  assertEquals(lib.exportedStructure.adts.size, 1);
});

Deno.test("exported structure rejects values and aliases that expose private types", async () => {
  const virtualFs1 = new Map<string, string>([
    ["/test/bad_value.wm", "type Hidden = | Hidden; export let leak = Hidden;"],
  ]);
  const virtualFs2 = new Map<string, string>([
    ["/test/bad_alias.wm", "type Hidden = | Hidden; export type Alias = Hidden;"],
  ]);
  const virtualFs3 = new Map<string, string>([
    ["/test/bad_datatype.wm", "type Hidden = | Hidden; export type Public = | Public<Hidden>;"],
  ]);

  await assertRejects(
    () => checkVirtual("/test/bad_value.wm", virtualFs1),
    Error,
    "exported value leak mentions non-exported type",
  );
  await assertRejects(
    () => checkVirtual("/test/bad_alias.wm", virtualFs2),
    Error,
    "exported type Alias mentions non-exported type",
  );
  await assertRejects(
    () => checkVirtual("/test/bad_datatype.wm", virtualFs3),
    Error,
    "exported type Public mentions non-exported type",
  );
});

Deno.test("named imports keep aliases transparent inside datatype constructor payloads", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/lib.wm", "export type Pair<T> = (T, T); export type Box<T> = | Box<Pair<T>>; export let make = (x, y) => { Box((x, y)) };"],
    ["/test/main.wm", "from \"./lib.wm\" import { Pair, Box, make }; let pair: Pair<Number> = (1, 2); let value: Box<Number> = make(1, 2); let sum = match(value) { Box(left, right) => { left + right } };"],
  ]);

  const results = await checkVirtual("/test/main.wm", virtualFs);
  const main = results.get("/test/main.wm");
  if (!main) throw new Error("missing main result");
  expectBinding(main.env, "sum", { type: "Number", vars: 0 });
});

Deno.test("namespace imports keep aliases transparent for datatype exhaustiveness", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/lib.wm", "export type Pair<T> = (T, T); export type Box<T> = | Box<Pair<T>>; export let make = (x, y) => { Box((x, y)) };"],
    ["/test/main.wm", "from \"./lib.wm\" import * as Lib; let value: Lib.Box<Number> = Lib.make(1, 2); let sum = match(value) { Lib.Box(left, right) => { left + right } };"],
  ]);

  const results = await checkVirtual("/test/main.wm", virtualFs);
  const main = results.get("/test/main.wm");
  if (!main) throw new Error("missing main result");
  expectBinding(main.env, "sum", { type: "Number", vars: 0 });
});

Deno.test("namespace imports keep same-spelled type aliases distinct when their results are nominal", async () => {
  const virtualFs = new Map<string, string>([
    ["/test/a.wm", "export type Box = | Box; export type Alias = Box; export let make = () => { Box };"],
    ["/test/b.wm", "export type Box = | Box; export type Alias = Box; export let make = () => { Box };"],
    ["/test/main.wm", "from \"./a.wm\" import * as A; from \"./b.wm\" import * as B; let bad: A.Alias = B.make();"],
  ]);

  await assertRejects(() => checkVirtual("/test/main.wm", virtualFs), Error, "type mismatch");
});
