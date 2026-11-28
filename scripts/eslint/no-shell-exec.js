// ESLint rule ttasks/no-shell-exec: refuses exec and execSync from child_process, which always run
// a shell. It follows the module through every way it can be bound statically: named,
// aliased, default (`import cp`, `import { default as cp }`) and namespace imports,
// `import x = require()`, require(), await import(), re-exports, destructuring (including
// `{ default: cp }`), `.default` access and plain aliases (`const c = cp`). Only bindings of
// child_process count, so RegExp.prototype.exec, DatabaseSync.exec and other .exec methods are
// never reported.
//
// require() counts as the loader only when it is Node's: an undeclared or configured global
// `require`, or a local one made by createRequire(). A local function or import named `require`
// is something else.

const MODULES = new Set(["child_process", "node:child_process"]);
const BANNED = new Set(["exec", "execSync"]);

/** The value of a string literal or a template literal without expressions, else undefined. */
function staticString(/** @type {any} */ node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

const isModuleName = (/** @type {any} */ node) => MODULES.has(staticString(node) ?? "");

/** The static name of a property key or member property, else undefined. */
function keyName(/** @type {any} */ key, computed = false) {
  if (!computed && key?.type === "Identifier") return key.name;
  return staticString(key);
}

/** Strips wrappers that do not change the value: await, TypeScript casts and `!`. */
function unwrap(/** @type {any} */ node) {
  let n = node;
  while (
    n?.type === "AwaitExpression" ||
    n?.type === "TSAsExpression" ||
    n?.type === "TSSatisfiesExpression" ||
    n?.type === "TSNonNullExpression" ||
    n?.type === "TSTypeAssertion"
  ) {
    n = n.type === "AwaitExpression" ? n.argument : n.expression;
  }
  return n;
}

/** True for a call of createRequire(...) or x.createRequire(...). */
function isCreateRequireCall(/** @type {any} */ node) {
  const n = unwrap(node);
  if (n?.type !== "CallExpression") return false;
  const callee = n.callee;
  return (
    (callee.type === "Identifier" && callee.name === "createRequire") ||
    (callee.type === "MemberExpression" &&
      keyName(callee.property, callee.computed) === "createRequire")
  );
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Refuse exec and execSync from child_process (A4)." },
    schema: [],
    messages: {
      exec: "exec and execSync run a shell (A4). Use execFile or spawn with an argument array.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    /** Variables bound to the child_process module. */
    const moduleVars = new Set();
    /** @type {any[]} Variable declarators, resolved at the end once every binding is known. */
    const declarators = [];
    /** @type {any[]} Member expressions that read exec or execSync. */
    const reads = [];

    const report = (/** @type {any} */ node) => {
      context.report({ node, messageId: "exec" });
    };
    const bindAll = (/** @type {any} */ node) => {
      for (const v of sourceCode.getDeclaredVariables(node)) moduleVars.add(v);
    };
    /** Resolves an identifier to its variable by lexical scope, or undefined for a global. */
    const resolve = (/** @type {any} */ ident) => {
      for (let s = sourceCode.getScope(ident); s; s = s.upper) {
        const v = s.set.get(ident.name);
        if (v) return v;
      }
      return undefined;
    };

    /** True when calling this identifier loads a module the way Node's require does. */
    const isRequire = (/** @type {any} */ ident) => {
      const variable = resolve(ident);
      // Undeclared, or a configured global such as `require` in CommonJS files.
      if (variable === undefined || variable.defs.length === 0) return ident.name === "require";
      // A local made by createRequire(), under any name.
      return variable.defs.some(
        (/** @type {any} */ d) => d.type === "Variable" && isCreateRequireCall(d.node.init),
      );
    };

    /** True when the expression evaluates to the child_process module, as far as is known now. */
    const isModule = (/** @type {any} */ node) => {
      const n = unwrap(node);
      if (n?.type === "ImportExpression") return isModuleName(n.source);
      if (n?.type === "CallExpression") {
        return (
          n.callee.type === "Identifier" && isRequire(n.callee) && isModuleName(n.arguments[0])
        );
      }
      if (n?.type === "Identifier") return moduleVars.has(resolve(n));
      if (n?.type === "MemberExpression") {
        return keyName(n.property, n.computed) === "default" && isModule(n.object);
      }
      return false;
    };

    /** Walks a pattern destructured from the module: reports exec keys, binds default keys. */
    const destructure = (/** @type {any} */ pattern) => {
      for (const p of pattern.properties) {
        if (p.type !== "Property") continue;
        const key = keyName(p.key, p.computed);
        if (BANNED.has(key ?? "")) {
          report(p);
        } else if (key === "default") {
          const target = p.value.type === "AssignmentPattern" ? p.value.left : p.value;
          if (target.type === "Identifier") {
            const v = resolve(target);
            if (v) moduleVars.add(v);
          } else if (target.type === "ObjectPattern") {
            destructure(target);
          }
        }
      }
    };

    return {
      ImportDeclaration(node) {
        if (!isModuleName(node.source)) return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") {
            bindAll(spec);
            continue;
          }
          const imported = keyName(spec.imported);
          if (imported === "default") bindAll(spec);
          else if (BANNED.has(imported ?? "")) report(spec);
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source || !isModuleName(node.source)) return;
        for (const spec of node.specifiers) {
          if (BANNED.has(keyName(spec.local) ?? "")) report(spec);
        }
      },
      ExportAllDeclaration(node) {
        if (isModuleName(node.source)) report(node);
      },
      /** @param {any} node TypeScript `import cp = require("child_process")`. */
      TSImportEqualsDeclaration(node) {
        const ref = node.moduleReference;
        if (ref.type === "TSExternalModuleReference" && isModuleName(ref.expression)) bindAll(node);
      },
      VariableDeclarator(node) {
        if (node.init) declarators.push(node);
      },
      MemberExpression(node) {
        if (BANNED.has(keyName(node.property, node.computed) ?? "")) reads.push(node);
      },
      "Program:exit"() {
        // A declarator can depend on another one (aliases of aliases, a default destructured
        // from a namespace), so bind until nothing changes. Each declarator is handled once.
        const pending = new Set(declarators);
        for (let changed = true; changed;) {
          changed = false;
          for (const d of pending) {
            if (!isModule(d.init)) continue;
            pending.delete(d);
            changed = true;
            if (d.id.type === "ObjectPattern") destructure(d.id);
            else if (d.id.type === "Identifier") bindAll(d);
          }
        }
        for (const read of reads) {
          if (isModule(read.object)) report(read);
        }
      },
    };
  },
};
