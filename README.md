# Node Loop Lab

[![CI](https://github.com/Mahmoud-Shetawy/node-loop-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/Mahmoud-Shetawy/node-loop-lab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Live:** https://mahmoud-shetawy.github.io/node-loop-lab/

Write a few lines of Node.js and watch them run one step at a time: the V8 call stack, the six libuv phases on a ring, the `process.nextTick` and Promise queues, timers counting down and the four thread pool workers. Every step has one plain sentence that says what happened and why. The interface speaks **English and Arabic** (right to left).

## Why the order is right

The code is not pattern-matched: it **runs**, inside a simulated Node.js 22 process.

- `src/engine/instrument.ts` parses the program with acorn and rewrites it with astring, so every call becomes a call stack frame, `async` functions are driven by the simulated microtask queue and loops get an operation budget.
- `src/engine/promise.ts` follows ECMA-262 step by step, so microtask counts match V8 (`return promise` inside `then` costs two extra ticks).
- `src/engine/runtime.ts` is the event loop as libuv's `uv_run` runs it: timers → pending → idle/prepare → poll → check → close. After every callback Node empties the nextTick queue, then the microtasks. Poll waits for the next timer or I/O unless immediates or close callbacks are pending. File calls go through a four-thread pool as their real syscalls. A crash exits with Node's exit codes.
- `src/engine/node-modules.ts` provides `fs`, `fs/promises`, `timers`, `timers/promises`, `events`, `net`, `util`, `process` and `Buffer`, backed by an in-memory folder with `file.txt`, `config.json` and `notes.md`.
- Each run happens in its own Web Worker, so user code can't reach the page, and a runaway native operation is stopped after five seconds.

The tests hold the simulator to real Node. `src/engine/engine.differential.test.ts` runs every program in a real `node` process and in the simulator. It compares the output, the exit code and, through `async_hooks`, **the kind of callback each printed line came from** (Timeout, Immediate, FSREQCALLBACK, TickObject, PROMISE, TCPWRAP …). CI runs it against Node 22. Set `NODE_REFERENCE_BIN` to compare with another Node.

## Where real Node itself varies

- `setTimeout(fn, 0)` against `setImmediate(fn)` from the main module is a race in real Node. The simulator shows the immediate first, which is what usually happens on a fast machine.
- When the four thread pool workers finish is up to the OS scheduler.
- When one poll delivers two network events, macOS (kqueue) and Linux (epoll) order them differently. The simulator follows macOS.
- Node 23+ reads a small file in one request instead of four, and evaluates ES modules without top-level `await` synchronously. The simulator models Node 22.
- Time is simulated, so a busy-wait loop never ends and is stopped by the operation budget.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + differential tests (needs node on PATH)
npm run e2e        # Playwright, against the production build
npm run lint && npm run typecheck
```

Every push to `main` is checked by CI and deployed to GitHub Pages.

## Further reading

- [The Node.js event loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick), from the official guide
- [libuv design overview](https://docs.libuv.org/en/v1.x/design.html)
- "You Don't Know Node.js EventLoop" on Medium, where several of the examples come from

## License

[MIT](LICENSE) © 2026 Mahmoud Shetawy
