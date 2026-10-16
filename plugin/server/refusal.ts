import type tools from "../shared/tools.json";

type Tools = (typeof tools)["tools"];
type ArgsOf<T extends keyof Tools> = Tools[T] extends { inputSchema: { properties: infer P } } ? keyof P : never;

/** A call a seat can make next: a room tool and its arguments, by the names the tool's schema gives them. */
export type NextCall = { [T in keyof Tools]: { tool: T; args?: { [K in ArgsOf<T>]?: unknown } } }[keyof Tools];

/** A refusal as a seat reads it: code, sentence, whether to retry, what a right call is, and the call to make next. */
export const refusal = (error: {
  code: string;
  message: string;
  retryable: boolean;
  fix?: unknown;
  next?: NextCall;
}): string =>
  JSON.stringify({
    error: { code: error.code, message: error.message, retryable: error.retryable, fix: error.fix, next: error.next },
  });
