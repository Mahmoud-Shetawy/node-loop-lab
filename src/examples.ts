import type { Messages } from '@/i18n';

/** One per entry of the example menu; its title is `examples.<key>`. */
export type ExampleKey = keyof Messages['examples'];

export interface Example {
	code: string;
	/** has an explanation in `exampleNotes.<key>`, shown before RUN */
	hasNote?: true;
}

export const EXAMPLES: Record<ExampleKey, Example> = {
	basics: {
		code: `function greet(name) {
  console.log('hello', name);
  shout(name);
}
function shout(name) {
  console.log(name.toUpperCase() + '!');
}

console.log('start');
greet('node');
console.log('end');`,
	},
	nextTickVsPromise: {
		code: `console.log('sync: first');

Promise.resolve().then(() => console.log('promise'));
process.nextTick(() => console.log('nextTick'));

console.log('sync: last');`,
	},
	nestedNextTick: {
		code: `process.nextTick(() => {
  console.log('nextTick 1');

  process.nextTick(() => {
    console.log('nextTick 2');
    process.nextTick(() => console.log('nextTick 3'));
    process.nextTick(() => console.log('nextTick 4'));
  });

  process.nextTick(() => {
    console.log('nextTick 5');
    process.nextTick(() => console.log('nextTick 6'));
    process.nextTick(() => console.log('nextTick 7'));
  });
});`,
	},
	micVsMacro: {
		hasNote: true,
		code: `process.nextTick(() => {
  console.log('nextTick');
});

Promise.resolve().then(() => {
  console.log('Promise');
});

setTimeout(() => {
  console.log('setTimeout');
}, 0);

setImmediate(() => {
  console.log('setImmediate');
});`,
	},
	timeoutVsImmediateIo: {
		code: `const fs = require('fs');

fs.readFile('file.txt', () => {
  setTimeout(() => {
    console.log('setTimeout');
  }, 0);

  setImmediate(() => {
    console.log('setImmediate');
  });
});`,
	},
	ioPuzzle: {
		code: `const fs = require('fs');

fs.readFile('file.txt', () => {
  process.nextTick(() => {
    console.log('nextTick in fs');
  });

  setTimeout(() => {
    console.log('setTimeout');
    process.nextTick(() => {
      console.log('nextTick in setTimeout');
    });
  }, 0);

  setImmediate(() => {
    console.log('setImmediate');
    process.nextTick(() => {
      console.log('nextTick in setImmediate');
      Promise.resolve().then(() => {
        console.log('Promise in setImmediate');
      });
    });
  });
});`,
	},
	ioPolling: {
		hasNote: true,
		code: `const fs = require('fs');

setTimeout(() => {
  console.log('hello');
}, 50);

fs.readFile('file.txt', () => {
  console.log('world');
});

setImmediate(() => {
  console.log('immediate');
});`,
	},
	node11: {
		code: `setTimeout(() => console.log('Timeout 1'));
setTimeout(() => {
  console.log('Timeout 2');
  Promise.resolve().then(() => console.log('promise resolve'));
});
setTimeout(() => console.log('Timeout 3'));`,
	},
	threadpool: {
		hasNote: true,
		code: `const fs = require('fs');

// only 4 libuv workers: reads 5 and 6 wait for a free one
for (let i = 1; i <= 6; i++) {
  fs.stat('file.txt', () => console.log('stat', i, 'done'));
}`,
	},
	asyncAwait: {
		code: `const fs = require('fs/promises');
const { setTimeout: sleep } = require('timers/promises');

async function loadConfig() {
  console.log('reading config...');
  const raw = await fs.readFile('config.json', 'utf8');
  const config = JSON.parse(raw);
  await sleep(10);
  return config;
}

loadConfig().then((config) => console.log('port:', config.port));
console.log('loadConfig() returned a promise');`,
	},
	unref: {
		code: `const interval = setInterval(() => console.log('interval'), 20);
console.log('hasRef:', interval.hasRef());

setTimeout(() => {
  interval.unref();
  console.log('unref: the interval no longer keeps Node alive');
}, 70);`,
	},
	closePhase: {
		hasNote: true,
		code: `const net = require('net');

const server = net.createServer((socket) => {
  console.log('server: new connection');
  socket.on('close', () => console.log("server socket: 'close'"));
  socket.destroy();
  setImmediate(() => console.log('setImmediate'));
});

// port 0: the OS picks a free port
server.listen(0, () => {
  const { port } = server.address();
  const client = net.connect(port, () => console.log('client: connected'));

  client.on('close', () => {
    console.log("client: 'close'");
    server.close(() => console.log('server closed'));
  });
});`,
	},
	crash: {
		code: `process.on('exit', (code) => console.log('exit code:', code));

setTimeout(() => {
  console.log('this timer runs');
}, 10);

setTimeout(() => {
  throw new Error('boom');
}, 20);

setTimeout(() => {
  console.log('never printed: the process is gone');
}, 30);`,
	},
	esm: {
		hasNote: true,
		code: `import fs from 'node:fs';

process.nextTick(() => {
  console.log('nextTick');
});

Promise.resolve().then(() => {
  console.log('promise resolve');
});

console.log('console.log');`,
	},
	starvation: {
		hasNote: true,
		code: `let count = 0;
function recursiveNextTick() {
  count++;
  process.nextTick(recursiveNextTick);
}
recursiveNextTick();

setTimeout(() => {
  console.log('This will never be executed.');
}, 0);`,
	},
};

export const EXAMPLE_KEYS = Object.keys(EXAMPLES) as ExampleKey[];
export const FIRST_EXAMPLE: ExampleKey = 'nextTickVsPromise';
