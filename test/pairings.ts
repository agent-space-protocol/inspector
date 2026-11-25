// The four pairings of SDKs: the TypeScript and Python test spaces, each checked with
// `agent-space check`, and each entered by the TypeScript and the Python test participant.
//
//   node test/pairings.ts [--python <python with agent-space-protocol installed>]
//
// The Python SDK is looked for next to this repository (../python-sdk/.venv) by default.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { check } from "../src/check/runner.ts";
import { runTestParticipant } from "../src/test-participant/participant.ts";

const here = join(import.meta.dirname, "..");
const venv = resolve(here, "..", "python-sdk", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const pyArg = process.argv.indexOf("--python");
const python = pyArg > 0 ? process.argv[pyArg + 1] : venv;
if (!existsSync(python)) {
  console.error(`no Python with the SDK at ${python}; pass --python`);
  process.exit(2);
}
const cli = join(here, "src", "cli.ts");
const spaces = {
  typescript: (address: string, data: string) => `"${process.execPath}" "${cli}" test-space --listen ${address} --data "${data}" --keep-seconds 3 --close-on-eof`,
  python: (address: string, data: string) => `"${python}" -m agent_space.testing test-space --listen ${address} --data "${data}" --keep-seconds 3 --close-on-eof`,
};

function startSpace(command: string): Promise<ChildProcess> {
  return new Promise((resolveStart, reject) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "ignore"] });
    child.stdout!.once("data", () => resolveStart(child));
    child.once("exit", (code) => reject(new Error(`the space exited with ${code}`)));
  });
}

function stop(child: ChildProcess) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

function pythonParticipant(address: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    const child = spawn(python, ["-m", "agent_space.testing", "participant", address], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => done({ ok: code === 0, out }));
  });
}

let port = 7950;
let ok = true;
for (const [name, make] of Object.entries(spaces)) {
  const data = mkdtempSync(join(tmpdir(), "asp-pairing-"));
  const address = `ws://127.0.0.1:${++port}`;
  console.log(`\n== ${name} test space: agent-space check`);
  const report = await check({ address, launch: make(address, data) });
  ok &&= report.summary.failed === 0 && report.summary.skipped === 0;
  rmSync(data, { recursive: true, force: true });

  const data2 = mkdtempSync(join(tmpdir(), "asp-pairing-"));
  const address2 = `ws://127.0.0.1:${++port}`;
  const child = await startSpace(make(address2, data2));
  console.log(`\n== typescript test participant × ${name} test space`);
  const tsOk = await runTestParticipant(address2);
  console.log(`\n== python test participant × ${name} test space`);
  const py = await pythonParticipant(address2);
  process.stdout.write(py.out);
  ok &&= tsOk && py.ok;
  stop(child);
  rmSync(data2, { recursive: true, force: true });
}
console.log(ok ? "\npairings: both test spaces pass every conformance test; all four participant × space pairings pass" : "\npairings FAILED");
process.exit(ok ? 0 : 1);
