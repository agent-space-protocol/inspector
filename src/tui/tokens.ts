// The semantic colours and symbols of outcomes, intermediate states and event families, shared by
// every client so that what a user learns in one place holds everywhere. The base colours come from
// the archive design (cyan, magenta, the muted and line greys). The outcome colours are temporary
// values, to be reviewed by the maintainer of the archive design before they are added to it.

export interface Token {
  symbol: string;
  hex: string;
  /** The nearest basic ANSI colour, for terminals without true colour. */
  ansi: number;
}

export const OUTCOME: Record<string, Token> = {
  done: { symbol: "✓", hex: "#3ddc97", ansi: 32 },
  refused: { symbol: "⊘", hex: "#f2c14e", ansi: 33 },
  failed: { symbol: "✗", hex: "#ff5d6c", ansi: 31 },
  cancelled: { symbol: "◼", hex: "#8fa3b0", ansi: 90 },
  unknown: { symbol: "?", hex: "#ff2b9f", ansi: 35 },
};

export const STATE: Record<string, Token> = {
  sent: { symbol: "·", hex: "#8fa3b0", ansi: 90 },
  accepted: { symbol: "○", hex: "#04d9ed", ansi: 36 },
  progress: { symbol: "◔", hex: "#04d9ed", ansi: 36 },
  waiting: { symbol: "⧗", hex: "#69a7f3", ansi: 34 },
};

export const EVENT: Record<string, Token> = {
  /** The protocol's own entries: presences, actions, outcomes. */
  protocol: { symbol: "·", hex: "#547383", ansi: 90 },
  /** The space's own events. */
  space: { symbol: "•", hex: "#69e5f3", ansi: 36 },
  /** Changes by participants outside the protocol. */
  outside: { symbol: "◇", hex: "#ff2b9f", ansi: 35 },
};

export const BASE = {
  fg: { hex: "#eaf4f6", ansi: 37 },
  muted: { hex: "#c3d2d9", ansi: 37 },
  line: { hex: "#547383", ansi: 90 },
  accent: { hex: "#69e5f3", ansi: 36 },
};

export function paint(text: string, token: { hex: string; ansi: number } | undefined, mode: "none" | "basic" | "true"): string {
  if (!token || mode === "none") return text;
  if (mode === "basic") return `\x1b[${token.ansi}m${text}\x1b[0m`;
  const n = parseInt(token.hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}\x1b[0m`;
}
