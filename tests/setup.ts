// The setup file of every test run (vitest.config.ts `setupFiles`): one turn of the event loop before each test.
// Most of djs's tests are synchronous, and vitest runs a file's tests one after the other on promise continuations
// only, so a worker could go through a whole file without reading a message: the reply to its own RPC call
// (`onTaskUpdate`) then waited past vitest's fixed 60 s timeout, and the run failed with `[vitest-worker]: Timeout
// calling "onTaskUpdate"` although every test passed (src/query.test.ts held its worker 74 s). With a turn per test,
// the longest stall is the longest single test.
import { beforeEach } from "vitest";

beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
