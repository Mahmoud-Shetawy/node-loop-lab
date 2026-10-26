export interface RichText {
	paragraphs: string[];
	items?: string[];
	ordered?: boolean;
}

/** English is the source of truth: every other language must match this shape. */
export const en = {
	app: {
		title: 'Node Loop Lab',
		subtitle: 'Watch libuv and V8 run your code, one step at a time',
		version: 'Node.js 22 LTS model',
	},
	header: {
		github: 'GitHub repository',
		scheme: { light: 'Switch to light mode', dark: 'Switch to dark mode' },
		language: 'Switch language',
		languageName: 'العربية',
	},
	panel: {
		about: 'What am I looking at?',
	},
	controls: {
		run: 'RUN',
		play: 'Play',
		pause: 'Pause',
		next: 'Next step',
		back: 'Previous step',
		stop: 'Back to the editor',
		restart: 'Start over (Home)',
		speed: 'speed x{speed}',
		speedLabel: 'Playback speed',
		selectExample: 'Select example',
		examplePlaceholder: 'select an example',
		step: 'step {current} / {total}',
		shortcuts:
			'Shortcuts: → next · ← back · Space play/pause · Home start over',
	},
	status: {
		iteration: 'Loop iteration',
		beforeLoop: 'main module',
		time: 'time',
		refs: 'refs',
		refsHint:
			'Active refs: timers, I/O requests, immediates and open handles that keep the process alive. When it reaches 0 the process exits.',
		module: 'module',
		notStarted: 'Press RUN',
		mainHint: 'runs once, top to bottom, before the loop starts',
		clock: 'clock',
		alive: '{refs} keeping Node alive',
	},
	examples: {
		basics: 'call stack basics',
		nextTickVsPromise: 'process.nextTick vs Promise',
		nestedNextTick: 'nested nextTick (quiz)',
		micVsMacro: 'microtasks vs macrotasks',
		timeoutVsImmediateIo: 'setTimeout vs setImmediate in I/O',
		ioPuzzle: 'I/O puzzle (interview)',
		ioPolling: 'I/O polling',
		node11: 'Node 11 change: microtasks between timers',
		threadpool: 'libuv thread pool (6 reads, 4 workers)',
		asyncAwait: 'async / await with fs.promises',
		unref: 'setInterval + unref()',
		closePhase: 'close callbacks (socket.destroy)',
		crash: 'uncaught errors crash Node',
		esm: 'ES module vs CommonJS',
		starvation: 'nextTick starvation',
	},
	exampleNotes: {
		micVsMacro:
			'From the main module, setTimeout(0) vs setImmediate is a race in real Node: it depends on how fast the process starts. The simulator always shows the immediate first.',
		ioPolling:
			'A file read is several round trips to the thread pool (open → fstat → read → close). Every round trip comes back through the poll phase, so the callback needs several loop iterations.',
		esm: 'The startup order of nextTick vs Promise in ES modules is version dependent: Node 22 runs Promises first (simulated here), Node 23+ runs nextTick first unless the module uses top-level await.',
		threadpool:
			'Real worker threads run in parallel: in real Node the four stats can finish in any order, so the "done" lines may come out in a different order on your machine.',
		closePhase:
			"A socket that is destroyed emits 'close' in the close callbacks phase, after setImmediate. server.close() is different: its callback runs on the next tick (measured with async_hooks on real Node). The first two lines follow macOS: on Linux, the server's 'connection' comes before the client's connect callback.",
		starvation:
			'A recursive process.nextTick never lets the loop reach the timers phase. The simulation stops when it hits its step limit.',
	},
	sections: {
		editor: {
			title: 'Code Editor',
			description: {
				paragraphs: [
					'Write Node.js code and watch the event loop run it. The code is really executed against a simulated Node.js 22 process, so the output matches real Node.',
				],
				items: [
					'pick an example or write your own code',
					'RUN, then use Next / Back to move one step at a time, or Play',
					'available: setTimeout, setInterval, setImmediate, process.nextTick, Promise, async/await, queueMicrotask, require/import of fs, fs/promises, timers/promises, events, net, util',
					'files you can read: file.txt, config.json, notes.md',
				],
			} satisfies RichText,
		},
		callstack: {
			title: 'Call Stack (V8)',
			description: {
				paragraphs: [
					'V8 runs JavaScript on a single thread. The call stack shows the function running right now and who called it.',
					'The event loop can only run the next callback when the stack is empty: a long synchronous function blocks everything.',
				],
			} satisfies RichText,
		},
		console: {
			title: 'Console',
			empty: 'No output yet',
			description: {
				paragraphs: [
					'Everything the program prints, in the exact order real Node.js prints it.',
					'An uncaught exception or unhandled rejection crashes the process, like real Node.',
				],
			} satisfies RichText,
		},
		libuv: {
			title: 'libuv',
			timers: 'Timers',
			threadpool: 'Thread pool',
			worker: 'worker {n}',
			waiting: 'waiting for a worker',
			handles: 'Handles',
			empty: 'idle',
			description: {
				paragraphs: [
					'libuv is the C library that gives Node.js its event loop. It keeps track of everything happening outside the JavaScript thread.',
				],
				items: [
					'Timers: setTimeout / setInterval waiting to expire (the ring shows the time left)',
					'Thread pool: blocking work such as fs runs on 4 worker threads (UV_THREADPOOL_SIZE); extra jobs wait for a free worker',
					'Handles: long-lived resources such as a listening server; they keep the process alive',
				],
			} satisfies RichText,
		},
		microtasks: {
			title: 'Microtasks',
			nextTick: 'process.nextTick queue',
			promises: 'Promise (microtask) queue',
			description: {
				paragraphs: [
					'After every callback (and after the main module), Node empties the process.nextTick queue first, then V8’s microtask queue (Promises, await, queueMicrotask), and repeats until both are empty.',
					'Only then does the loop continue to the next callback or phase. Since Node 11 this happens between every single timer and immediate.',
				],
			} satisfies RichText,
		},
		eventLoop: {
			title: 'Event Loop phases',
			now: 'Now',
			idle: 'Press RUN to start.',
			drain: 'nextTick → Promises',
			macrotasks: 'macrotask queues',
			description: {
				paragraphs: [
					'The loop runs these phases in order. Each phase has its own queue of callbacks (macrotasks). After each callback, the nextTick and Promise queues are drained.',
					'The loop keeps going while there are active refs; when nothing is left, the process exits.',
				],
			} satisfies RichText,
		},
	},
	scene: {
		title: 'Event loop',
		callstack: 'Call stack (V8)',
		libuv: 'libuv',
		timers: 'Timers',
		threadpool: 'Thread pool · {busy}/{size} busy',
		worker: 'worker {n}',
		waiting: 'waiting for a worker',
		handles: 'Open handles',
		empty: 'empty',
		macrotasks: 'Phase queues: each one runs when the loop reaches its phase',
		microtasks:
			'Microtask queues: emptied after every single callback, nextTick first',
		tickQueue: 'process.nextTick()',
		promiseQueue: '.then · await · queueMicrotask',
		timerLeft: '{ms}ms left',
		timerDue: 'expired: ready',
		timerAt: 'set at {start}ms, fires at {end}ms',
		loop: 'The event loop: one lap = one iteration',
		loopStart: 'start',
		drain: 'nextTick → Promises',
		showInside: 'Show what Node does inside',
		hideInside: 'Hide the details',
		description: {
			paragraphs: [
				'Every callback is a colored card, and it keeps its color wherever it goes: amber timers, green I/O, violet setImmediate, pink nextTick, orange Promises.',
				'Follow a card: it is handed to libuv (a timer or the thread pool), drops into the queue of its phase when it is ready, and moves up to the call stack when the event loop reaches that phase. After every callback, the nextTick and Promise queues are emptied first.',
			],
		} satisfies RichText,
	},
	internals: {
		title: 'Inside Node.js',
		insideNode: 'Inside Node',
		idle: 'Press RUN: every step shows which layer of Node.js works and which function it calls.',
		loop: 'The event loop',
		phaseQueues: 'Phase queues (macrotasks)',
		timersHeap: 'Timers (min-heap by expiry)',
		threadpool: 'Thread pool (UV_THREADPOOL_SIZE = 4)',
		workQueue: 'work queue: waiting for a free worker',
		worker: 'worker {n}',
		handles: 'Open handles',
		none: 'none',
		left: '{ms}ms left',
		draining: 'nextTick → Promises',
		layers: {
			js: {
				name: 'JavaScript · V8',
				hint: 'one thread: the call stack, process.nextTick and the microtask (Promise) queue',
			},
			cpp: {
				name: 'Node.js C++ bindings',
				hint: 'the bridge: turns libuv events into JavaScript calls and drains the queues after each one',
			},
			libuv: {
				name: 'libuv',
				hint: 'the event loop itself, timers, the thread pool and handles',
			},
			os: {
				name: 'Operating system',
				hint: 'epoll (Linux) / kqueue (macOS) wake the loop; files are read by worker threads',
			},
		},
		os: {
			poller: 'epoll_wait / kqueue',
			sleeping: 'sleeping {ms}ms',
			polling: 'polling for events',
			disk: 'file syscalls (worker threads)',
			stdout: 'stdout',
		},
		description: {
			paragraphs: [
				'Node.js is layers: your JavaScript runs in V8, the C++ bindings connect it to libuv, and libuv talks to the operating system.',
				'Each step lights up the layers that work in it and shows the real function names from the Node.js and libuv sources. Cards move between the layers as the same callback travels: from a libuv timer to the timers queue, then to the call stack.',
			],
		} satisfies RichText,
	},
	phases: {
		main: {
			name: 'main module',
			hint: 'your script runs once, top to bottom',
			runs: 'your script',
		},
		timers: {
			name: 'timers',
			hint: 'expired setTimeout / setInterval callbacks',
			runs: 'setTimeout · setInterval',
		},
		pending: {
			name: 'pending callbacks',
			hint: 'I/O callbacks deferred from the previous loop (e.g. some TCP errors)',
			runs: 'deferred I/O errors',
		},
		idle: {
			name: 'idle, prepare',
			hint: 'used internally by libuv',
			runs: 'libuv only',
		},
		poll: {
			name: 'poll',
			hint: 'retrieve finished I/O and run its callbacks; may wait here',
			runs: 'I/O: fs, net · waits',
		},
		check: {
			name: 'check',
			hint: 'setImmediate callbacks',
			runs: 'setImmediate',
		},
		close: {
			name: 'close callbacks',
			hint: "'close' events, e.g. server.close()",
			runs: "'close' events",
		},
	},
	errors: {
		title: 'The simulation could not run',
		syntax: 'Syntax error at line {line}, column {column}: {message}',
		unsupportedSyntax: '{feature} is not supported by the simulator yet.',
		operationLimit:
			'The code ran more than {limit} operations without giving control back to the event loop — most likely an infinite loop. Real Node would hang here.',
		timeout:
			'One operation took longer than {seconds}s (for example a huge array or a catastrophic regular expression), so the simulation was stopped.',
		internal: 'Unexpected simulator error: {message}',
		report: 'Report an issue',
	},
	notices: {
		truncated:
			'This program never ends (a setInterval never cleared, a server never closed, or endless nextTicks), so the simulation stopped early.',
		crashed: 'The process crashed with exit code {code}.',
		exited: 'The process exited with code {code}.',
	},
	narration: {
		start:
			'node main.js — Node starts the process and V8 runs the main module.',
		startEsm:
			'node main.mjs — the file uses import, so Node loads it as an ES module.',
		phase: {
			main: 'The main module runs synchronously, top to bottom.',
			timers:
				'Iteration {iteration} · timers phase: run the timers that have expired ({refs} refs keep the loop alive).',
			timersNone:
				'Iteration {iteration} · timers phase: no timer is waiting, so nothing runs here.',
			timersNotYet:
				'Iteration {iteration} · timers phase: the timer of {value} started counting at setTimeout(), but it has {ms}ms left, so the loop moves on without it.',
			pending:
				'Pending callbacks phase: nothing deferred from the previous loop.',
			idle: 'Idle, prepare: libuv internals.',
			poll: 'Poll phase: collect finished I/O and run its callbacks.',
			check: 'Check phase: run setImmediate callbacks.',
			close: "Close callbacks phase: run 'close' events.",
		},
		drain:
			'The call stack is empty: drain process.nextTick callbacks, then Promises.',
		waitTimer:
			'Nothing to run: poll waits {ms}ms for the next timer (t = {until}ms).',
		waitIo:
			'Nothing to run: poll waits {ms}ms for I/O to finish (t = {until}ms).',
		call: '{value} is pushed onto the call stack.',
		log: 'console prints: {value}',
		timerStart: 'libuv starts a {delay}ms timer for {value}.',
		timerExpired: 'The timer expired: {value} joins the timers queue.',
		timerCancelled: 'The timer for {value} was cancelled.',
		immediateCancelled: 'The immediate {value} was cancelled.',
		threadpoolStart: 'A thread pool worker starts {value}.',
		threadpoolQueued:
			'All 4 workers are busy: {value} waits for a free worker (t = {start}ms).',
		handleOpen: 'A handle is opened: {value}. It keeps the process alive.',
		ioStageDone: 'Poll picks up a finished syscall: {value}',
		ioDone: 'The I/O finished: its callback {value} joins the poll queue.',
		queueNextTick: '{value} is added to the nextTick queue.',
		queuePromise: 'A promise settled: {value} joins the Promise queue.',
		queueAwait: '{value} will resume as a microtask.',
		queueThenable:
			'Resolving with a thenable costs an extra microtask: {value}',
		queueMicrotask: 'queueMicrotask() added {value} to the Promise queue.',
		queueImmediate: '{value} is added to the check (setImmediate) queue.',
		queueClose: '{value} is added to the close queue.',
		runNextTick: 'Run nextTick callback: {value}',
		runMicrotask: 'Run microtask: {value}',
		runTimer: 'Run timer callback: {value}',
		runIo: 'Run poll callback: {value}',
		runImmediate: 'Run setImmediate callback: {value}',
		runClose: 'Run close callback: {value}',
		end: 'No refs left: the process exits with code {code}.',
		endCrashed: 'The process crashed (exit code {code}).',
		endTruncated: 'Stopped — this program keeps the loop busy forever.',
	},
};

type Widen<T> = T extends string
	? string
	: T extends readonly (infer U)[]
		? Widen<U>[]
		: { [K in keyof T]: Widen<T[K]> };

export type Messages = Widen<typeof en>;
