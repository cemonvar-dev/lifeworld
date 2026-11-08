// Interface translations. English is the source language: strings are looked up
// by their English text, and anything without a translation stays in English.
// Rendered text is translated automatically; use _t() for text that never reaches
// the page (dialogs, notifications) or that contains variables. Mark user content
// with translate="no" so it's left alone.
(function () {
	const LOCALES = { en: 'en-GB', de: 'de-DE', fr: 'fr-FR', nl: 'nl-NL', es: 'es-ES', it: 'it-IT', tr: 'tr-TR' };
	const STORAGE_KEY = 'lw_language';
	const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
	const SKIP_PARENTS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'TITLE']);

	window.I18N_MESSAGES = window.I18N_MESSAGES || {};
	let lang = 'en';
	let messages = {};
	let patterns = [];
	let loadToken = 0;
	let textState = new WeakMap();
	let attrState = new WeakMap();

	function initialLanguage() {
		let stored = null;
		try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
		if (LOCALES[stored]) return stored;
		const preferred = navigator.languages || [navigator.language || 'en'];
		return preferred.map(l => l.slice(0, 2).toLowerCase()).find(l => LOCALES[l]) || 'en';
	}

	function format(text, vars) {
		return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match)) : text;
	}

	function _t(key, vars) {
		return format(messages[key] || key, vars);
	}

	function compilePatterns() {
		patterns = Object.keys(messages).filter(key => key.includes('{n}')).map(key => ({
			regex: new RegExp('^' + key.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('{n}', '(\\d+)') + '$'),
			output: messages[key]
		}));
	}

	function lookup(text) {
		if (messages[text]) return messages[text];
		const counted = text.match(/^(.*) \((\d+)\)$/);
		if (counted && messages[counted[1]]) return `${messages[counted[1]]} (${counted[2]})`;
		if (/\d/.test(text)) {
			for (const pattern of patterns) {
				const match = text.match(pattern.regex);
				if (match) return format(pattern.output, { n: match[1] });
			}
		}
		return null;
	}

	// Translate a string, keeping surrounding spaces, emoji and symbols.
	function translateString(value) {
		if (!/\p{L}/u.test(value)) return null;
		const [, leading, core, trailing] = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
		const whole = lookup(core);
		if (whole) return leading + whole + trailing;
		const [, prefix, inner, suffix] = core.match(/^([^\p{L}\p{N}(]*)([\s\S]*?)([^\p{L}\p{N}.!?…)]*)$/u);
		const translated = inner !== core && lookup(inner);
		return translated ? leading + prefix + translated + suffix + trailing : null;
	}

	const isExcluded = element => !element || !!element.closest('[translate="no"]');

	function translateTextNode(node) {
		const parent = node.parentElement;
		if (!parent || SKIP_PARENTS.has(parent.tagName) || isExcluded(parent)) return;
		const value = node.nodeValue;
		const state = textState.get(node);
		if (state && value === state.output) return;
		const output = translateString(value);
		if (output && output !== value) {
			textState.set(node, { source: value, output });
			node.nodeValue = output;
		} else {
			textState.delete(node);
		}
	}

	function translateAttribute(element, name) {
		if (isExcluded(element) || !element.hasAttribute(name)) return;
		const value = element.getAttribute(name);
		const states = attrState.get(element) || {};
		if (states[name] && value === states[name].output) return;
		const output = translateString(value);
		if (output && output !== value) {
			states[name] = { source: value, output };
			attrState.set(element, states);
			element.setAttribute(name, output);
		} else {
			delete states[name];
		}
	}

	function eachElement(root, visit) {
		if (root.nodeType !== 1) return;
		visit(root);
		root.querySelectorAll('*').forEach(visit);
	}

	function eachTextNode(root, visit) {
		if (root.nodeType === 3) { visit(root); return; }
		if (root.nodeType !== 1) return;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) visit(walker.currentNode);
	}

	function translateTree(root) {
		eachTextNode(root, translateTextNode);
		eachElement(root, el => ATTRIBUTES.forEach(name => translateAttribute(el, name)));
	}

	const observer = new MutationObserver(records => {
		records.forEach(record => {
			if (record.type === 'childList') record.addedNodes.forEach(translateTree);
			else if (record.type === 'characterData') translateTextNode(record.target);
			else translateAttribute(record.target, record.attributeName);
		});
	});

	function startObserving() {
		observer.observe(document.documentElement, {
			subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES
		});
	}

	// Put every translated string back to English.
	function restoreEnglish() {
		observer.disconnect();
		eachTextNode(document.documentElement, node => {
			const state = textState.get(node);
			if (state && node.nodeValue === state.output) node.nodeValue = state.source;
		});
		eachElement(document.documentElement, el => {
			const states = attrState.get(el);
			if (!states) return;
			Object.keys(states).forEach(name => {
				if (el.getAttribute(name) === states[name].output) el.setAttribute(name, states[name].source);
			});
		});
		textState = new WeakMap();
		attrState = new WeakMap();
	}

	function loadMessages(code) {
		if (code === 'en' || window.I18N_MESSAGES[code]) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = `i18n/${code}.js?v=2`;
			script.onload = resolve;
			script.onerror = reject;
			document.head.appendChild(script);
		});
	}

	async function setLanguage(code) {
		if (!LOCALES[code]) return;
		const token = ++loadToken;
		try {
			await loadMessages(code);
		} catch (e) {
			console.error('Could not load language:', code, e);
			return;
		}
		if (token !== loadToken) return;
		restoreEnglish();
		lang = code;
		messages = window.I18N_MESSAGES[code] || {};
		compilePatterns();
		document.documentElement.lang = code;
		try { localStorage.setItem(STORAGE_KEY, code); } catch (e) {}
		if (code !== 'en') {
			translateTree(document.documentElement);
			startObserving();
		}
		window.dispatchEvent(new Event('i18n-change'));
	}

	// Dates follow the chosen language unless the caller names a locale.
	['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'].forEach(method => {
		const original = Date.prototype[method];
		Date.prototype[method] = function (locales, options) {
			return original.call(this, locales === undefined ? LOCALES[lang] : locales, options);
		};
	});

	window._t = _t;
	window.i18n = {
		get lang() { return lang; },
		setLanguage,
		dayName: (day, style) => new Date(2023, 0, 1 + day).toLocaleDateString(LOCALES[lang], { weekday: style })
	};

	// Avoid a flash of English while the language file loads.
	const firstLanguage = initialLanguage();
	if (firstLanguage === 'en') {
		lang = 'en';
	} else {
		const root = document.documentElement;
		root.style.visibility = 'hidden';
		const reveal = () => { root.style.visibility = ''; };
		setTimeout(reveal, 2000);
		setLanguage(firstLanguage).finally(reveal);
	}
})();
