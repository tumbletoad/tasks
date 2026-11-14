// The known sample: the content digest of `seedMira(root, { seed: "fixed", tasks: 3 })`. Tests on
// Windows and Ubuntu assert it, so both prove they build the same space. It changes whenever the
// schema or the generator changes: update it in the same commit.
export const FIXED_SAMPLE = {
  seed: "fixed",
  tasks: 3,
  digest: "53f83dcf55d010e7e42506bf0953c21128644a925cefbba404268c7d778fe1f5",
} as const;

/**
 * The known sample built as a released 0.1 build built it (`steps: STEPS_0_1`, M3.01): the digest
 * the 0.1 builds gave the known sample, unchanged since M2.05. It must never change. A change means
 * the 0.1 fixture builder no longer produces what the 0.1 release produced, so the migration tests
 * that start from it would no longer start from a real 0.1 space: make the builder produce it again
 * (for example by freezing a generator change behind the chain), never update this value. The
 * generator's seed string carries the identifier (`tasks-mira:`, PLAN.md Q).
 */
export const FIXED_SAMPLE_0_1 = {
  seed: "fixed",
  tasks: 3,
  digest: "0034882ffe8c02f6fea0535a662c0742b06cc88718d37e34dfcfebf00ab2dafe",
} as const;

/**
 * The schema of each frozen revision (digestSchema: every table, index and trigger with its SQL),
 * as a space built with that revision's chain has it, created or migrated. The row digests above
 * do not see an index, a CHECK or a foreign key, so these pin what the frozen steps create. They
 * must never change, as their steps never do (migrations/0001-schema-0.1.ts, 0002-schema-0.2.ts,
 * 0003-schema-0.3.ts): a later revision is a new step with its own entry. 0.3 is pinned with its
 * step (M6.01), because the next deploy releases it to real spaces.
 */
export const RELEASED_SCHEMAS = {
  "0.1": "7b2e6d9cb39d8656a869e083219109f903fecdcc83bee5c3caa3ead6140afbb0",
  "0.2": "19ee58deae2331a9648ea25c4c8b23b9813f3ca07e16d939105e39655336ac7b",
  "0.3": "8dec19e6dbb8532d468e6b6dc7ae4ef71956ce5687e5bc79f80db7d7adc6c741",
} as const;
