import assert from "node:assert/strict";
import { test } from "node:test";
import { firstNotEnglish, notEnglish } from "../server/english";

const ENGLISH = [
  "Use pnpm, never npm.",
  "We’re moving to pnpm — see “the plan” … done ✓",
  "npm test exited 1: TypeError: cannot read properties of undefined (reading 'map') at src/a.ts:12:4",
  "git push --force-with-lease origin feat/login && echo ok",
  "The day after the release, a hay bale fell; tai chi is calm.",
  "The query took 120 µs at p50 and 3 ms at p95.",
  "Run it again; it was fine.",
  "Tell them to run them.",
  "Use Lua for the scripts, not hay.",
  "Chu and Phong own the billing module.",
];

const NOT_ENGLISH = [
  "từ mai dùng pnpm",
  "mật khẩu staging là hunter2",
  "dung pnpm thay npm, khong dung npm nua",
  "xong roi, test chay het roi nhe",
  "tu mai dung pnpm",
  "pnpm la lua chon cua chu phong",
  "Chủ phòng yêu cầu sử dụng pnpm".normalize("NFD"),
  "Используйте pnpm",
  "pnpm を使う",
];

test("English passes, typography and code included; other languages and unaccented Vietnamese do not", () => {
  for (const text of ENGLISH) assert.equal(notEnglish(text), null, text);
  for (const text of NOT_ENGLISH) assert.notEqual(notEnglish(text), null, text);
});

test("the first string that is not English is named by its path inside a value", () => {
  assert.deepEqual(firstNotEnglish({ state: { said: "done", notes: ["ok", "chưa xong"] } }), {
    path: "state.notes[1]",
    why: 'has the letter "ư"',
  });
  assert.equal(firstNotEnglish({ state: { said: "done", count: 3 } }), null);
});
