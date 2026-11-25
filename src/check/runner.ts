// `agent-space check`: runs the conformance tests against a space and reports each as passed,
// failed or skipped, as text and as JSON.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "./client.ts";
import { Findings, Skip, TESTS, type Context, type Launcher, type Profile, type Verdict } from "./tests.ts";

export interface CheckOptions {
  address: string;
  profile?: string;
  launch?: string;
  json?: string;
  only?: string[];
  quiet?: boolean;
  color?: boolean;
}

export interface Report {
  space: string;
  address: string;
  server?: unknown;
  time: string;
  summary: { passed: number; failed: number; skipped: number };
  tests: ({ id: string; what: string; ms: number } & Verdict)[];
}

function isUrl(address: string): boolean {
  return /^(wss?|https?):\/\//.test(address);
}

class ProcessLauncher implements Launcher {
  #command: string;
  #address: string;
  #child?: ChildProcess;
  constructor(command: string, address: string) {
    this.#command = command;
    this.#address = address;
  }
  async start(): Promise<void> {
    const child = spawn(this.#command, { shell: true, stdio: ["pipe", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    this.#child = child;
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d));
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`the space exited with ${child.exitCode}: ${stderr.trim()}`);
      try {
        const c = await Client.open(this.#address);
        c.close();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error(`the space did not accept connections at ${this.#address} within 20 s`);
  }
  async kill(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid!, "SIGKILL");
    await exited;
  }
  async closeGracefully(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.stdin?.end();
    const t = setTimeout(() => void this.kill(), 15000);
    await exited;
    clearTimeout(t);
    // A shell may leave the space's process behind; make sure nothing keeps the address.
    await this.kill();
  }
}

export async function check(options: CheckOptions): Promise<Report> {
  const launcher = options.launch ? new ProcessLauncher(options.launch, options.address) : undefined;
  if (launcher) await launcher.start();
  const shared = isUrl(options.address);
  try {
    const first = await Client.open(options.address);
    const hello = await first.handshake();
    first.close();
    const profile: Profile = options.profile ? JSON.parse(readFileSync(options.profile, "utf8")) : (hello["inspector.profile"] ?? {});
    const clients: Client[] = [];
    const ctx: Context = {
      address: options.address,
      hello,
      profile,
      launcher,
      shared,
      async client(o = {}) {
        const c = await Client.open(options.address);
        clients.push(c);
        await c.handshake({ key: o.key, parts: o.parts });
        return c;
      },
      async joined(role, o = {}) {
        const c = await ctx.client({ key: o.key });
        await c.join(role ?? profile.role ? { role: role ?? profile.role } : {});
        return c;
      },
    };
    const ordered = [...TESTS.filter((t) => !t.launch), ...TESTS.filter((t) => t.launch)].filter((t) => !options.only || options.only.includes(t.id));
    const report: Report = {
      space: hello.space,
      address: options.address,
      server: hello.server,
      time: new Date().toISOString(),
      summary: { passed: 0, failed: 0, skipped: 0 },
      tests: [],
    };
    for (const t of ordered) {
      const start = Date.now();
      const f = new Findings();
      let verdict: Verdict;
      if (t.launch && !launcher) verdict = { status: "skip", notes: ["needs --launch, so that the runner can close and kill the space"] };
      else if (t.shared && !shared) verdict = { status: "skip", notes: ["needs several connections to one space; give a ws:// or http:// address"] };
      else {
        try {
          await withTimeout(t.run(ctx, f), 90000, t.id);
          verdict = { status: f.failures.length ? "fail" : "pass", notes: [...f.failures, ...f.notes] };
        } catch (e) {
          if (e instanceof Skip) verdict = { status: "skip", notes: [e.message] };
          else verdict = { status: "fail", notes: [...f.failures, `stopped: ${(e as Error).message}`] };
        }
      }
      for (const c of clients.splice(0)) if (!c.closed) c.close();
      const entry = { id: t.id, what: t.what, ms: Date.now() - start, ...verdict };
      report.tests.push(entry);
      report.summary[verdict.status === "pass" ? "passed" : verdict.status === "fail" ? "failed" : "skipped"]++;
      if (!options.quiet) printLine(entry, options.color ?? process.stdout.isTTY);
    }
    if (!options.quiet) {
      const s = report.summary;
      process.stdout.write(`\n${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped against ${hello.space}\n`);
    }
    if (options.json) writeFileSync(options.json, JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    await launcher?.kill();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not finish in ${ms / 1000} s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

const MARK = { pass: "✓", fail: "✗", skip: "–" };
const COLOR = { pass: "\x1b[32m", fail: "\x1b[31m", skip: "\x1b[90m" };

function printLine(t: { id: string; what: string; ms: number } & Verdict, color: boolean): void {
  const c = (s: string) => (color ? `${COLOR[t.status]}${s}\x1b[0m` : s);
  process.stdout.write(`${c(MARK[t.status])} ${t.status.padEnd(4)} ${t.id.padEnd(26)} ${t.what}${color ? "" : ""} (${(t.ms / 1000).toFixed(1)} s)\n`);
  for (const n of t.notes) process.stdout.write(`         ${c("·")} ${n}\n`);
}
