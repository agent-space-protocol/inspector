// `agent-space test-space`: runs the test space, or one of its broken variants.
import { listen } from "@agent-space-protocol/sdk/transport";
import { loadOrCreateKey } from "@agent-space-protocol/sdk/identity";
import { join } from "node:path";
import { createTestSpace } from "./space.ts";
import { breakConnection, VARIANTS, type Variant } from "./variants.ts";

export interface TestSpaceArgs {
  listen: string;
  data?: string;
  keepSeconds?: number | null;
  grace?: number;
  variant?: string;
  closeOnEof?: boolean;
  doorTo?: string;
  doorSpace?: string;
}

export async function runTestSpace(args: TestSpaceArgs): Promise<void> {
  if (args.variant && !VARIANTS.includes(args.variant as Variant)) throw new Error(`no variant ${args.variant}; there are ${VARIANTS.join(", ")}`);
  const variant = args.variant as Variant | undefined;
  const space = createTestSpace({
    data: args.data,
    keepSeconds: args.keepSeconds,
    grace: args.grace,
    key: args.data ? loadOrCreateKey(join(args.data, "space.key")) : undefined,
    doorTo: args.doorTo,
    doorSpace: args.doorSpace,
    halfCommit: variant === "half-commit",
  });
  const stdio = args.listen === "stdio";
  const l = await listen(args.listen, (conn) => space.accept(breakConnection(conn, variant, () => space.head)));
  const log = (line: string) => process.stderr.write(line + "\n");
  log(`test space ${space.id}${variant ? ` (broken: ${variant})` : ""} at ${l.address}`);
  if (!stdio) process.stdout.write(l.address + "\n");
  const close = async () => {
    await space.close();
    await l.close();
    process.exit(0);
  };
  if (stdio || args.closeOnEof) {
    process.stdin.on("end", close);
    process.stdin.resume();
  }
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
