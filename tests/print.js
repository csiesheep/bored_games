// node tests/print.js — 印驗收的判決(跟 tests/index.html?json=1 同一份);有失敗就 exit 1。
import "./acceptance.js";
import { R, summary } from "./harness.js";

const s = summary();
console.log(`pass ${s.pass} / fail ${s.fail} / todo ${s.todo}`);
for (const f of s.failures) console.log(`FAIL ${f.label}\n     ${f.msg}`);
for (const t of s.todos) console.log(`TODO ${t.label} — ${t.msg}`);
if (process.argv.includes("--passes")) for (const p of R.pass) console.log(`ok   ${p.label}${p.msg ? " — " + p.msg : ""}`);
process.exit(s.fail ? 1 : 0);
