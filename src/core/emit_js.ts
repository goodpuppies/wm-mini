import type { CoreDecl, CoreExpr, CoreMatchArm, CorePattern } from "./ast.ts";
import type { CoreDynamicExport, CoreModuleArtifact, CoreProgram } from "./artifact.ts";
import type { BindingId } from "./ids.ts";

const reserved = new Set(["const", "let", "function", "return", "if", "else", "class", "void"]);

export function emitCoreProgram(program: CoreProgram): string {
  const entry = program.modules.get(program.entry)!;
  const main = mainRef(entry);
  return [
    '"use strict";',
    "const __wm_tuple = (...items) => items;",
    `const __wm_eq = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((item, index) => __wm_eq(item, b[index]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if ("ctor" in a || "ctor" in b) {
    return a.ctor === b.ctor && __wm_eq(a.args, b.args);
  }
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, index) =>
    key === bk[index] && __wm_eq(a[key], b[key])
  );
};`,
    `const __wm_show = (value, seen = new WeakSet()) => {
  if (value === undefined) return "void";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return "<function>";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "<cycle>";
  seen.add(value);
  let shown;
  if (Array.isArray(value)) {
    shown = "(" + value.map((item) => __wm_show(item, seen)).join(", ") + ")";
  } else if ("ctor" in value) {
    shown = value.args.length === 0
      ? value.name
      : value.name + "(" + value.args.map((item) => {
        if (Array.isArray(item)) return item.map((part) => __wm_show(part, seen)).join(", ");
        return __wm_show(item, seen);
      }).join(", ") + ")";
  } else {
    shown = "{ " + Object.keys(value).sort().map((key) => key + " = " + __wm_show(value[key], seen)).join(", ") + " }";
  }
  seen.delete(value);
  return shown;
};`,
    "const print = (value) => console.log(__wm_show(value));",
    "const __wm_fail = (name, message) => { const e = new Error(message); e.name = name; throw e; };",
    "const __wm_op_add = ([a, b]) => a + b;",
    "const __wm_op_sub = (x) => Array.isArray(x) ? x[0] - x[1] : -x;",
    "const __wm_op_mul = ([a, b]) => a * b;",
    "const __wm_op_div = ([a, b]) => a / b;",
    "const __wm_op_mod = ([a, b]) => a % b;",
    "const __wm_op_eq = ([a, b]) => __wm_eq(a, b);",
    "const __wm_op_ne = ([a, b]) => !__wm_eq(a, b);",
    "const __wm_op_lt = ([a, b]) => a < b;",
    "const __wm_op_lte = ([a, b]) => a <= b;",
    "const __wm_op_gt = ([a, b]) => a > b;",
    "const __wm_op_gte = ([a, b]) => a >= b;",
    "const __wm_op_and = ([a, b]) => a && b;",
    "const __wm_op_or = ([a, b]) => a || b;",
    "const __wm_op_not = (x) => !x;",
    ...program.order
      .filter((path) => path !== program.entry)
      .map((path) => emitNamespace(program.modules.get(path)!, program)),
    ...emitModuleBody(entry, program),
    `if (typeof ${main} === "function") await ${main}();`,
  ].join("\n");
}

function emitNamespace(artifact: CoreModuleArtifact, program: CoreProgram): string {
  const body = emitModuleBody(artifact, program).join("\n");
  return `const ${id(artifact.emitName)} = (() => {\n${body}\nreturn { ${
    artifact.dynamicExports.map((item) => `${JSON.stringify(item.name)}: ${emitExportRef(item)}`)
      .join(", ")
  } };\n})();`;
}

function emitModuleBody(artifact: CoreModuleArtifact, program: CoreProgram): string[] {
  return [
    ...emitImportAliases(artifact, program),
    ...artifact.module.decls.flatMap((decl) => emitDecl(decl)),
  ];
}

function emitImportAliases(artifact: CoreModuleArtifact, program: CoreProgram): string[] {
  const aliases: string[] = [];
  for (const edge of artifact.imports) {
    const imported = program.modules.get(edge.path)!;
    if (edge.clause.kind === "All") {
      for (const item of imported.dynamicExports) {
        aliases.push(`const ${id(item.name)} = ${id(imported.emitName)}.${id(item.name)};`);
      }
      continue;
    }
    if (edge.clause.kind !== "Named") continue;
    for (const spec of edge.clause.specs) {
      if (imported.dynamicExports.some((item) => item.name === spec.name)) {
        aliases.push(
          `const ${id(spec.alias ?? spec.name)} = ${id(imported.emitName)}.${id(spec.name)};`,
        );
      }
    }
  }
  return aliases;
}

