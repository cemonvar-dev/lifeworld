// Touch swipes on gallery cards: right = Done, left = Skip (again on the same
// status clears it), with a pastel reveal underneath and Undo. Mostly-vertical
// moves keep scrolling; a still long-press keeps dragging (tiledrag.js).
// Uses app.js globals: tiles, quickLog, todayLocal, escapeHtml, _t.
(function () {
	const THRESHOLD = 0.35;   // share of card width needed to trigger
	const DECIDE_PX = 10;     // movement before deciding swipe vs scroll
	let s = null;             // { tile, id, x0, y0, dx, decided, swiping, under, grid, w, armed }
	let undoTimer = null;

	const selecting = () => document.body.classList.contains('tile-selecting') || document.body.classList.contains('tile-dragging');
	const isControl = el => el.closest('button, a, input, textarea, select');
	const statusOf = id => (tiles.find(t => t.id === id) || {}).status || 'noaction';

	function makeUnderlay(tile) {
		const grid = tile.parentElement;
		if (getComputedStyle(grid).position === 'static') grid.style.position = 'relative';
		const r = tile.getBoundingClientRect(), g = grid.getBoundingClientRect();
		const u = document.createElement('div');
		u.setAttribute('aria-hidden', 'true');
		Object.assign(u.style, { position: 'absolute', left: (r.left - g.left) + 'px', top: (r.top - g.top) + 'px', width: r.width + 'px', height: r.height + 'px', zIndex: '0', borderRadius: '0.75rem', display: 'flex', alignItems: 'center', padding: '0 18px', fontWeight: '700', fontSize: '14px', transition: 'background-color .15s' });
		grid.appendChild(u);
		tile.style.position = 'relative';
		tile.style.zIndex = '1';
		tile.style.transition = 'none';
		tile.dataset.swipeBg = tile.style.background || '';
		tile.style.background = '#fff'; // the card is translucent; keep neighbours from showing through
		tile.style.boxShadow = '0 8px 22px rgba(15,23,42,.16)';
		return u;
	}

	function paint(dx) {
		const right = dx > 0;
		const st = statusOf(s.id);
		const clearing = right ? st === 'done' || st === 'completed' : st === 'skipped';
		const armed = Math.abs(dx) >= s.w * THRESHOLD;
		const label = clearing ? `↺ ${_t('Clear')}` : right ? `✅ ${_t('Done')}` : `⏭️ ${_t('Skip')}`;
		const bg = clearing ? (armed ? '#e2e8f0' : '#f1f5f9') : right ? (armed ? '#bbf7d0' : '#dcfce7') : (armed ? '#fde68a' : '#fef3c7');
		const fg = clearing ? '#475569' : right ? '#047857' : '#b45309';
		s.under.style.background = bg;
		s.under.style.color = fg;
		s.under.style.justifyContent = right ? 'flex-start' : 'flex-end';
		s.under.textContent = label;
		if (armed !== s.armed) { s.armed = armed; if (armed && navigator.vibrate) try { navigator.vibrate(12); } catch (e) {} }
		s.tile.style.transform = `translateX(${dx}px) rotate(${dx / s.w * 2}deg)`;
	}

	function reset(animated) {
		if (!s) return;
		const { tile, under } = s;
		tile.style.transition = animated ? 'transform .22s ease' : 'none';
		tile.style.transform = '';
		setTimeout(() => { tile.style.transition = ''; tile.style.zIndex = ''; tile.style.background = tile.dataset.swipeBg || ''; tile.style.boxShadow = ''; under.remove(); }, animated ? 230 : 0);
	}

	function toast(text, undo) {
		document.getElementById('tileMoveToast')?.remove();
		clearTimeout(undoTimer);
		const t = document.createElement('div');
		t.id = 'tileMoveToast';
		t.className = 'fixed left-1/2 -translate-x-1/2 bottom-24 z-[9999] flex items-center gap-3 max-w-[calc(100vw-2rem)] bg-white text-slate-700 border border-slate-200 text-sm rounded-xl shadow-lg shadow-slate-900/10 pl-4 pr-2 py-2';
		t.innerHTML = `<span class="truncate">${escapeHtml(text)}</span>`;
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'shrink-0 px-3 py-1 rounded-lg font-semibold text-blue-600 hover:bg-blue-50';
		b.textContent = _t('Undo');
		b.addEventListener('click', async () => { t.remove(); clearTimeout(undoTimer); await undo(); window.track?.('swipe_undone'); });
		t.appendChild(b);
		document.body.appendChild(t);
		undoTimer = setTimeout(() => t.remove(), 6000);
	}

	async function commit(id, right) {
		const prev = statusOf(id);
		const day = todayLocal();
		const clearing = right ? prev === 'done' || prev === 'completed' : prev === 'skipped';
		const name = (tiles.find(t => t.id === id) || {}).name || '';
		if (clearing) { if (window.clearTileDay) await window.clearTileDay(id, day); }
		else await quickLog(id, right ? 'done' : 'skipped');
		window.track?.('tile_swiped', { action: clearing ? 'clear' : right ? 'done' : 'skip' });
		toast(`${clearing ? _t('Cleared') : right ? _t('Done') : _t('Skipped')} · ${name}`, async () => {
			if (prev === 'done' || prev === 'skipped') await quickLog(id, prev);
			else if (window.clearTileDay) await window.clearTileDay(id, day);
		});
	}

	document.addEventListener('touchstart', e => {
		if (e.touches.length !== 1 || selecting()) { s = null; return; }
		const tile = e.target.closest('#gallery .tile[data-tile-id]');
		if (!tile || isControl(e.target)) { s = null; return; }
		const t = e.touches[0];
		s = { tile, id: tile.dataset.tileId, x0: t.clientX, y0: t.clientY, dx: 0, decided: false, swiping: false, w: tile.offsetWidth, armed: false };
	}, { passive: true });

	document.addEventListener('touchmove', e => {
		if (!s) return;
		if (selecting()) { if (s.swiping) reset(false); s = null; return; }
		const t = e.touches[0];
		const dx = t.clientX - s.x0, dy = t.clientY - s.y0;
		if (!s.decided) {
			if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
			s.decided = true;
			s.swiping = Math.abs(dx) > Math.abs(dy) * 1.5;
			if (!s.swiping) { s = null; return; }
			s.under = makeUnderlay(s.tile);
		}
		if (e.cancelable) e.preventDefault();
		s.dx = Math.max(-s.w * 0.6, Math.min(s.w * 0.6, dx));
		paint(s.dx);
	}, { passive: false });

	function end() {
		if (!s) return;
		const cur = s;
		if (!cur.swiping) { s = null; return; }
		const fire = Math.abs(cur.dx) >= cur.w * THRESHOLD;
		reset(true);
		s = null;
		if (fire) commit(cur.id, cur.dx > 0);
	}
	document.addEventListener('touchend', end);
	document.addEventListener('touchcancel', () => { if (s && s.swiping) reset(true); s = null; });

	// One-time hint on touch devices.
	function hint() {
		try { if (localStorage.getItem('lw_swipe_hint')) return; } catch (e) { return; }
		if (!('ontouchstart' in window) && !navigator.maxTouchPoints) return;
		const first = document.querySelector('#gallery .tile[data-tile-id]');
		if (!first) return;
		try { localStorage.setItem('lw_swipe_hint', '1'); } catch (e) {}
		const h = document.createElement('div');
		h.className = 'absolute left-1/2 -translate-x-1/2 -top-3 z-20 whitespace-nowrap rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-[11px] font-semibold px-3 py-1 shadow-sm pointer-events-none transition-opacity duration-500';
		h.textContent = _t('← Skip · Done →');
		first.appendChild(h);
		setTimeout(() => { h.style.opacity = '0'; setTimeout(() => h.remove(), 600); }, 4500);
	}
	const g = document.getElementById('gallery');
	if (g) {
		const obs = new MutationObserver(() => { if (g.querySelector('.tile[data-tile-id]')) { obs.disconnect(); setTimeout(hint, 800); } });
		obs.observe(g, { childList: true, subtree: true });
	}
})();
