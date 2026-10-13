import { WorkError, WorkStore } from "../../server/tasks/store";

/** One of several processes on the same work store: does one job, prints the result. */
const [dir, job, ...rest] = process.argv.slice(2);
const store = new WorkStore(dir, { busyTimeoutMs: 30_000, flushAfterMs: 5 });
try {
  if (job === "claim") console.log(JSON.stringify({ won: store.claim(rest[0], rest[1]).assignee }));
  else {
    const made: string[] = [];
    for (let i = 0; i < Number(rest[0]); i += 1) made.push(store.create({ title: `${rest[1]} ${i}` }, rest[1]).id);
    console.log(JSON.stringify({ made }));
  }
} catch (error) {
  console.log(JSON.stringify({ refused: error instanceof WorkError ? error.code : String(error) }));
}
store.close();
