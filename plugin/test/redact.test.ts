import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSecret, redact } from "../server/redact";
import { fastestInTurns } from "./support/timing";

// built from parts so the fake keys never sit whole in the source, where a push's secret scan would stop them
const FAKE_STRIPE = ["51HxQwErTyUiOp", "0987654321"].join("");

const HIDDEN: [string, string, string][] = [
  ["auth header", "curl -H 'Authorization: Bearer abc.def.ghi' https://x", "abc.def.ghi"],
  ["password in a URL", "git clone https://me:hunter2@host/x", "hunter2"],
  ["password flag", "tool --password s3cret", "s3cret"],
  ["upper-case key variable", "OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa node x.js", "sk-proj-aaaa"],
  ["GitHub token", "push with ghp_aaaaaaaaaaaaaaaaaaaaaaaa", "ghp_aaaa"],
  ["Stripe live key", `charge with sk_live_${FAKE_STRIPE}`, "sk_live_51Hx"],
  ["Stripe key under an odd name", `STRIPE_SK=rk_live_${FAKE_STRIPE}`, "rk_live_51Hx"],
  ["npm token", "//registry.npmjs.org/:_authToken=npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", "npm_A1b2"],
  ["Google access token", "token ya29.a0AfH6SMBx1234567890abcdefghij", "ya29.a0AfH6"],
  ["SendGrid key", "SG.abcdefghijklmnop1234.qrstuvwxyz0123456789ABCD", "SG.abcdefgh"],
  ["Hugging Face token", "hf_AbCdEfGhIjKlMnOpQrStUvWxYz123456", "hf_AbCdEf"],
  ["AWS secret, lower-case name", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["app secret in quotes", "app_secret = 'q8Zr2LmN0pX4'", "q8Zr2LmN0pX4"],
  ["JSON token field", '{"access_token": "Zx9Qw8Er7Ty6Ui5Op4"}', "Zx9Qw8Er7Ty6Ui5Op4"],
  ["generated value under any name", "SESSION_SALT=zQ9mK2pL7xR4vT8nW3yB6cF1", "zQ9mK2pL7xR4"],
  [
    "hex value under any name",
    "DEPLOY_HASH=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "9f86d0818",
  ],
  ["password said in words", "the staging password is hunter2", "hunter2"],
  ["password said in Vietnamese", "mật khẩu staging là hunter2", "hunter2"],
  ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
  ["mysql password", "mysql -u root -phunter2 db", "hunter2"],
  ["short password in a field", "password: hunter2", "hunter2"],
  ["password in a query string", "https://x/login?password=hunter2&next=/", "hunter2"],
  ["password with no user in a URL", "redis://:pw1234@cache:6379", "pw1234"],
  ["bare token variable", "export TOKEN=abcdef123", "abcdef123"],
  ["password typed with a colon in Vietnamese", "mật khẩu: hunter2", "hunter2"],
  ["password typed without accents", "mat khau db: hunter2", "hunter2"],
  ["curl user and password", "curl -u admin:s3cretpw https://x", "s3cretpw"],
  ["sshpass", "sshpass -p hunter2 ssh box", "hunter2"],
  ["npm auth token", "npm config set //registry.npmjs.org/:_authToken abcd1234efgh", "abcd1234efgh"],
  ["bare bearer token", "send Bearer abcdefghijklmnopqrstuvwxyz0123", "abcdefghijklmnop"],
  ["AWS key with a tail", "AKIAIOSFODNN7EXAMPLE_backup", "AKIAIOSFODNN7EXAMPLE"],
];

const KEPT: [string, string][] = [
  ["a type annotation", "password: string"],
  ["a function call", "const token = getToken(user)"],
  ["a path", "PATH=/usr/local/bin:/usr/bin"],
  ["a plain setting", "NODE_ENV=production"],
  ["a word value", "LOG_LEVEL=information-and-above-everything"],
  ["prose about tokens", "the tokenizer splits text into tokens before the secret sauce runs"],
  ["a commit hash in prose", "reverted 9128f78 and moved on"],
];

test("every known kind of secret is hidden", () => {
  for (const [what, text, secret] of HIDDEN) assert.ok(!redact(text).includes(secret), `${what}: ${redact(text)}`);
});

test("text that only looks near a secret is kept as it was", () => {
  for (const [what, text] of KEPT) assert.equal(redact(text), text, what);
});

test("a long record entry is redacted in a few milliseconds per kilobyte at most", () => {
  const line = "npm test passed in 4.2s; wrote src/a.ts and src/b.ts; see https://example.com/docs?x=1\n";
  const text = line.repeat(Math.ceil(20_000 / line.length));
  redact(text);
  const runs = 50;
  const start = process.hrtime.bigint();
  for (let i = 0; i < runs; i += 1) redact(text);
  const msPerKb = Number(process.hrtime.bigint() - start) / 1e6 / runs / (text.length / 1024);
  assert.ok(msPerKb < 2, `${msPerKb.toFixed(3)} ms per KB`);
});

test("text built to make a pattern backtrack is redacted in linear time: four times the text, not sixteen times the work", async () => {
  for (const [unit, size, prefix] of [
    ["a.", 5000, ""],
    ["word-", 2000, ""],
    ["A", 10_000, ""],
    ["a.", 5000, "http://"],
  ] as const) {
    const [few, many] = [size, size * 4].map((count) => `${prefix}${unit.repeat(count)}`);
    const [small, large] = await fastestInTurns(
      () => redact(few),
      () => redact(many),
      3,
    );
    assert.ok(large < Math.max(small, 1) * 10, `${unit}: ${small.toFixed(1)} ms, then ${large.toFixed(1)} ms`);
  }
});

test("prose about passwords and tokens is no secret to a lint, though a key in it is", () => {
  for (const prose of [
    "The refresh token: expires after fifteen minutes, so renew it early.",
    "Password: required for every admin route.",
    "Rule: password reuse is refused by the API.",
    "Credentials: rotate quarterly and log each rotation.",
  ])
    assert.equal(hasSecret(prose), false, prose);
  assert.equal(hasSecret("Use the key sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa for staging."), true);
});
