import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { call } from "../server/jev/client";
import { DecisionError, type Questions } from "../server/jev/contract";
import { Jev, type JevPolicy, type ProviderName } from "../server/jev/index";

shipSql();

const QUESTIONS: Questions = {
  ran: {
    type: "noul",
    instructions: "Did the seat run its tests after its last edit?",
    criteria: { true: "it ran them" },
  },
  lane: {
    type: "choice",
    instructions: "Which part of the brief is this?",
    criteria: { scope: null, outcome: "the goal" },
  },
  size: { type: "score", instructions: "How large is the change?", criteria: ["small", "medium", "large"] },
};

/** The answers a System One provider gives to QUESTIONS. */
const SYSTEM_ONE = {
  ran: { type: "noul", noul: 0.2 },
  lane: { type: "choice", choice: "scope", probabilities: { scope: 0.7, outcome: 0.3 }, confidence: 0.4 },
  size: {
    type: "score",
    score: 0.5,
    legend: { "0": "small", "1": "medium", "2": "large" },
    probabilities: { "0": 0.6, "1": 0.3, "2": 0.1 },
    confidence: 0.5,
  },
};

/** The same answers as OpenAI's Decisions give them. */
const OPENAI = [
  { type: "predicate", name: "ran", probability: 0.2 },
  {
    type: "choice",
    name: "lane",
    choice: "scope",
    probabilities: [
      { value: "scope", probability: 0.7 },
      { value: "outcome", probability: 0.3 },
    ],
    confidence: 0.4,
  },
  {
    type: "score",
    name: "size",
    score: 0.5,
    probabilities: [
      { value: 0, label: "small", probability: 0.6 },
      { value: 1, label: "medium", probability: 0.3 },
      { value: 2, label: "large", probability: 0.1 },
    ],
    confidence: 0.5,
  },
];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fetch that answers with `replies` in turn and keeps what it was sent. */
function provider(...replies: (Response | (() => Response))[]) {
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const send = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = replies.shift() ?? json({ error: "no reply left" }, 500);
    return typeof next === "function" ? next() : next;
  }) as typeof globalThis.fetch;
  return { fetch: send, sent };
}

const POLICY = (provider: ProviderName, cap = 10): JevPolicy => ({
  provider,
  providers: {
    jev: {
      url: "https://ts.test/v1/systemone",
      model: "jev-1.13.0",
      dialect: "systemone",
      usdPerMillionInput: 0.042,
    },
    openrouter: {
      url: "https://or.test/api/alpha/decisions",
      model: "typesafe/jev-1.13",
      dialect: "openrouter",
      usdPerMillionInput: 0.042,
    },
    custom: {
      url: "http://127.0.0.1:8000/v1/decisions",
      model: "qwen",
      dialect: "openai-decisions",
      usdPerMillionInput: 0,
    },
  },
  monthlyCapUsd: cap,
  attemptSeconds: 1,
  retries: 2,
  keepDays: 90,
});

