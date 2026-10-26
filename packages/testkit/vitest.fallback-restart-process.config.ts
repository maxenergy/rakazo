import base from "../../vitest.config.js";
export default {
  ...base,
  test: {
    ...base.test,
    include: ["packages/testkit/src/fallback-restart.postgres.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    pool: "forks" as const,
  },
};
