// Today view — "one thing at a time" (redesign phase 1, from alternative2.html).
// A date strip, one big Up next card, the rest of the day queued below, and a
// garden panel with health per area. The existing tile grid stays as "All tiles".
// Uses app.js globals: tiles, rawTiles, getTodaySummary, quickLog, openTilePopup,
// tilePlant, tileTimeOfDay, tileSuggestion, getNextDueLabel, todayLocal, escapeHtml,
// tagPath, TAGS, addNewTile, _t; tilecal.js: window.clearTileDay; quicklist.js: window.openTagList.
(function () {
	const VIEW_KEY = 'lw_view';
	const SLOT_ORDER = { morning: 0, afternoon: 1, evening: 2, night: 3 };
	const SLOT_ICON = { morning: '🌅', afternoon: '☀️', evening: '🌇', night: '🌙' };
	const FINISHED = ['completed', 'cancelled', 'failed'];
	let view = 'today';
	try { const v = localStorage.getItem(VIEW_KEY); view = v === 'tiles' || v === 'week' ? v : 'today'; } catch (e) {}
	let selDay = null;      // 'YYYY-MM-DD' of the selected strip day; null = today
	let busy = false;       // focus-card animation running: hold re-renders until it ends
	let pending = false;
	let toastTimer = null;

	const css = `
	#viewTabs{display:flex;gap:4px;padding:4px;margin:0 auto 14px;width:max-content;max-width:100%;border-radius:999px;background:rgba(255,255,255,.75);border:1px solid #e9e5f3;box-shadow:0 4px 14px rgba(76,62,140,.06)}
	#viewTabs button{height:36px;padding:0 16px;border-radius:999px;font-weight:700;font-size:14px;color:#6a6683;display:inline-flex;align-items:center;gap:6px;transition:all .15s}
	#viewTabs button{white-space:nowrap}
	@media (max-width:420px){#viewTabs button{padding:0 11px;font-size:13px;gap:4px}}
	#viewTabs button.on{background:#f0edff;color:#6b5fd6;box-shadow:inset 0 0 0 1px #dcd5ff}
	#focusView{--fv-line:#ece7f5;--fv-ink2:#6a6683;--fv-ink3:#a19db6}
	.fv-strip{display:flex;gap:8px;overflow-x:auto;padding:4px 2px 10px;margin-bottom:12px;scrollbar-width:none}
	.fv-strip::-webkit-scrollbar{display:none}
	.fv-day{flex:none;width:56px;padding:9px 0 8px;border-radius:18px;background:#fff;border:1px solid var(--fv-line);display:flex;flex-direction:column;align-items:center;gap:1px;transition:transform .15s}
	.fv-day:hover{transform:translateY(-2px)}
	.fv-day small{font-size:10.5px;font-weight:700;color:var(--fv-ink3);text-transform:uppercase;letter-spacing:.04em}
	.fv-day b{font-size:18px;font-weight:800;color:#33304a}
	.fv-day.past{opacity:.8}
	.fv-day.today{background:#f0edff;border-color:#dcd5ff}
	.fv-day.today small,.fv-day.today b{color:#6b5fd6}
	.fv-day.sel{box-shadow:0 0 0 3px #dcd5ff}
	.fv-pips{display:flex;gap:3px;height:6px;margin-top:3px}
	.fv-pips i{width:6px;height:6px;border-radius:50%;background:#ebe7f3}
	.fv-pips i.d{background:#a8dfc4}.fv-pips i.s{background:#f3d79c}.fv-pips i.m{background:#f5c0bc}
	.fv-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:20px;align-items:start}
	@media (max-width:900px){.fv-grid{grid-template-columns:1fr}}
	.fv-hello{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:14px}
	.fv-hello h1{font-size:clamp(24px,3vw,32px);font-weight:800;letter-spacing:-.02em;line-height:1.1;color:#33304a}
	.fv-hello p{margin-top:4px;color:var(--fv-ink2);font-size:14px}
	.fv-bar{width:150px;flex:none}
	.fv-bar .t{height:9px;border-radius:999px;background:#efeaf8;overflow:hidden}
	.fv-bar .f{height:100%;border-radius:999px;background:linear-gradient(90deg,#b9e6cf,#8fd6b4);transition:width .5s cubic-bezier(.2,.8,.2,1)}
	.fv-bar small{display:block;text-align:right;margin-top:5px;font-size:12px;font-weight:700;color:var(--fv-ink3)}
	.fv-card{background:#fff;border:1px solid var(--fv-line);border-radius:24px;box-shadow:0 2px 4px rgba(76,62,140,.04),0 10px 30px rgba(76,62,140,.07)}
	.fv-focus{position:relative;overflow:hidden;padding:24px;background:var(--a-bg,#f4f1ff);border-color:var(--a-line,#e2dcf6)}
	.fv-focus.enter{animation:fvIn .45s cubic-bezier(.2,.8,.2,1)}
	.fv-focus.leave{animation:fvOut .28s ease-in forwards}
	@keyframes fvIn{from{opacity:0;transform:translateX(40px) scale(.98)}to{opacity:1;transform:none}}
	@keyframes fvOut{to{opacity:0;transform:translateX(-50px) scale(.97)}}
	.fv-eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--fv-ink2);background:#fff;padding:6px 12px;border-radius:999px;box-shadow:inset 0 0 0 1px var(--a-line,#e2dcf6);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
	.fv-main{display:flex;gap:18px;align-items:center;margin:20px 0}
	.fv-main h2{font-size:clamp(24px,3.2vw,34px);font-weight:800;letter-spacing:-.02em;line-height:1.12;color:#33304a;word-break:break-word}
	.fv-why{margin-top:8px;color:var(--fv-ink2);line-height:1.5;font-size:14.5px}
	.fv-plant{position:relative;flex:none}
	.fv-plant svg{transform:rotate(-90deg);display:block}
	.fv-plant .arc{transition:stroke-dashoffset .8s cubic-bezier(.2,.8,.2,1)}
	.fv-plant span{position:absolute;inset:0;display:grid;place-items:center}
	.fv-plant.grow span{animation:fvGrow .7s cubic-bezier(.3,1.6,.5,1)}
	@keyframes fvGrow{0%{transform:scale(1)}35%{transform:scale(.7) rotate(-8deg)}70%{transform:scale(1.3) rotate(4deg)}100%{transform:scale(1)}}
	.fv-actions{display:flex;gap:10px}
	.fv-big{height:52px;padding:0 22px;border-radius:17px;font-weight:800;font-size:15.5px;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:transform .15s,background .15s}
	.fv-big:active{transform:scale(.97)}
	.fv-big.done{flex:1;background:#fff;color:#2e9470;box-shadow:inset 0 0 0 2px #bde8d4,0 6px 16px rgba(46,148,112,.12)}
	.fv-big.done:hover,.fv-big.done.on{background:#e6f7ef}
	.fv-big.soft{background:rgba(255,255,255,.75);color:var(--fv-ink2);box-shadow:inset 0 0 0 1px var(--fv-line)}
	.fv-big.soft:hover{background:#fff}
	.fv-meta{display:flex;flex-wrap:wrap;gap:14px;margin-top:16px;font-size:13px;color:var(--fv-ink2)}
	.fv-late{color:#cf5b55}
	.fv-calm{text-align:center;padding:44px 24px;background:linear-gradient(135deg,#eafaf2,#f2edff)}
	.fv-calm .e{font-size:52px;display:inline-block;animation:fvGrow .9s cubic-bezier(.3,1.6,.5,1)}
	.fv-calm h2{margin-top:8px;font-size:24px;font-weight:800;color:#33304a}
	.fv-calm p{margin-top:6px;color:var(--fv-ink2)}
	.fv-calm button{margin-top:14px}
	.fv-qhead{display:flex;justify-content:space-between;align-items:baseline;margin:24px 4px 10px}
	.fv-qhead h3{font-size:17px;font-weight:800;color:#33304a}
	.fv-qhead small{color:var(--fv-ink3);font-weight:700}
	.fv-q{display:flex;align-items:center;gap:12px;padding:10px 12px 10px 10px;border-radius:18px;background:#fff;border:1px solid var(--fv-line);margin-bottom:8px;cursor:pointer;transition:transform .15s,box-shadow .15s}
	.fv-q:hover{transform:translateX(3px);box-shadow:0 6px 18px rgba(76,62,140,.08)}
	.fv-q .ic{width:40px;height:40px;border-radius:13px;display:grid;place-items:center;font-size:19px;background:var(--a-bg,#f4f1ff);flex:none}
	.fv-q .tx{flex:1;min-width:0}
	.fv-q .tx b{display:block;font-weight:700;color:#33304a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	.fv-q .tx small{font-size:12.5px;color:var(--fv-ink3)}
	.fv-q.done,.fv-q.skipped{opacity:.6}
	.fv-q.done .tx b,.fv-q.skipped .tx b{text-decoration:line-through;text-decoration-color:#c9c5d8}
	.fv-tick{width:34px;height:34px;border-radius:11px;border:2px solid var(--fv-line);background:#fff;display:grid;place-items:center;color:transparent;font-weight:800;flex:none;transition:all .15s}
	.fv-tick:hover{border-color:#bde8d4;color:#bde8d4}
	.fv-q.done .fv-tick{background:#e6f7ef;border-color:#bde8d4;color:#2e9470}
	.fv-q.skipped .fv-tick{background:#fff4de;border-color:#f5dfac;color:#b07a1a}
	.fv-tag{display:inline-flex;align-items:center;gap:5px}
	.fv-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
	.fv-panel{padding:18px}
	.fv-panel h3{display:flex;justify-content:space-between;align-items:baseline;font-size:16px;font-weight:800;color:#33304a;margin-bottom:12px}
	.fv-panel h3 small{font-size:12px;font-weight:600;color:var(--fv-ink3)}
	.fv-garden{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
	.fv-g{padding:12px 6px;border-radius:18px;background:var(--a-bg,#f4f1ff);text-align:center;border:1px solid transparent;transition:all .15s;min-width:0}
	.fv-g:hover{border-color:var(--a-line,#e2dcf6);transform:translateY(-2px)}
	.fv-g .fv-plant{margin:0 auto 6px}
	.fv-g b{display:block;font-size:12.5px;font-weight:700;color:#33304a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	.fv-g small{font-size:11px;color:var(--fv-ink3)}
	.fv-leaf{position:fixed;z-index:9999;pointer-events:none;font-size:22px;transform:translate(-50%,-50%);animation:fvFly 1.1s cubic-bezier(.15,.8,.3,1) forwards}
	@keyframes fvFly{0%{opacity:0;transform:translate(-50%,-50%) scale(.4)}15%{opacity:1}75%{opacity:1}100%{opacity:0;transform:translate(calc(-50% + var(--dx)),calc(-50% + var(--dy))) rotate(var(--rot))}}
	@media (max-width:640px){.fv-focus{padding:18px}.fv-main{gap:14px;margin:16px 0}.fv-bar{width:100px}.fv-big{padding:0 16px}}
	@media (prefers-reduced-motion:reduce){#focusView *{animation:none!important;transition:none!important}}
	.wk-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:10px;flex-wrap:wrap}
	.wk-head h1{font-size:clamp(24px,3vw,32px);font-weight:800;letter-spacing:-.02em;color:#33304a;line-height:1.1}
	.wk-head p{margin-top:4px;color:#6a6683;font-size:14px}
	.wk-nav{display:flex;gap:6px}
	.wk-nav button{min-width:38px;height:38px;padding:0 10px;border-radius:12px;background:#fff;border:1px solid #ece7f5;font-size:20px;font-weight:700;color:#6a6683}
	.wk-nav button.txt{font-size:13px;color:#6b5fd6;background:#f0edff;border-color:#dcd5ff}
	.wk-nav button:hover{border-color:#dcd5ff}
	.wk-legend{display:flex;flex-wrap:wrap;gap:14px;margin:0 2px 12px;font-size:12px;font-weight:600;color:#a19db6}
	.wk-legend i{display:inline-block;width:11px;height:11px;border-radius:4px;margin-right:5px;vertical-align:-1px;background:#fff;box-shadow:inset 0 0 0 1.5px #d9d4e8}
	.wk-legend i.d{background:#bde8d4;box-shadow:none}.wk-legend i.s{background:#f5dfac;box-shadow:none}.wk-legend i.m{background:#fff;box-shadow:inset 0 0 0 1.5px #f2b8b3}
	.wk-board{display:grid;grid-template-columns:repeat(7,minmax(130px,1fr));gap:10px;overflow-x:auto;padding-bottom:8px}
	.wk-col{background:rgba(255,255,255,.65);border:1px solid #ece7f5;border-radius:20px;padding:10px 8px;min-height:300px}
	.wk-col.now{background:#fff;border-color:#dcd5ff;box-shadow:0 0 0 3px #f0edff}
	.wk-col h4{display:flex;justify-content:space-between;align-items:baseline;margin:0 4px 10px;font-size:13px;font-weight:800;color:#6a6683;cursor:pointer}
	.wk-col h4 b{font-weight:700;color:#a19db6}
	.wk-col.now h4,.wk-col.now h4 b{color:#6b5fd6}
	.wk-items{display:flex;flex-direction:column;gap:6px}
	.wk-chip{display:flex;align-items:center;gap:7px;padding:8px 9px;border-radius:13px;background:var(--a-bg,#f4f1ff);border:1px solid var(--a-line,#e6e1f5);font-size:12.5px;font-weight:600;color:#33304a;cursor:pointer;min-width:0;transition:transform .15s}
	.wk-chip:hover{transform:translateY(-1px)}
	.wk-chip span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
	.wk-k{width:17px;height:17px;border-radius:6px;border:2px solid var(--a,#b7aef0);flex:none;display:grid;place-items:center;font-size:10px;font-weight:800;color:#fff;background:#fff;padding:0}
	button.wk-k:hover{background:#e6f7ef;border-color:#8fd6b4}
	.wk-chip.done .wk-k{background:var(--a,#8fd6b4);border-color:var(--a,#8fd6b4)}
	.wk-chip.skipped .wk-k{background:#fff4de;border-color:#f5dfac;color:#b07a1a}
	.wk-chip.done,.wk-chip.skipped{opacity:.65}
	.wk-chip.done span:last-child,.wk-chip.skipped span:last-child{text-decoration:line-through}
	.wk-chip.missed{background:#fff;border-style:dashed;border-color:#f2b8b3}
	.wk-free{font-size:12.5px;color:#a19db6;padding:4px}
	@media (max-width:700px){
		.wk-board{grid-template-columns:1fr;overflow:visible;gap:8px}
		.wk-col{min-height:0;display:flex;gap:10px;align-items:flex-start;padding:10px}
		.wk-col h4{flex-direction:column;align-items:center;width:42px;margin:0;flex:none;padding-top:3px;gap:0}
		.wk-col h4 b{font-size:18px;color:#33304a}
		.wk-col.past{opacity:.85}
		.wk-items{flex:1;flex-direction:row;flex-wrap:wrap;min-width:0}
		.wk-chip{max-width:100%}
	}`;

	const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	const parse = s => new Date(s + 'T00:00:00');
	const esc = s => escapeHtml(String(s ?? ''));
	const isFinished = t => FINISHED.includes(t.taskStatus);

	// Pastel tint for a tile's first tag (tag colour mixed into white).
	function tint(tile) {
		const id = (tile.tags || [])[0];
		const c = id && window.tagColor ? window.tagColor(id) : '';
		if (!c) return '';
		return `--a:${c};--a-bg:color-mix(in srgb, ${c} 13%, white);--a-line:color-mix(in srgb, ${c} 35%, white)`;
	}
	function tagLabel(tile) {
		const id = (tile.tags || [])[0];
		if (!id) return '';
		const c = window.tagColor ? window.tagColor(id) : '';
		return `<span class="fv-tag" translate="no">${c ? `<span class="fv-dot" style="background:${c}"></span>` : ''}${esc(tagPath(id))}</span>`;
	}
	function freqLabel(raw) {
		const mode = (raw && raw.frequency_mode) || 'daily';
		return { daily: _t('Daily'), weekly: _t('Weekly'), monthly: _t('Monthly'), once: _t('One-time') }[mode] || '';
	}
	function shortDate(s) {
		if (!s) return '';
		return new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	}
	const healthIcon = tile => tilePlant({ status: tile.taskStatus }, tile.health).emoji;

	// Ring that fills with health, the tile's health icon in the middle.
	function plant(tile, size, fromHealth) {
		const r = size / 2 - 5, c = 2 * Math.PI * r;
		const h = fromHealth ?? tile.health;
		const stroke = tint(tile) ? 'var(--a)' : '#9f93ec';
		return `<div class="fv-plant" style="width:${size}px;height:${size}px" data-c="${c}"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
			<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="#fff" stroke="rgba(255,255,255,.9)" stroke-width="6"/>
			<circle class="arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${stroke}" stroke-opacity=".6" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - h / 100)}"/>
			</svg><span style="font-size:${Math.round(size * .42)}px">${tilePlant({ status: tile.taskStatus }, h).emoji}</span></div>`;
	}

	// Today's list: scheduled + overdue one-time tasks, most urgent first.
	function todayItems() {
		const { done, skipped, remaining } = getTodaySummary();
		const ids = new Set(remaining.map(t => t.id));
		tiles.forEach(t => {
			if (!ids.has(t.id) && !isFinished(t) && t.status === 'noaction' && getNextDueLabel(t.id) === 'overdue') { remaining.push(t); ids.add(t.id); }
		});
		const late = t => getNextDueLabel(t.id) === 'overdue';
		const slot = t => SLOT_ORDER[tileTimeOfDay(rawTiles[t.id])] ?? 9;
		remaining.sort((a, b) => (late(b) - late(a)) || (slot(a) - slot(b)) || (a.health - b.health));
		return { done, skipped, remaining };
	}

	function renderStrip() {
		const today = new Date(); today.setHours(0, 0, 0, 0);
		const todayStr = iso(today);
		let html = '';
		for (let i = -6; i <= 7; i++) {
			const d = new Date(today); d.setDate(today.getDate() + i);
			const day = iso(d);
			const s = getTodaySummary(i === 0 ? undefined : day);
			const pips = [...s.done.map(() => 'd'), ...s.skipped.map(() => 's'), ...s.remaining.map(() => i < 0 ? 'm' : '')].slice(0, 4);
			const sel = (selDay || todayStr) === day;
			html += `<button type="button" class="fv-day ${i < 0 ? 'past' : ''} ${i === 0 ? 'today' : ''} ${sel ? 'sel' : ''}" data-day="${day}">
				<small>${i === 0 ? esc(_t('Today')) : esc(d.toLocaleDateString(undefined, { weekday: 'short' }))}</small><b>${d.getDate()}</b>
				<span class="fv-pips">${pips.map(p => `<i class="${p}"></i>`).join('')}</span></button>`;
		}
		const strip = document.getElementById('fvStrip');
		strip.innerHTML = html;
		setTimeout(() => {   // after layout (the view may have just been unhidden)
			const s = strip.querySelector('.sel');
			if (s) strip.scrollLeft = s.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + s.clientWidth / 2;
		}, 0);
	}

	function queueRow(t, state, opts = {}) {
		const raw = rawTiles[t.id];
		const slot = tileTimeOfDay(raw);
		const bits = [];
		if (slot) bits.push(`${SLOT_ICON[slot] || ''} ${esc(_t(slot.charAt(0).toUpperCase() + slot.slice(1)))}`);
		const tag = tagLabel(t);
		if (tag) bits.push(tag);
		if (opts.late) bits.push(`<span class="fv-late">${esc(_t('Overdue'))}</span>`);
		if (state === 'missed') bits.push(`<span class="fv-late">${esc(_t('Missed'))}</span>`);
		const tick = opts.tick ? `<button type="button" class="fv-tick" data-fv-tick="${t.id}" aria-label="${esc(_t('Done'))}">${state === 'skipped' ? '⏭' : '✓'}</button>` : '';
		return `<div class="fv-q ${state === 'done' ? 'done' : state === 'skipped' ? 'skipped' : ''}" style="${tint(t)}" data-fv-open="${t.id}">
			<div class="ic">${healthIcon(t)}</div>
			<div class="tx"><b translate="no">${esc(t.name)}</b><small>${bits.join(' · ') || esc(freqLabel(raw))}</small></div>${tick}</div>`;
	}

	function renderMain(enter) {
		const todayStr = todayLocal();
		const day = selDay || todayStr;
		const isToday = day === todayStr, future = day > todayStr;
		const longDate = parse(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
		const hr = new Date().getHours();
		let focusHtml = '', queueHtml = '', title = '', count = '';
		let total = 0, handled = 0;

		if (isToday) {
			const { done, skipped, remaining } = todayItems();
			total = done.length + skipped.length + remaining.length;
			handled = done.length + skipped.length;
			document.getElementById('fvHi').textContent = (hr < 12 ? _t('Good morning') : hr < 18 ? _t('Good afternoon') : _t('Good evening')) + ' 👋';
			document.getElementById('fvSub').textContent = `${longDate} · ${_t('{n} to go', { n: remaining.length })}`;
			const f = remaining[0];
			if (f) {
				const raw = rawTiles[f.id];
				const late = getNextDueLabel(f.id) === 'overdue';
				const hint = f.health < 40 ? tileSuggestion(raw)?.hint : '';
				const why = hint || [freqLabel(raw), f.lastDone ? _t('Last done {date}', { date: shortDate(f.lastDone) }) : _t('Not done yet')].filter(Boolean).join(' · ');
				const eyebrow = late ? `⏰ ${_t('Needs you')}` : f.health < 40 ? `🌱 ${_t('Needs care')}` : `🎯 ${_t('Up next')}`;
				const tagText = (f.tags || [])[0] ? ` · ${tagPath(f.tags[0])}` : '';
				focusHtml = `<div class="fv-card fv-focus ${enter ? 'enter' : ''}" style="${tint(f)}" data-fv-focus="${f.id}">
					<span class="fv-eyebrow"><span>${esc(eyebrow)}</span><span translate="no">${esc(tagText)}</span></span>
					<div class="fv-main">${plant(f, 92)}<div style="min-width:0"><h2 translate="no">${esc(f.name)}</h2><div class="fv-why">${esc(why)}</div></div></div>
					<div class="fv-actions">
						<button type="button" class="fv-big done" data-fv-done="${f.id}">✓ ${esc(_t('Done'))}</button>
						<button type="button" class="fv-big soft" data-fv-skip="${f.id}">${esc(_t('Skip'))}</button>
						<button type="button" class="fv-big soft" data-fv-open="${f.id}" aria-label="${esc(_t('Details'))}">⋯</button>
					</div>
					<div class="fv-meta"><span>🔁 ${esc(freqLabel(raw))}</span><span>${healthIcon(f)} ${esc(_t(f.healthLabel || ''))}</span>${late ? `<span class="fv-late">⏰ ${esc(_t('Overdue'))}</span>` : ''}</div>
				</div>`;
			} else if (total) {
				focusHtml = `<div class="fv-card fv-calm"><div class="e">🌳</div><h2>${esc(_t('All done for today'))}</h2><p>${esc(_t('Your garden thanks you. Rest well.'))} 🌙</p></div>`;
			} else {
				focusHtml = `<div class="fv-card fv-calm"><div class="e">☁️</div><h2>${esc(_t('Nothing planned today'))}</h2><p>${esc(_t('Enjoy the quiet, or add something new.'))}</p>
					<button type="button" class="fv-big done" style="flex:none" data-fv-add>＋ ${esc(_t('New tile'))}</button></div>`;
			}
			const rest = remaining.slice(1);
			queueHtml = rest.map(t => queueRow(t, '', { tick: true, late: getNextDueLabel(t.id) === 'overdue' })).join('')
				+ done.map(t => queueRow(t, 'done', { tick: true })).join('')
				+ skipped.map(t => queueRow(t, 'skipped', { tick: true })).join('');
			title = f ? _t('After that') : _t('Handled today');
			count = rest.length + done.length + skipped.length;
		} else {
			const { done, skipped, remaining } = getTodaySummary(day);
			total = done.length + skipped.length + remaining.length;
			handled = done.length + skipped.length;
			document.getElementById('fvHi').textContent = longDate;
			document.getElementById('fvSub').textContent = future ? _t('{n} planned', { n: remaining.length }) : _t('{n} of {total} done that day', { n: handled, total });
			focusHtml = `<div class="fv-card fv-calm" style="padding:28px 24px"><div class="e">${future ? '📅' : '🗓️'}</div>
				<h2>${esc(future ? _t('Planned') : _t('Looking back'))}</h2><p>${esc(future ? _t('Open a tile to change its plan.') : _t('Open a tile to add or fix a log for that day.'))}</p>
				<button type="button" class="fv-big soft" style="flex:none" data-day="${todayStr}">← ${esc(_t('Back to today'))}</button></div>`;
			queueHtml = remaining.map(t => queueRow(t, future ? '' : 'missed')).join('')
				+ done.map(t => queueRow(t, 'done')).join('') + skipped.map(t => queueRow(t, 'skipped')).join('');
			title = future ? _t('Planned') : _t('That day');
			count = total;
		}
		document.querySelector('#focusView .fv-bar').style.visibility = future || !total ? 'hidden' : '';
		document.getElementById('fvFill').style.width = total ? `${handled / total * 100}%` : '0';
		document.getElementById('fvBarTxt').textContent = _t('{n} of {total} done', { n: handled, total });
		document.getElementById('fvFocus').innerHTML = focusHtml;
		document.getElementById('fvQTitle').textContent = title;
		document.getElementById('fvQCount').textContent = count ? String(count) : '';
		document.getElementById('fvQueue').innerHTML = queueHtml;
		document.getElementById('fvQHead').style.display = queueHtml ? '' : 'none';
	}

	// Health per top-level tag (including its sub-tags), tap opens that tag as a list.
	function renderGarden() {
		const tops = (TAGS || []).filter(t => !t.parent_id);
		const kids = id => (TAGS || []).filter(t => t.parent_id === id).flatMap(t => [t.id, ...kids(t.id)]);
		const cards = tops.map(tag => {
			const ids = new Set([tag.id, ...kids(tag.id)]);
			const members = tiles.filter(t => !isFinished(t) && (t.tags || []).some(id => ids.has(id)));
			if (!members.length) return null;
			const avg = Math.round(members.reduce((s, t) => s + t.health, 0) / members.length);
			return { tag, avg, n: members.length };
		}).filter(Boolean).slice(0, 9);
		const panel = document.getElementById('fvGardenPanel');
		panel.style.display = cards.length ? '' : 'none';
		document.getElementById('fvGarden').innerHTML = cards.map(({ tag, avg }) => {
			const c = window.tagColor ? window.tagColor(tag.id) : '';
			const fake = { tags: [tag.id], health: avg, taskStatus: 'in progress' };
			const label = tilePlant({}, avg).label;
			return `<button type="button" class="fv-g" style="${c ? tint(fake) : ''}" data-fv-tag="${tag.id}">${plant(fake, 52)}<b translate="no">${esc(tag.name)}</b><small>${esc(_t(label))}</small></button>`;
		}).join('');
	}

	function render(enter = false) {
		if (!document.getElementById('focusView')) return;
		if (busy) { pending = true; return; }
		if (selDay && selDay === todayLocal()) selDay = null;
		renderStrip();
		renderMain(enter);
		renderGarden();
	}

	function toast(text, undo) {
		document.getElementById('fvToast')?.remove();
		clearTimeout(toastTimer);
		const t = document.createElement('div');
		t.id = 'fvToast';
		t.className = 'fixed left-1/2 -translate-x-1/2 bottom-24 sm:bottom-8 z-[9999] flex items-center gap-3 max-w-[calc(100vw-2rem)] bg-white text-slate-700 border border-slate-200 text-sm font-semibold rounded-full shadow-lg shadow-slate-900/10 pl-4 pr-2 py-2';
		t.innerHTML = `<span class="truncate">${esc(text)}</span>`;
		if (undo) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'shrink-0 px-3 py-1 rounded-full font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100';
			b.textContent = _t('Undo');
			b.addEventListener('click', async () => { t.remove(); clearTimeout(toastTimer); await undo(); });
			t.appendChild(b);
		}
		document.body.appendChild(t);
		toastTimer = setTimeout(() => t.remove(), 5000);
	}

	function burst(el, n = 12, big = false) {
		if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
		const set = big ? ['🌸', '✨', '🍃', '🌼', '💚', '🌿'] : ['🍃', '✨', '🌿', '🍃', '🌸'];
		for (let i = 0; i < n; i++) {
			const s = document.createElement('span');
			s.className = 'fv-leaf';
			s.textContent = set[i % set.length];
			const ang = (i / n) * Math.PI * 2 + Math.random() * .6, dist = (big ? 150 : 85) + Math.random() * 60;
			s.style.left = cx + 'px'; s.style.top = cy + 'px';
			s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
			s.style.setProperty('--dy', Math.sin(ang) * dist - 40 + 'px');
			s.style.setProperty('--rot', (Math.random() * 280 - 140) + 'deg');
			document.body.appendChild(s);
			setTimeout(() => s.remove(), 1300);
		}
	}

	const statusOf = id => (tiles.find(t => t.id === id) || {}).status || 'noaction';
	function undoTo(id, prev) {
		return async () => {
			if (prev === 'done' || prev === 'skipped') await quickLog(id, prev);
			else if (window.clearTileDay) await window.clearTileDay(id, todayLocal());
		};
	}

	// Done on the Up next card: the ring fills, the plant bounces, leaves burst, the next card slides in.
	async function completeFocus(id) {
		if (busy) return;
		const card = document.querySelector('#fvFocus .fv-focus');
		const tile = tiles.find(t => t.id === id);
		if (!card || !tile) return;
		busy = true;
		const before = tile.health, beforeLabel = tile.healthLabel, prev = statusOf(id);
		const btn = card.querySelector('[data-fv-done]');
		btn.classList.add('on');
		btn.textContent = '✓ ' + _t('Nice!');
		const started = Date.now();
		try { await quickLog(id, 'done'); } catch (e) { console.error(e); }
		const p = card.querySelector('.fv-plant');
		if (p) {
			p.querySelector('.arc').style.strokeDashoffset = p.dataset.c * (1 - tile.health / 100);
			p.classList.add('grow');
			setTimeout(() => { p.querySelector('span').textContent = healthIcon(tile); }, 250);
			burst(p);
		}
		const grew = tile.health > before && tile.healthLabel !== beforeLabel;
		toast(grew ? `${healthIcon(tile)} ${_t('{name} grew to {label}!', { name: tile.name, label: _t(tile.healthLabel) })}` : `${healthIcon(tile)} ${tile.name} · ${_t('Done')}`, undoTo(id, prev));
		window.track?.('focus_done', { grew });
		setTimeout(() => {
			card.classList.add('leave');
			setTimeout(() => {
				busy = false; pending = false;
				render(true);
				const calm = document.querySelector('#fvFocus .fv-calm .e');
				if (calm && !selDay) burst(calm, 20, true);
			}, 280);
		}, Math.max(300, 850 - (Date.now() - started)));
	}

	async function logFromQueue(id, status) {
		const prev = statusOf(id);
		const tile = tiles.find(t => t.id === id);
		if (prev === status && window.clearTileDay) await window.clearTileDay(id, todayLocal());
		else await quickLog(id, status);
		if (prev !== status) toast(`${status === 'done' ? healthIcon(tile) : '⏭️'} ${tile.name} · ${_t(status === 'done' ? 'Done' : 'Skipped')}`, undoTo(id, prev));
	}

	// ---- Week board: Mon–Sun columns (a vertical day list on phones) ----
	let weekOffset = 0;   // 0 = this week, -1 = last week, …
	function renderWeek() {
		const box = document.getElementById('weekView');
		if (!box) return;
		const today = new Date(); today.setHours(0, 0, 0, 0);
		const todayStr = iso(today);
		const mon = new Date(today); mon.setDate(today.getDate() - (today.getDay() + 6) % 7 + weekOffset * 7);
		const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
		const fmt = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
		let total = 0, handled = 0;
		const cols = [];
		for (let i = 0; i < 7; i++) {
			const d = new Date(mon); d.setDate(mon.getDate() + i);
			const day = iso(d);
			const isToday = day === todayStr, future = day > todayStr;
			const { done, skipped, remaining } = getTodaySummary(isToday ? undefined : day);
			if (!future) { total += done.length + skipped.length + remaining.length; handled += done.length + skipped.length; }
			const chip = (t, state) => {
				const tick = isToday && (state === 'open' || state === 'done') ? `<button type="button" class="wk-k" data-wk-tick="${t.id}" aria-label="${esc(_t('Done'))}">${state === 'done' ? '✓' : ''}</button>` : `<span class="wk-k">${state === 'done' ? '✓' : state === 'skipped' ? '–' : ''}</span>`;
				return `<div class="wk-chip ${state}" style="${tint(t)}" data-fv-open="${t.id}" title="${esc(t.name)}">${tick}<span translate="no">${esc(t.name)}</span></div>`;
			};
			const slot = t => SLOT_ORDER[tileTimeOfDay(rawTiles[t.id])] ?? 9;
			const items = remaining.sort((a, b) => slot(a) - slot(b)).map(t => chip(t, future || isToday ? 'open' : 'missed'))
				.concat(done.map(t => chip(t, 'done')), skipped.map(t => chip(t, 'skipped')));
			cols.push(`<div class="wk-col ${isToday ? 'now' : ''} ${day < todayStr ? 'past' : ''}">
				<h4 data-day-open="${day}"><span>${esc(d.toLocaleDateString(undefined, { weekday: 'short' }))}</span><b>${d.getDate()}</b></h4>
				<div class="wk-items">${items.join('') || `<div class="wk-free">${esc(_t('Free day'))} ☁️</div>`}</div></div>`);
		}
		box.innerHTML = `
			<div class="wk-head">
				<div><h1>${esc(weekOffset === 0 ? _t('This week') : weekOffset === -1 ? _t('Last week') : weekOffset === 1 ? _t('Next week') : `${fmt(mon)} – ${fmt(sun)}`)}</h1>
					<p>${esc(`${fmt(mon)} – ${fmt(sun)}`)}${total ? ` · ${esc(_t('{n} of {total} done', { n: handled, total }))}` : ''}</p></div>
				<div class="wk-nav">
					<button type="button" data-wk-shift="-1" aria-label="${esc(_t('Previous week'))}">‹</button>
					${weekOffset ? `<button type="button" data-wk-shift="0" class="txt">${esc(_t('This week'))}</button>` : ''}
					<button type="button" data-wk-shift="1" aria-label="${esc(_t('Next week'))}">›</button>
				</div>
			</div>
			<div class="wk-legend"><span><i class="d"></i>${esc(_t('Done'))}</span><span><i class="s"></i>${esc(_t('Skipped'))}</span><span><i class="m"></i>${esc(_t('Missed'))}</span><span><i></i>${esc(_t('Planned'))}</span></div>
			<div class="wk-board">${cols.join('')}</div>`;
	}

	function setView(v) {
		view = ['tiles', 'week'].includes(v) ? v : 'today';
		try { localStorage.setItem(VIEW_KEY, view); } catch (e) {}
		const fv = document.getElementById('focusView');
		const wk = document.getElementById('weekView');
		const gallery = document.getElementById('gallery');
		if (!fv || !gallery) return;
		fv.classList.toggle('hidden', view !== 'today');
		wk.classList.toggle('hidden', view !== 'week');
		gallery.closest('section').classList.toggle('hidden', view !== 'tiles');
		document.querySelectorAll('#viewTabs [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === view));
		if (view === 'today') render();
		if (view === 'week') renderWeek();
	}

	function mount() {
		const gallerySection = document.getElementById('gallery')?.closest('section');
		if (!gallerySection || document.getElementById('focusView')) return;
		const style = document.createElement('style');
		style.textContent = css;
		document.head.appendChild(style);
		gallerySection.insertAdjacentHTML('beforebegin', `
			<nav id="viewTabs" aria-label="${esc(_t('View'))}">
				<button type="button" data-view="today">☀️ <span>${esc(_t('Today'))}</span></button>
				<button type="button" data-view="week">🗓️ <span>${esc(_t('Week'))}</span></button>
				<button type="button" data-view="tiles">🪴 <span>${esc(_t('All tiles'))}</span></button>
			</nav>
			<section id="weekView" class="flex-1 hidden"></section>
			<section id="focusView" class="flex-1 hidden">
				<div class="fv-strip" id="fvStrip"></div>
				<div class="fv-grid">
					<div>
						<div class="fv-hello"><div><h1 id="fvHi"></h1><p id="fvSub"></p></div>
							<div class="fv-bar"><div class="t"><div class="f" id="fvFill"></div></div><small id="fvBarTxt"></small></div></div>
						<div id="fvFocus"></div>
						<div class="fv-qhead" id="fvQHead"><h3 id="fvQTitle"></h3><small id="fvQCount"></small></div>
						<div id="fvQueue"></div>
					</div>
					<aside class="fv-card fv-panel" id="fvGardenPanel">
						<h3>${esc(_t('Your garden'))} <small>${esc(_t('health by area'))}</small></h3>
						<div class="fv-garden" id="fvGarden"></div>
					</aside>
				</div>
			</section>`);

		document.getElementById('viewTabs').addEventListener('click', e => {
			const b = e.target.closest('[data-view]');
			if (b) { setView(b.dataset.view); window.track?.('view_switched', { view: b.dataset.view }); }
		});
		document.getElementById('focusView').addEventListener('click', e => {
			const el = e.target.closest('[data-fv-done],[data-fv-skip],[data-fv-tick],[data-fv-open],[data-day],[data-fv-tag],[data-fv-add]');
			if (!el) return;
			const d = el.dataset;
			if (d.fvDone) completeFocus(d.fvDone);
			else if (d.fvSkip) logFromQueue(d.fvSkip, 'skipped');
			else if (d.fvTick) { e.stopPropagation(); logFromQueue(d.fvTick, statusOf(d.fvTick) === 'skipped' ? 'skipped' : 'done'); }
			else if (d.fvOpen) openTilePopup(d.fvOpen);
			else if (d.day) { selDay = d.day === todayLocal() ? null : d.day; render(true); }
			else if (d.fvTag) { if (window.openTagList) window.openTagList(d.fvTag); }
			else if (d.fvAdd !== undefined) addNewTile();
		});
		document.getElementById('weekView').addEventListener('click', async e => {
			const el = e.target.closest('[data-wk-tick],[data-wk-shift],[data-fv-open],[data-day-open]');
			if (!el) return;
			const d = el.dataset;
			if (d.wkTick) { e.stopPropagation(); await logFromQueue(d.wkTick, 'done'); }
			else if (d.wkShift !== undefined) { weekOffset = d.wkShift === '0' ? 0 : weekOffset + Number(d.wkShift); renderWeek(); }
			else if (d.fvOpen) openTilePopup(d.fvOpen);
			else if (d.dayOpen) { selDay = d.dayOpen === todayLocal() ? null : d.dayOpen; setView('today'); }   // a day heading opens it in Today
		});
		// Searching only filters the tile grid, so typing switches to it.
		document.getElementById('searchBox')?.addEventListener('input', e => { if (e.target.value.trim() && view !== 'tiles') setView('tiles'); });
		window.addEventListener('i18n-change', () => {
			document.querySelector('#viewTabs [data-view="today"] span').textContent = _t('Today');
			document.querySelector('#viewTabs [data-view="week"] span').textContent = _t('Week');
			document.querySelector('#viewTabs [data-view="tiles"] span').textContent = _t('All tiles');
			window.refreshFocusView();
		});
		setView(view);
	}

	window.refreshFocusView = () => { if (view === 'today') render(); else if (view === 'week') renderWeek(); };
	window.setLwView = v => { if (v === 'today') selDay = null; setView(v); };
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
