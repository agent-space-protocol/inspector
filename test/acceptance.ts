// Acceptance of the conformance tests: `agent-space check` passes on the test space, and each
// deliberately broken variant is caught by its own test and only by it.
//
//   node test/acceptance.ts [--port 7900]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "../src/check/runner.ts";
import { CAUGHT_BY, VARIANTS } from "../src/test-space/variants.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");
let port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 7900;
let ok = true;

for (const variant of [undefined, ...VARIANTS]) {
  const data = mkdtempSync(join(tmpdir(), "asp-acceptance-"));
  const address = `ws://127.0.0.1:${++port}`;
  const launch = `"${process.execPath}" "${cli}" test-space --listen ${address} --data "${data}" --keep-seconds 3 --close-on-eof${variant ? ` --variant ${variant}` : ""}`;
  const report = await check({ address, launch, quiet: true });
  rmSync(data, { recursive: true, force: true });
  const failed = report.tests.filter((t) => t.status === "fail").map((t) => t.id);
  const skipped = report.tests.filter((t) => t.status === "skip").map((t) => t.id);
  const expected = variant ? [CAUGHT_BY[variant]] : [];
  const good = JSON.stringify(failed) === JSON.stringify(expected) && skipped.length === 0;
  ok &&= good;
  const s = report.summary;
  console.log(
    `${good ? "ok  " : "BAD "} ${(variant ?? "test space").padEnd(20)} ${String(s.passed).padStart(2)} passed, ${s.failed} failed, ${s.skipped} skipped; failed: ${failed.join(", ") || "none"}${variant ? `; expected: ${expected.join(", ")}` : ""}`,
  );
  for (const t of report.tests.filter((x) => x.status === "fail")) for (const n of t.notes) console.log(`       ${t.id}: ${n}`);
}
console.log(ok ? "\nacceptance: every test passes on the test space; every broken variant is caught by its own test only" : "\nacceptance FAILED");
process.exit(ok ? 0 : 1);
