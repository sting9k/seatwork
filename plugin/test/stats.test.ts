import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEP_LOG_DAYS } from "../server/gc";
import { roomStats } from "../server/stats";

test("room stats look no further back than the mail log is kept", () => {
  const posted = (days: number, subject: string) => ({
    at: new Date(Date.now() - days * 86_400_000).toISOString(),
    from: "lead",
    to: "peer",
    subject,
  });
  const lines = [
    posted(KEEP_LOG_DAYS + 3, "ACCEPT abc"),
    posted(KEEP_LOG_DAYS - 1, "CANDIDATE abc"),
    posted(1, "ACCEPT abc"),
  ];
  const stats = roomStats(KEEP_LOG_DAYS * 2, (since) => lines.filter((line) => line.at >= since));
  assert.match(stats, new RegExp(`^mail in the last ${KEEP_LOG_DAYS} days: 2\n`));
});

test("room stats count the seats whose work came back three times or more", () => {
  const posted = (to: string, subject: string) => ({
    at: new Date().toISOString(),
    from: "lead",
    to,
    subject,
  });
  const lines = [...["p1", "p1", "p1", "p2"].map((to) => posted(to, "REJECT abc: repair")), posted("p1", "ACCEPT abc")];
  assert.match(
    roomStats(1, () => lines),
    /seats sent back 3 times or more: 1/,
  );
});
