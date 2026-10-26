import type { Messages } from './en';

/** Technical terms (callback, nextTick, Promise, libuv, ...) stay in English on purpose. */
export const ar: Messages = {
	app: {
		title: 'Node Loop Lab',
		subtitle: 'شاهد libuv و V8 وهما ينفّذان كودك خطوة بخطوة',
		version: 'نموذج Node.js 22 LTS',
	},
	header: {
		github: 'مستودع المشروع على GitHub',
		scheme: {
			light: 'التبديل إلى الوضع الفاتح',
			dark: 'التبديل إلى الوضع الداكن',
		},
		language: 'تغيير اللغة',
		languageName: 'English',
	},
	panel: {
		about: 'ما الذي أراه هنا؟',
	},
	controls: {
		run: 'تشغيل',
		play: 'تشغيل تلقائي',
		pause: 'إيقاف مؤقت',
		next: 'الخطوة التالية',
		back: 'الخطوة السابقة',
		stop: 'رجوع للمحرر',
		restart: 'البدء من جديد (Home)',
		speed: 'السرعة x{speed}',
		speedLabel: 'سرعة العرض',
		selectExample: 'اختيار مثال',
		examplePlaceholder: 'اختر مثالًا',
		step: 'خطوة {current} / {total}',
		shortcuts:
			'اختصارات: → التالية · ← السابقة · Space تشغيل/إيقاف · Home من البداية',
	},
	status: {
		iteration: 'دورة الـ loop',
		beforeLoop: 'الـ main module',
		time: 'الوقت',
		refs: 'refs',
		refsHint:
			'الـ refs النشطة: timers وطلبات I/O و immediates و handles مفتوحة، وكلها تُبقي الـ process حيًا. عندما تصل إلى 0 تنتهي الـ process.',
		module: 'نوع الملف',
		notStarted: 'اضغط RUN',
		mainHint: 'يعمل مرة واحدة من أوله لآخره قبل أن تبدأ الـ loop',
		clock: 'الساعة',
		alive: '{refs} تُبقي Node حيًا',
	},
	examples: {
		basics: 'أساسيات الـ call stack',
		nextTickVsPromise: 'process.nextTick مقابل Promise',
		nestedNextTick: 'nextTick متداخلة (سؤال)',
		micVsMacro: 'الـ microtasks مقابل الـ macrotasks',
		timeoutVsImmediateIo: 'setTimeout مقابل setImmediate داخل I/O',
		ioPuzzle: 'لغز I/O (سؤال إنترفيو)',
		ioPolling: 'الـ I/O polling',
		node11: 'تغيير Node 11: الـ microtasks بين الـ timers',
		threadpool: 'الـ thread pool في libuv (6 قراءات و4 workers)',
		asyncAwait: 'async / await مع fs.promises',
		unref: 'setInterval مع unref()',
		closePhase: 'الـ close callbacks (socket.destroy)',
		crash: 'الأخطاء غير المعالجة توقف Node',
		esm: 'ES module مقابل CommonJS',
		starvation: 'تجويع الـ loop بـ nextTick',
	},
	exampleNotes: {
		micVsMacro:
			'من الـ main module، الترتيب بين setTimeout(0) و setImmediate غير ثابت في Node الحقيقي، ويعتمد على سرعة بدء الـ process. المحاكي يعرض الـ immediate أولًا دائمًا.',
		ioPolling:
			'قراءة الملف عدة رحلات للـ thread pool (open ← fstat ← read ← close). كل رحلة ترجع عن طريق مرحلة الـ poll، لذلك يحتاج الـ callback عدة دورات للـ loop.',
		esm: 'ترتيب nextTick و Promise عند بدء الـ ES modules يختلف حسب الإصدار: Node 22 ينفذ الـ Promises أولًا (وهو المعروض هنا)، و Node 23+ ينفذ nextTick أولًا إلا لو الملف فيه top-level await.',
		threadpool:
			'الـ worker threads الحقيقية تعمل بالتوازي: في Node الحقيقي قد تنتهي عمليات الـ stat الأربع بأي ترتيب، لذلك قد تظهر أسطر "done" بترتيب مختلف على جهازك.',
		closePhase:
			"الـ socket الذي يتم تدميره (destroy) يطلق حدث 'close' في مرحلة الـ close callbacks بعد setImmediate. أما server.close() فمختلف: الـ callback الخاص به يعمل في الـ nextTick التالي (تم قياس ذلك بـ async_hooks على Node الحقيقي). أول سطرين يتبعان macOS: على Linux يأتي حدث 'connection' الخاص بالـ server قبل الـ connect callback الخاص بالـ client.",
		starvation:
			'استدعاء process.nextTick بشكل متكرر لا يسمح للـ loop أبدًا بالوصول لمرحلة الـ timers. المحاكاة تتوقف عند حد الخطوات.',
	},
	sections: {
		editor: {
			title: 'محرر الكود',
			description: {
				paragraphs: [
					'اكتب كود Node.js وشاهد الـ event loop وهو ينفذه. الكود يُنفَّذ فعلًا داخل process محاكية لـ Node.js 22، لذلك الناتج مطابق لـ Node الحقيقي.',
				],
				items: [
					'اختر مثالًا أو اكتب كودك',
					'اضغط «تشغيل»، ثم «التالية» / «السابقة» للتحرك خطوة خطوة، أو التشغيل التلقائي',
					'المتاح: setTimeout و setInterval و setImmediate و process.nextTick و Promise و async/await و queueMicrotask، و require/import لـ fs و fs/promises و timers/promises و events و net و util',
					'ملفات يمكن قراءتها: file.txt و config.json و notes.md',
				],
			},
		},
		callstack: {
			title: 'الـ Call Stack (V8)',
			description: {
				paragraphs: [
					'V8 ينفذ JavaScript على thread واحد. الـ call stack يوضح الدالة التي تعمل الآن ومن الذي استدعاها.',
					'الـ event loop لا يستطيع تنفيذ الـ callback التالي إلا عندما يفرغ الـ stack، لذلك أي دالة متزامنة طويلة توقف كل شيء.',
				],
			},
		},
		console: {
			title: 'الـ Console',
			empty: 'لا يوجد ناتج بعد',
			description: {
				paragraphs: [
					'كل ما يطبعه البرنامج، بنفس الترتيب الذي يطبعه Node.js الحقيقي.',
					'أي exception أو promise rejection غير معالج يوقف الـ process (crash)، تمامًا مثل Node الحقيقي.',
				],
			},
		},
		libuv: {
			title: 'libuv',
			timers: 'الـ Timers',
			threadpool: 'الـ Thread pool',
			worker: 'worker {n}',
			waiting: 'في انتظار worker متاح',
			handles: 'الـ Handles',
			empty: 'فارغ',
			description: {
				paragraphs: [
					'libuv هي مكتبة C التي توفر لـ Node.js الـ event loop. تتابع كل ما يحدث خارج الـ JavaScript thread.',
				],
				items: [
					'الـ Timers: كل setTimeout / setInterval في انتظار انتهاء وقته (الحلقة توضح الوقت المتبقي)',
					'الـ Thread pool: العمليات الـ blocking مثل fs تعمل على 4 worker threads (UV_THREADPOOL_SIZE)، والعمليات الزائدة تنتظر worker متاح',
					'الـ Handles: موارد تعيش طويلًا مثل server يستمع، وتُبقي الـ process حيًا',
				],
			},
		},
		microtasks: {
			title: 'الـ Microtasks',
			nextTick: 'طابور process.nextTick',
			promises: 'طابور الـ Promises (microtasks)',
			description: {
				paragraphs: [
					'بعد كل callback (وبعد الـ main module)، يُفرغ Node طابور process.nextTick أولًا، ثم طابور الـ microtasks في V8 (الـ Promises و await و queueMicrotask)، ويكرر حتى يفرغ الاثنان.',
					'بعدها فقط يكمل الـ loop للـ callback أو المرحلة التالية. ومنذ Node 11 يحدث هذا بين كل timer و immediate.',
				],
			},
		},
		eventLoop: {
			title: 'مراحل الـ Event Loop',
			now: 'الآن',
			idle: 'اضغط «تشغيل» للبدء.',
			drain: 'nextTick ← Promises',
			macrotasks: 'طوابير الـ macrotasks',
			description: {
				paragraphs: [
					'الـ loop ينفذ هذه المراحل بالترتيب. لكل مرحلة طابور callbacks خاص بها (macrotasks). بعد كل callback يتم تفريغ طابوري الـ nextTick والـ Promises.',
					'يستمر الـ loop طالما توجد refs نشطة، وعندما لا يتبقى شيء تنتهي الـ process.',
				],
			},
		},
	},
	scene: {
		title: 'الـ Event loop',
		callstack: 'الـ Call stack (V8)',
		libuv: 'libuv',
		timers: 'الـ Timers',
		threadpool: 'الـ Thread pool · {busy}/{size} مشغول',
		worker: 'worker {n}',
		waiting: 'في انتظار worker',
		handles: 'الـ handles المفتوحة',
		empty: 'فارغ',
		macrotasks:
			'طوابير المراحل: كل طابور يُنفَّذ عندما تصل الـ loop إلى مرحلته',
		microtasks:
			'طوابير الـ Microtasks: تُفرَّغ بعد كل callback، والـ nextTick أولًا',
		tickQueue: 'process.nextTick()',
		promiseQueue: '.then · await · queueMicrotask',
		timerLeft: 'باقٍ {ms}ms',
		timerDue: 'انتهى وقته: جاهز',
		timerAt: 'بدأ عند {start}ms، وينتهي عند {end}ms',
		loop: 'الـ event loop: كل لفّة = دورة واحدة',
		loopStart: 'البداية',
		drain: 'nextTick ← Promises',
		showInside: 'اعرض ما يفعله Node من الداخل',
		hideInside: 'إخفاء التفاصيل',
		description: {
			paragraphs: [
				'كل callback بطاقة ملونة، وتحتفظ بلونها أينما انتقلت: الكهرماني للـ timers، والأخضر للـ I/O، والبنفسجي لـ setImmediate، والوردي لـ nextTick، والبرتقالي للـ Promises.',
				'تابع البطاقة: تُسلَّم إلى libuv (timer أو الـ thread pool)، وعندما تجهز تنتقل إلى طابور مرحلتها، وعندما يصل الـ event loop إلى تلك المرحلة تصعد إلى الـ call stack. وبعد كل callback يُفرَّغ طابورا الـ nextTick والـ Promises أولًا.',
			],
		},
	},
	internals: {
		title: 'داخل Node.js',
		insideNode: 'داخل Node',
		idle: 'اضغط «تشغيل»: كل خطوة توضح أي طبقة في Node.js تعمل، وما الدالة التي تستدعيها.',
		loop: 'الـ event loop',
		phaseQueues: 'طوابير المراحل (macrotasks)',
		timersHeap: 'الـ Timers (min-heap حسب وقت الانتهاء)',
		threadpool: 'الـ Thread pool (UV_THREADPOOL_SIZE = 4)',
		workQueue: 'الـ work queue: في انتظار worker متاح',
		worker: 'worker {n}',
		handles: 'الـ handles المفتوحة',
		none: 'لا يوجد',
		left: 'متبقي {ms}ms',
		draining: 'nextTick ← Promises',
		layers: {
			js: {
				name: 'JavaScript · V8',
				hint: 'thread واحد: الـ call stack و process.nextTick وطابور الـ microtasks (الـ Promises)',
			},
			cpp: {
				name: 'الـ C++ bindings في Node.js',
				hint: 'الجسر: يحوّل أحداث libuv إلى استدعاءات JavaScript ويفرغ الطوابير بعد كل واحد',
			},
			libuv: {
				name: 'libuv',
				hint: 'الـ event loop نفسه، والـ timers، والـ thread pool، والـ handles',
			},
			os: {
				name: 'نظام التشغيل',
				hint: 'epoll (Linux) / kqueue (macOS) يوقظان الـ loop، والملفات تُقرأ بواسطة worker threads',
			},
		},
		os: {
			poller: 'epoll_wait / kqueue',
			sleeping: 'نائم {ms}ms',
			polling: 'يبحث عن أحداث',
			disk: 'syscalls الملفات (worker threads)',
			stdout: 'stdout',
		},
		description: {
			paragraphs: [
				'Node.js عبارة عن طبقات: كود JavaScript يعمل داخل V8، والـ C++ bindings توصله بـ libuv، و libuv تتعامل مع نظام التشغيل.',
				'كل خطوة تضيء الطبقات التي تعمل فيها وتعرض أسماء الدوال الحقيقية من كود Node.js و libuv. والبطاقات تتحرك بين الطبقات وهي نفس الـ callback: من timer في libuv إلى طابور الـ timers ثم إلى الـ call stack.',
			],
		},
	},
	phases: {
		main: {
			name: 'الـ main module',
			hint: 'السكربت يعمل مرة واحدة من أوله لآخره',
			runs: 'السكربت الخاص بك',
		},
		timers: {
			name: 'timers',
			hint: 'الـ callbacks الخاصة بـ setTimeout / setInterval التي انتهى وقتها',
			runs: 'setTimeout · setInterval',
		},
		pending: {
			name: 'pending callbacks',
			hint: 'callbacks لـ I/O تأجلت من الدورة السابقة (مثل بعض أخطاء TCP)',
			runs: 'أخطاء I/O مؤجلة',
		},
		idle: {
			name: 'idle, prepare',
			hint: 'تستخدمها libuv داخليًا',
			runs: 'داخلية في libuv',
		},
		poll: {
			name: 'poll',
			hint: 'تجمع الـ I/O المنتهي وتنفذ الـ callbacks الخاصة به، وقد تنتظر هنا',
			runs: 'I/O: fs, net · وتنتظر',
		},
		check: {
			name: 'check',
			hint: 'الـ callbacks الخاصة بـ setImmediate',
			runs: 'setImmediate',
		},
		close: {
			name: 'close callbacks',
			hint: "أحداث 'close'، مثل server.close()",
			runs: "أحداث 'close'",
		},
	},
	errors: {
		title: 'تعذّر تشغيل المحاكاة',
		syntax:
			'خطأ في الصياغة (Syntax error) في السطر {line}، العمود {column}: {message}',
		unsupportedSyntax: 'الخاصية {feature} غير مدعومة في المحاكي حتى الآن.',
		operationLimit:
			'نفّذ الكود أكثر من {limit} عملية دون أن يعيد التحكم للـ event loop، والأرجح أن هناك loop لا ينتهي. Node الحقيقي كان سيتوقف (hang) هنا.',
		timeout:
			'عملية واحدة استغرقت أكثر من {seconds} ثوانٍ (مثل array ضخمة جدًا أو regular expression كارثية)، لذلك تم إيقاف المحاكاة.',
		internal: 'خطأ غير متوقع في المحاكي: {message}',
		report: 'الإبلاغ عن مشكلة',
	},
	notices: {
		truncated:
			'هذا البرنامج لا ينتهي (setInterval لم يُلغَ، أو server لم يُغلق، أو nextTick بلا نهاية)، لذلك تم إيقاف المحاكاة مبكرًا.',
		crashed: 'توقفت الـ process بشكل مفاجئ (crash) بـ exit code {code}.',
		exited: 'انتهت الـ process بـ exit code {code}.',
	},
	narration: {
		start: 'node main.js — يبدأ Node الـ process ويشغّل V8 الـ main module.',
		startEsm:
			'node main.mjs — الملف يستخدم import، لذلك يحمّله Node كـ ES module.',
		phase: {
			main: 'الـ main module يعمل بشكل متزامن من أوله لآخره.',
			timers:
				'الدورة {iteration} · مرحلة الـ timers: تنفيذ الـ timers التي انتهى وقتها ({refs} refs تُبقي الـ loop حيًا).',
			timersNone:
				'الدورة {iteration} · مرحلة الـ timers: لا يوجد timer منتظر، فلا يُنفَّذ شيء هنا.',
			timersNotYet:
				'الدورة {iteration} · مرحلة الـ timers: الـ timer الخاص بـ {value} بدأ العدّ من لحظة setTimeout()، لكن باقٍ له {ms}ms، فتكمل الـ loop بدونه.',
			pending:
				'مرحلة الـ pending callbacks: لا يوجد شيء مؤجل من الدورة السابقة.',
			idle: 'مرحلة idle, prepare: عمليات داخلية في libuv.',
			poll: 'مرحلة الـ poll: جمع الـ I/O المنتهي وتنفيذ الـ callbacks الخاصة به.',
			check: 'مرحلة الـ check: تنفيذ الـ callbacks الخاصة بـ setImmediate.',
			close: "مرحلة الـ close callbacks: تنفيذ أحداث 'close'.",
		},
		drain:
			'الـ call stack فارغ: تفريغ الـ process.nextTick callbacks ثم الـ Promises.',
		waitTimer:
			'لا يوجد شيء للتنفيذ: مرحلة الـ poll تنتظر {ms}ms حتى أقرب timer (t = {until}ms).',
		waitIo:
			'لا يوجد شيء للتنفيذ: مرحلة الـ poll تنتظر {ms}ms حتى ينتهي الـ I/O (t = {until}ms).',
		call: 'تمت إضافة {value} إلى الـ call stack.',
		log: 'الـ console يطبع: {value}',
		timerStart: 'libuv تبدأ timer مدته {delay}ms للدالة {value}.',
		timerExpired: 'انتهى وقت الـ timer: الدالة {value} تدخل طابور الـ timers.',
		timerCancelled: 'تم إلغاء الـ timer الخاص بـ {value}.',
		immediateCancelled: 'تم إلغاء الـ immediate {value}.',
		threadpoolStart: 'worker من الـ thread pool يبدأ {value}.',
		threadpoolQueued:
			'الـ 4 workers مشغولين: {value} تنتظر worker متاح (t = {start}ms).',
		handleOpen: 'تم فتح handle: {value}. وهي تُبقي الـ process حيًا.',
		ioStageDone: 'مرحلة الـ poll تلتقط syscall انتهى: {value}',
		ioDone: 'انتهى الـ I/O: الـ callback {value} يدخل طابور الـ poll.',
		queueNextTick: 'تمت إضافة {value} إلى طابور الـ nextTick.',
		queuePromise:
			'تم حسم (settle) الـ promise: {value} تدخل طابور الـ Promises.',
		queueAwait: '{value} ستُستكمل كـ microtask.',
		queueThenable: 'الـ resolve بـ thenable يكلّف microtask إضافية: {value}',
		queueMicrotask:
			'الدالة queueMicrotask() أضافت {value} إلى طابور الـ Promises.',
		queueImmediate: 'تمت إضافة {value} إلى طابور الـ check (setImmediate).',
		queueClose: 'تمت إضافة {value} إلى طابور الـ close.',
		runNextTick: 'تنفيذ nextTick callback: {value}',
		runMicrotask: 'تنفيذ microtask: {value}',
		runTimer: 'تنفيذ timer callback: {value}',
		runIo: 'تنفيذ poll callback: {value}',
		runImmediate: 'تنفيذ setImmediate callback: {value}',
		runClose: 'تنفيذ close callback: {value}',
		end: 'لا توجد refs متبقية: الـ process تنتهي بـ exit code {code}.',
		endCrashed: 'توقفت الـ process بشكل مفاجئ (exit code {code}).',
		endTruncated: 'توقف — هذا البرنامج يُبقي الـ loop مشغولًا للأبد.',
	},
};