function emitDecl(decl: CoreDecl): string[] {
  if (decl.kind === "CoreImport" || decl.kind === "CoreRecord") return [];
  if (decl.kind === "CoreType") {
    if (decl.alias) return [];
    return decl.ctors.map((ctor) => {
      const ctorId = ctor.id ?? ctor.name;
      return ctor.payload
        ? `const ${id(ctor.name)} = (__payload) => ({ ctor: ${JSON.stringify(ctorId)}, name: ${
          JSON.stringify(ctor.name)
        }, args: [__payload] });`
        : `const ${id(ctor.name)} = Object.freeze({ ctor: ${JSON.stringify(ctorId)}, name: ${
          JSON.stringify(ctor.name)
        }, args: [] });`;
    });
  }
  if (decl.recursive) {
    return decl.bindings.map((binding) => {
      if (binding.pattern.kind !== "CorePVar") {
        throw new Error("recursive bindings must bind one name");
      }
      return `let ${patternBindingName(binding.pattern)} = ${emitExpr(binding.value)};`;
    });
  }
  return decl.bindings.flatMap((binding) => {
    if (binding.pattern.kind === "CorePVar") {
      return [`const ${patternBindingName(binding.pattern)} = ${emitExpr(binding.value)};`];
    }
    const tmp = `__wm_bind_${bindingTemp++}`;
    return [
      `const ${tmp} = ${emitExpr(binding.value)};`,
      ...emitPatternAssert(binding.pattern, tmp, "Bind", "pattern match failure in let binding"),
      ...emitPatternBind(binding.pattern, tmp),
    ];
  });
}

let bindingTemp = 0;

function emitExpr(expr: CoreExpr): string {
  switch (expr.kind) {
    case "CoreInt":
    case "CoreFloat":
      return String(expr.value);
    case "CoreString":
      return JSON.stringify(expr.value);
    case "CoreBool":
      return expr.value ? "true" : "false";
    case "CoreVoid":
      return "undefined";
    case "CoreVar":
      return primitiveName(expr.name) ?? valueRefName(expr.name, expr.bindingId);
    case "CoreTuple":
      return `__wm_tuple(${expr.items.map(emitExpr).join(", ")})`;
    case "CoreRecord":
      return `{ ${
        expr.fields.map((field) => `${id(field.name)}: ${emitExpr(field.value)}`).join(", ")
      } }`;
    case "CoreFn":
      return `(__arg) => {\n${
        emitArmBody(expr.arms, "__arg", "pattern match failure in function")
      }\n}`;
    case "CoreApp":
      return `${emitExpr(expr.callee)}(${emitExpr(expr.arg)})`;
    case "CoreIf":
      return `(${emitExpr(expr.cond)} ? ${emitExpr(expr.thenExpr)} : ${emitExpr(expr.elseExpr)})`;
    case "CoreMatch":
      return `((__v) => {\n${emitArmBody(expr.arms, "__v", "non-exhaustive match")}\n})(${
        emitExpr(expr.value)
      })`;
    case "CoreBlock":
      return `(() => {\n${expr.items.map(emitBlockItem).join("\n")}\nreturn ${
        emitExpr(expr.result)
      };\n})()`;
  }
}

function emitArmBody(arms: CoreMatchArm[], value: string, message: string): string {
  const body = arms.map((arm) => {
    const checks = patternChecks(arm.pattern, value);
    const binds = emitPatternBind(arm.pattern, value);
    return `if (${checks.length ? checks.join(" && ") : "true"}) {\n${binds.join("\n")}\nreturn ${
      emitExpr(arm.body)
    };\n}`;
  });
  return `${body.join(" else ")}\n__wm_fail("Match", ${JSON.stringify(message)});`;
}

function emitBlockItem(item: CoreDecl | CoreExpr): string {
  return isDecl(item) ? emitDecl(item).join("\n") : `${emitExpr(item)};`;
}

function isDecl(value: CoreDecl | CoreExpr): value is CoreDecl {
  return value.kind === "CoreImport" || value.kind === "CoreLet" ||
    value.kind === "CoreType" || value.kind === "CoreRecord";
}

function emitPatternAssert(
  pattern: CorePattern,
  value: string,
  errorName: "Bind" | "Match",
  message: string,
): string[] {
  const checks = patternChecks(pattern, value);
  if (checks.length === 0) return [];
  return [
    `if (!(${checks.join(" && ")})) __wm_fail(${JSON.stringify(errorName)}, ${
      JSON.stringify(message)
    });`,
  ];
}

