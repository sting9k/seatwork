import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readJson, writeJson } from "../persisted";

/** Who calls the room's MCP server: a nonce given at launch, tied to the seat's id later. */
export class Callers {
  private readonly nonces: Record<string, string>;

  constructor(private readonly file: string) {
    this.nonces = readJson<Record<string, string>>(file, {});
  }

  /** A fresh nonce for a seat about to start. */
  issue(): string {
    return randomBytes(9).toString("base64url");
  }

  bind(nonce: string, agentId: string): void {
    if (this.nonces[nonce] === agentId) return;
    this.nonces[nonce] = agentId;
    this.save();
  }

  seatOf(nonce: string): string | null {
    return this.nonces[nonce] ?? null;
  }

  /** An archived seat can never call again. */
  forget(agentId: string): void {
    const stale = Object.keys(this.nonces).filter((nonce) => this.nonces[nonce] === agentId);
    if (stale.length === 0) return;
    for (const nonce of stale) delete this.nonces[nonce];
    this.save();
  }

  private save(): void {
    writeJson(this.file, this.nonces, 0o600);
  }
}

/** The MCP server's bearer token, made once and kept. */
export function serverToken(file: string): string {
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(18).toString("base64url");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}
