import { assertRejects, assertStringIncludes } from "@std/assert";
import { checkSource, checkVirtual, compile } from "../src/compiler.ts";
import { expectBinding } from "./type_helpers.ts";

Deno.test("supports typed JS namespace imports", async () => {
  const result = await checkSource(`
    from js.global("console") import { log: (String, Number) => Void } as console;
    let main = () => {
      console.log("answer", 42)
    };
  `);

  expectBinding(result.env, "main", { type: "(Void) => Void", vars: 0 });
});

Deno.test("supports inferred JS named and namespace imports", async () => {
  const result = await checkSource(`
    from js.global("Math") import { max as jsmax, floor };
    from js.global("Math") import * as Math;
    let bigger = jsmax(1, 2);
    let rounded = floor(4.8);
    let rooted = Math.sqrt(9);
  `);

  expectBinding(result.env, "floor", { type: "(Number) => Result<Number, Js.Error>", vars: 0 });
  expectBinding(result.env, "bigger", { type: "Result<Number, Js.Error>", vars: 0 });
  expectBinding(result.env, "rounded", { type: "Result<Number, Js.Error>", vars: 0 });
  expectBinding(result.env, "rooted", { type: "Result<Number, Js.Error>", vars: 0 });
});

Deno.test("supports inferred callable root JS globals", async () => {
  const result = await checkSource(`
    from js.global import { fetch };
    let response = fetch("https://example.test");
  `);
  const js = await compile(`
    from js.global import { fetch };
    let response = fetch("https://example.test");
  `);

  expectBinding(result.env, "response", {
    type: "Result<Js.Promise<Js.Object>, Js.Error>",
    vars: 0,
  });
  assertStringIncludes(js, '__wm_js_member("fetch")');
});

Deno.test("supports Js.Promise as a basis type", async () => {
  const result = await checkSource(`
    let promise: Js.Promise<String> = Panic("promise");
  `);

  expectBinding(result.env, "promise", { type: "Js.Promise<String>", vars: 0 });
});

Deno.test("maps reflected TS promises to Js.Promise", async () => {
  const result = await checkSource(`
    from js.global("Deno") import { readTextFile };
    let file = readTextFile("README.md");
  `);

  expectBinding(result.env, "file", {
    type: "Result<Js.Promise<String>, Js.Error>",
    vars: 0,
  });
});

Deno.test("typed JS promise receiver results infer through then", async () => {
  const result = await checkSource(`
    from js.global("Deno") import { readTextFile };
    let try = (result) => {
      match(result) {
        Ok(value) => { value },
        Err(_) => { Panic("ffi") },
      }
    };
    let readBang = () => {
      let file = readTextFile("README.md") :> try;
      file :> .then((text) => {
        text ++ "!"
      }) :> try
    };
  `);

  expectBinding(result.env, "readBang", { type: "(Void) => Js.Promise<String>", vars: 0 });
});

Deno.test("maps function-valued JS union parameters as JS values", async () => {
  const result = await checkSource(`
    from js.global import unsafe { setTimeout };
    let timer = setTimeout(() => { void }, 10);
  `);

  expectBinding(result.env, "timer", { type: "Number", vars: 0 });
});

Deno.test("maps object-bearing JS union parameters as JS values", async () => {
  const result = await checkSource(`
    from js.global("crypto.subtle") import unsafe { importKey };
    let key = importKey(
      "raw",
      JSON{ key: "secret" },
      JSON{ name: "HMAC", hash: "SHA-256" },
      false,
      JSON["sign"],
    );
  `);

  expectBinding(result.env, "key", { type: "Js.Promise<Js.Object>", vars: 0 });
});

Deno.test("uses expression JS refs for coarse object receiver methods", async () => {
  const result = await checkSource(`
    from js.global import unsafe { URL, fetch };
    let host = () => {
      URL.new("https://example.test/a") :> .host
    };
    let install = () => {
      fetch("https://example.test") :> .then((res) => {
        let status = res.status;
        void
      })
    };
  `);

  expectBinding(result.env, "host", { type: "(Void) => Result<String, Js.Error>", vars: 0 });
  expectBinding(result.env, "install", {
    type: "(Void) => Result<Js.Promise<Void>, Js.Error>",
    vars: 0,
  });
});

Deno.test("preserves expression refs through block-local Result pass-through lets", async () => {
  const result = await checkSource(`
    from js.global import unsafe { fetch };
    let try = (result) => {
      match(result) {
        Ok(value) => { value },
        Err(_) => { Panic("ffi") },
      }
    };
    let install = () => {
      let requestPromise = fetch("https://example.test");
      requestPromise :> .then((res) => {
        let responsePromise = res :> .json() :> try;
        responsePromise :> .then((body) => { body }) :> try
      }) :> try
    };
  `);

  expectBinding(result.env, "install", { type: "(Void) => Js.Promise<Js.Value>", vars: 0 });
});

Deno.test("preserves delayed receiver refs through block-local Result pass-through lets", async () => {
  const result = await checkSource(`
    from js.global import type { Request };
    let try = (result) => {
      match(result) {
        Ok(value) => { value },
        Err(_) => { Panic("ffi") },
      }
    };
    let useText = (req: Request) => {
      let textPromise = req :> .text() :> try;
      textPromise :> .then((bodyText) => { bodyText }) :> try
    };
  `);

  expectBinding(result.env, "useText", { type: "(Request) => Js.Promise<Js.Value>", vars: 0 });
});

Deno.test("infers named JS callback parameter refs from later call sites", async () => {
  const result = await checkSource(`
    from js.global("Deno") import unsafe { serve };
    let try = (result) => {
      match(result) {
        Ok(value) => { value },
        Err(_) => { Panic("ffi") },
      }
    };
    let handle = (req, info) => {
      let textPromise = req :> .text() :> try;
      textPromise :> .then((bodyText) => { bodyText }) :> try
    };
    let server = serve(JSON{ port: 8080 }, handle);
  `);

  expectBinding(result.env, "handle", {
    type: "((Request, 'a)) => Js.Promise<Js.Value>",
    vars: 1,
  });
});

Deno.test("unannotated helper JS receivers preserve callback foreign refs", async () => {
  const virtualFs = new Map([
    [
      "/test/server.wm",
      `
        from js.global("Deno") import unsafe { serve };
        let try = (result) => {
          match(result) {
            Ok(value) => { value },
            Err(_) => { Panic("ffi") },
          }
        };
        let helper = (req) => {
          let jsonPromise = req :> .json() :> try;
          jsonPromise :> .then((body) => { body }) :> try
        };
        let handle = (req, info) => {
          helper(req)
        };
        let server = serve(JSON{ port: 8080 }, handle);
      `,
    ],
  ]);
  const results = await checkVirtual("/test/server.wm", virtualFs);
  const result = results.get("/test/server.wm")!;

  expectBinding(result.env, "helper", { type: "(Request) => Js.Promise<Js.Value>", vars: 0 });
  expectBinding(result.env, "handle", {
    type: "((Request, 'a)) => Js.Promise<Js.Value>",
    vars: 1,
  });
});