function patternChecks(pattern: CorePattern, value: string): string[] {
  switch (pattern.kind) {
    case "CorePWildcard":
    case "CorePVar":
      return [];
    case "CorePInt":
      return [`${value} === ${pattern.value}`];
    case "CorePString":
      return [`${value} === ${JSON.stringify(pattern.value)}`];
    case "CorePBool":
      return [`${value} === ${pattern.value ? "true" : "false"}`];
    case "CorePVoid":
      return [`${value} === undefined`];
    case "CorePPinned":
      return [`__wm_eq(${value}, ${valueRefName(pattern.name, pattern.bindingId)})`];
    case "CorePTuple":
      return [
        `Array.isArray(${value})`,
        `${value}.length === ${pattern.items.length}`,
        ...pattern.items.flatMap((item, index) => patternChecks(item, `${value}[${index}]`)),
      ];
    case "CorePRecord":
      return [
        `${value} !== null`,
        `typeof ${value} === "object"`,
        ...pattern.fields.flatMap((field) =>
          patternChecks(field.pattern, `${value}.${id(field.name)}`)
        ),
      ];
    case "CorePCtor": {
      const ctorId = pattern.ctorId ?? pattern.name.split(".").at(-1)!;
      return [
        `${value}?.ctor === ${JSON.stringify(ctorId)}`,
        `${value}.args.length === ${pattern.payload ? 1 : 0}`,
        ...(pattern.payload ? patternChecks(pattern.payload, `${value}.args[0]`) : []),
      ];
    }
  }
}

function emitPatternBind(pattern: CorePattern, value: string): string[] {
  switch (pattern.kind) {
    case "CorePVar":
      return [`const ${patternBindingName(pattern)} = ${value};`];
    case "CorePTuple":
      return pattern.items.flatMap((item, index) => emitPatternBind(item, `${value}[${index}]`));
    case "CorePRecord":
      return pattern.fields.flatMap((field) =>
        emitPatternBind(field.pattern, `${value}.${id(field.name)}`)
      );
    case "CorePCtor":
      return pattern.payload ? emitPatternBind(pattern.payload, `${value}.args[0]`) : [];
    default:
      return [];
  }
}

function emitExportRef(item: CoreDynamicExport): string {
  return item.bindingId === undefined ? id(item.name) : bindingName(item.name, item.bindingId);
}

function mainRef(artifact: CoreModuleArtifact): string {
  for (const decl of artifact.module.decls) {
    if (decl.kind !== "CoreLet") continue;
    for (const binding of decl.bindings) {
      const found = findPatternBinding(binding.pattern, "main");
      if (found !== undefined) return bindingName("main", found);
    }
  }
  return "main";
}

function findPatternBinding(pattern: CorePattern, name: string): BindingId | undefined {
  switch (pattern.kind) {
    case "CorePVar":
      return pattern.name === name ? pattern.bindingId : undefined;
    case "CorePTuple":
      return firstDefined(pattern.items.map((item) => findPatternBinding(item, name)));
    case "CorePRecord":
      return firstDefined(pattern.fields.map((field) => findPatternBinding(field.pattern, name)));
    case "CorePCtor":
      return pattern.payload ? findPatternBinding(pattern.payload, name) : undefined;
    default:
      return undefined;
  }
}

function firstDefined<T>(items: (T | undefined)[]): T | undefined {
  return items.find((item): item is T => item !== undefined);
}

function valueRefName(name: string, bindingId: BindingId | undefined): string {
  return bindingId === undefined ? id(name) : bindingName(name, bindingId);
}

function patternBindingName(pattern: Extract<CorePattern, { kind: "CorePVar" }>): string {
  return pattern.bindingId === undefined
    ? id(pattern.name)
    : bindingName(pattern.name, pattern.bindingId);
}

function bindingName(name: string, bindingId: BindingId): string {
  return `${id(name)}_${bindingId}`;
}

function id(name: string): string {
  if (name.includes(".")) return name.split(".").map(id).join(".");
  return reserved.has(name) ? `_${name}` : name;
}

function primitiveName(name: string): string | undefined {
  switch (name) {
    case "+":
      return "__wm_op_add";
    case "-":
      return "__wm_op_sub";
    case "*":
      return "__wm_op_mul";
    case "/":
      return "__wm_op_div";
    case "%":
      return "__wm_op_mod";
    case "==":
      return "__wm_op_eq";
    case "!=":
      return "__wm_op_ne";
    case "<":
      return "__wm_op_lt";
    case "<=":
      return "__wm_op_lte";
    case ">":
      return "__wm_op_gt";
    case ">=":
      return "__wm_op_gte";
    case "&&":
      return "__wm_op_and";
    case "||":
      return "__wm_op_or";
    case "!":
      return "__wm_op_not";
    default:
      return undefined;
  }
}
