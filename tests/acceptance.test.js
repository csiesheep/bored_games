// `npm test` 的入口:驗收有任何一列失敗就紅。尚未實作的列不算失敗。
import test from "node:test";
import assert from "node:assert";
import "./acceptance.js";
import { summary } from "./harness.js";

test("acceptance: 沒有失敗的列", () => {
  const s = summary();
  assert.ok(s.pass > 0, "一列都沒跑到");
  assert.equal(s.fail, 0, JSON.stringify(s.failures, null, 1));
});
