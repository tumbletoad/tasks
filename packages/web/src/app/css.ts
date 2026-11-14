// A CSS Module's class names, typed by the names a component uses. Vite gives a module as an index
// of every class it defines, which the compiler reads as possibly missing; naming the classes a
// component uses makes each one a string, and a name the module lacks an empty class.
export function classes<const K extends string>(
  module: Readonly<Record<string, string>>,
  names: readonly K[],
): Readonly<Record<K, string>> {
  return Object.fromEntries(names.map((name) => [name, module[name] ?? ""])) as Record<K, string>;
}