let homes = 0;
/** A district with its own folder, a key for each provider unless `keys` is false. */
function district(policy: JevPolicy | undefined, fetch: typeof globalThis.fetch, keys = true) {
  const dir = join(ROOM_HOME, `jev-${(homes += 1)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (keys) for (const name of ["jev", "openrouter"]) writeFileSync(join(dir, `${name}.key`), `key-${name}\n`);
  return { jev: new Jev({ dir, policy: () => policy, fetch, env: {} }), dir };
}

test("each provider is sent its own request and read into one shape of answers", async () => {
  const typesafe = provider(
    json({ model: "jev-1.13.0", answers: SYSTEM_ONE, usage: { input_tokens: 1000, output_tokens: 0 } }),
  );
  const direct = await district(POLICY("jev"), typesafe.fetch).jev.decide("claims", { said: "done" }, QUESTIONS);
  assert.equal(typesafe.sent[0].headers.Authorization, "Bearer key-jev");
  assert.deepEqual(Object.keys(typesafe.sent[0].body).sort(), ["model", "questions", "state"]);
  assert.equal(direct.usd, 0.000042, "TypeSafe names no cost: it is priced from the tokens");

  const router = provider(
    json({ model: "typesafe/jev-1.13-20260917", answers: SYSTEM_ONE, usage: { input_tokens: 1000, cost: 0.00005 } }),
  );
  const routed = await district(POLICY("openrouter"), router.fetch).jev.decide("claims", { said: "done" }, QUESTIONS);
  assert.deepEqual(router.sent[0].body.provider, { zdr: true, data_collection: "deny" });
  assert.deepEqual([routed.model, routed.usd], ["typesafe/jev-1.13-20260917", 0.00005]);

  const openai = provider(json({ model: "qwen", answers: OPENAI, usage: { input_tokens: 900, output_tokens: 3 } }));
  const own = await district(POLICY("custom"), openai.fetch, false).jev.decide("claims", { said: "done" }, QUESTIONS);
  const asked = openai.sent[0].body as { input: string; questions: Record<string, unknown>[] };
  assert.equal(openai.sent[0].headers.Authorization, undefined, "a local endpoint is asked without a key");
  assert.equal(asked.input, '{"said":"done"}');
  assert.deepEqual(asked.questions[0], {
    type: "predicate",
    name: "ran",
    instructions: "Did the seat run its tests after its last edit?\nYes means: it ran them",
  });
  assert.deepEqual(asked.questions[2], {
    type: "score",
    name: "size",
    instructions: "How large is the change?",
    levels: [{ label: "small" }, { label: "medium" }, { label: "large" }],
  });
  assert.equal(own.usd, null, "an endpoint with no price and no reported cost costs nothing known");

  for (const decision of [direct, routed, own]) assert.deepEqual(decision.answers, SYSTEM_ONE);
});

test("a call retries what may pass, stops at what will not, and never outlives its deadline", async () => {
  const options = { attemptMs: 100, retries: 2, deadlineMs: 2000, sleep: async () => {} };
  const ok = () => json({ model: "m", answers: { ran: { type: "noul", noul: 1 } }, usage: {} });
  const one: Questions = { ran: QUESTIONS.ran };
  const wire = { url: "https://ts.test/v1/systemone", model: "m" };

  const busy = provider(json({}, 429, { "retry-after": "0" }), json({}, 503), ok);
  assert.equal((await call("systemone", wire, "s", one, { ...options, fetch: busy.fetch })).attempts, 3);

  for (const [replies, sends, status] of [
    [[json({}, 500), json({}, 502), json({}, 503), ok], 3, 503],
    [[json({ error: "bad" }, 400), ok], 1, 400],
    [[json({}, 402), ok], 1, 402],
  ] as const) {
    const failing = provider(...replies);
    const error = await call("systemone", wire, "s", one, { ...options, fetch: failing.fetch }).catch((e) => e);
    assert.deepEqual([error.code, error.status, failing.sent.length], ["HTTP", status, sends]);
  }
  const refilling = provider(json({}, 402, { "retry-after": "1" }), ok);
  assert.equal((await call("systemone", wire, "s", one, { ...options, fetch: refilling.fetch })).attempts, 2);

  const wrong = provider(json({ model: "m", answers: { ran: { type: "choice", choice: "x" } } }), ok);
  await assert.rejects(call("systemone", wire, "s", one, { ...options, fetch: wrong.fetch }), { code: "CONTRACT" });
  assert.equal(wrong.sent.length, 1, "a reply off the contract is not asked again");

  const stalls = (async (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) =>
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
    )) as typeof fetch;
  const started = Date.now();
  await assert.rejects(
    call("systemone", wire, "s", one, { attemptMs: 50, retries: 5, deadlineMs: 300, fetch: stalls }),
    { code: "TIMEOUT" },
  );
  assert.ok(Date.now() - started < 1000, "the deadline holds across retries and backoff");
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 20);
  await assert.rejects(
    call("systemone", wire, "s", one, { ...options, attemptMs: 1000, fetch: stalls, signal: cancel.signal }),
    { code: "ABORTED" },
  );
});

test("a call leaves no listener on a signal that outlives it, and refuses a reply past its size unread", async () => {
  const room = new AbortController();
  const wire = { url: "https://ts.test/v1/systemone", model: "m" };
  const one: Questions = { ran: QUESTIONS.ran };
  const options = { attemptMs: 100, retries: 0, deadlineMs: 1000, signal: room.signal };
  for (let i = 0; i < 50; i += 1) {
    const reply = provider(i % 2 ? json({ model: "m", answers: { ran: { type: "noul", noul: 1 } } }) : json({}, 400));
    await call("systemone", wire, "s", one, { ...options, fetch: reply.fetch }).catch(() => {});
  }
  assert.equal(getEventListeners(room.signal, "abort").length, 0);

  const huge = provider(() => new Response(`{"model":"${"x".repeat(3 * 1024 * 1024)}"}`, { status: 200 }));
  await assert.rejects(call("systemone", wire, "s", one, { ...options, fetch: huge.fetch }), /larger than/);
  assert.equal(huge.sent.length, 1);
});

test("a request no provider would take is refused before anything is sent", async () => {
  const none = provider();
  const { jev } = district(POLICY("custom"), none.fetch, false);
  const cases: [Questions, string, string][] = [
    [{}, "{}", "INVALID"],
    [{ one: { type: "choice", instructions: "pick", criteria: { only: null } } }, "{}", "INVALID"],
    [
      { big: { type: "score", instructions: "rate", criteria: Array.from({ length: 11 }, (_, i) => `${i}`) } },
      "{}",
      "INVALID",
    ],
    [{ ran: QUESTIONS.ran }, "x".repeat(140_000), "TOO_LARGE"],
  ];
  for (const [questions, state, code] of cases)
    await assert.rejects(jev.decide("t", state, questions), { code }, JSON.stringify(questions).slice(0, 60));
  assert.equal(none.sent.length, 0);
});

test("the district is off without a provider or a key, and stops at the month's cap", async () => {
  const none = provider();
  await assert.rejects(district(undefined, none.fetch).jev.decide("t", "s", QUESTIONS), { code: "OFF" });
  const keyless = district(POLICY("openrouter"), none.fetch, false);
  await assert.rejects(keyless.jev.decide("t", "s", QUESTIONS), (error: DecisionError) => {
    assert.equal(error.code, "NO_KEY");
    assert.ok(error.message.includes(join(keyless.dir, "openrouter.key")));
    return true;
  });

  const costly = () => json({ model: "m", answers: SYSTEM_ONE, usage: { input_tokens: 10, cost: 0.6 } });
  const capped = provider(costly, costly, costly);
  const { jev } = district(POLICY("openrouter", 1), capped.fetch);
  await jev.decide("t", "s", QUESTIONS);
  await jev.decide("t", "s", QUESTIONS);
  await assert.rejects(jev.decide("t", "s", QUESTIONS), { code: "CAP" });
  assert.deepEqual([capped.sent.length, jev.spent().usd], [2, 1.2]);
  jev.close();
});

test("what is sent and logged has its secrets hidden; old states go, answers and labels stay", async () => {
  const replies = provider(
    json({ model: "m", answers: SYSTEM_ONE, usage: { input_tokens: 5 } }),
    json({ error: "bad request" }, 400),
  );
  let now = new Date("2026-10-14T10:00:00Z");
  const dir = join(ROOM_HOME, "jev-log");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "jev.key"), "k");
  const jev = new Jev({ dir, policy: () => POLICY("jev"), fetch: replies.fetch, env: {}, now: () => now });
  const secret = "sk-proj-0123456789abcdef0123456789";
  const decision = await jev.decide("claims", { said: `ran with OPENROUTER_API_KEY=${secret}` }, QUESTIONS);
  assert.ok(!JSON.stringify(replies.sent[0].body).includes(secret), "the secret did not leave the machine");
  const kept = (jev.store() as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
  const texts = () => kept.prepare("SELECT text FROM states").all() as { text: string }[];
  assert.ok(texts().length === 1 && !texts()[0].text.includes(secret), "nor was it logged");
  await assert.rejects(jev.decide("claims", "s", QUESTIONS), { code: "HTTP" });
  assert.deepEqual(
    kept
      .prepare("SELECT attempts, substr(error, 1, 8) AS error FROM calls WHERE error IS NOT NULL")
      .all()
      .map((row) => ({ ...(row as object) })),
    [{ attempts: 1, error: "HTTP: HT" }],
  );

  assert.ok(jev.label(decision.asks.ran, "lead-rejected", "true"));
  assert.equal(jev.label(999_999, "owner", "false"), false);
  now = new Date("2026-10-20T10:00:00Z");
  assert.equal(jev.expire(new Date("2026-10-17T00:00:00Z")), 1);
  assert.deepEqual(
    [
      texts().length,
      kept.prepare("SELECT question FROM asks").all().length,
      kept.prepare("SELECT 1 FROM labels").all().length,
    ],
    [0, 3, 1],
  );
  jev.close();
});

test("calls no label holds go in slices once past their days; labeled ones and the month's spending stay", () => {
  let now = new Date("2026-07-01T00:00:00Z");
  const dir = join(ROOM_HOME, "jev-keep");
  rmSync(dir, { recursive: true, force: true });
  const jev = new Jev({ dir, policy: () => POLICY("jev"), env: {}, now: () => now });
  const store = jev.store();
  store.record(
    {
      caller: "t",
      provider: "jev",
      modelAsked: "m",
      model: "m",
      stateHash: null,
      inputTokens: 1,
      outputTokens: 0,
      usd: 0.5,
      usdSource: "price",
      latencyMs: 1,
      attempts: 1,
      error: null,
    },
    { ran: { type: "noul", noul: 0.4 } },
  );
  const db = (store as unknown as { db: DatabaseSync }).db;
  const addCall = db.prepare(
    "INSERT INTO calls (at, caller, provider, model_asked, latency_ms, attempts) VALUES (?, 't', 'jev', 'm', 1, 1)",
  );
  const addAsk = db.prepare(
    "INSERT INTO asks (call_id, question, type, value, answer) VALUES (?, 'ran', 'noul', 0.4, '{}')",
  );
  const labelled: number[] = [];
  db.exec("BEGIN");
  for (let i = 0; i < 4500; i += 1) {
    const ask = addAsk.run(addCall.run(now.toISOString()).lastInsertRowid);
    if (i % 1000 === 0) labelled.push(Number(ask.lastInsertRowid));
  }
  db.exec("COMMIT");
  for (const id of labelled) assert.ok(jev.label(id, "owner", "true"));

  now = new Date("2026-10-15T00:00:00Z");
  assert.equal(jev.expire(now), 4501 - labelled.length);
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.deepEqual([count("calls"), count("asks"), count("labels")], [5, 5, 5]);
  assert.equal(store.spent("2026-07"), 0.5, "the month's spending outlives its calls");
  jev.close();
});

test("every statement the decision log runs uses an index", async () => {
  const replies = provider(json({ model: "m", answers: SYSTEM_ONE, usage: {} }));
  const { jev } = district(POLICY("jev"), replies.fetch);
  const decision = await jev.decide("t", "s", QUESTIONS);
  jev.spent();
  jev.label(decision.asks.ran, "owner", "true");
  jev.expire(new Date());
  const scans = jev
    .store()
    .plans()
    .filter(({ plan }) => /\bSCAN (calls|asks|states|labels|spend|[cal])\b(?! USING)/.test(plan));
  assert.deepEqual(scans, []);
  jev.close();
});
