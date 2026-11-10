// Drag tiles between gallery sections (tags, Pinned, Untagged) or reorder
// within one. Mouse: drag after a few pixels. Touch: hold ~0.45s, then drag
// (a quick swipe still scrolls). Uses app.js globals: rawTiles, tiles,
// PINNED_GROUP, tagPath, applyFilters, handleTileDrop, supa, _t.
(function () {
	const HOLD_MS = 450;
	const MOVE_SLOP = 8;
	let pending = null; // { tileEl, x, y, timer, touch }
	let drag = null;    // { tileEl, id, fromGroup, ghost, offX, offY, target }
	let swallowClick = false;
	let undoTimer = null;

	const groupName = g => g === PINNED_GROUP ? _t('Pinned') : g === 'Untagged' ? _t('Untagged') : tagPath(g);

	function startDrag(tileEl, x, y, touch) {
		const grid = tileEl.closest('[data-tag-group]');
		if (!grid) return;
		const rect = tileEl.getBoundingClientRect();
		const ghost = tileEl.cloneNode(true);
		ghost.classList.add('tile-drag-ghost');
		Object.assign(ghost.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', margin: '0', zIndex: '9999', pointerEvents: 'none', transform: 'scale(1.04) rotate(-1.5deg)', opacity: '0.92', boxShadow: '0 12px 28px rgba(15,23,42,.25)', transition: 'none' });
		document.body.appendChild(ghost);
		tileEl.classList.add('opacity-30');
		document.body.classList.add('tile-dragging');
		drag = { tileEl, id: tileEl.dataset.tileId, fromGroup: grid.dataset.tagGroup, ghost, offX: x - rect.left, offY: y - rect.top, target: null };
		if (touch && navigator.vibrate) try { navigator.vibrate(15); } catch {}
	}

	function clearHighlight() {
		document.querySelectorAll('.tile-drop-section').forEach(el => el.classList.remove('tile-drop-section'));
		document.querySelectorAll('.tile-drop-before').forEach(el => el.classList.remove('tile-drop-before'));
	}

	function moveDrag(x, y) {
		drag.ghost.style.left = (x - drag.offX) + 'px';
		drag.ghost.style.top = (y - drag.offY) + 'px';
		const el = document.elementFromPoint(x, y);
		const section = el && el.closest('section[data-drop-group]');
		const overTile = el && el.closest('.tile[data-tile-id]');
		clearHighlight();
		drag.target = null;
		if (!section) return;
		const group = section.dataset.dropGroup;
		if (group === drag.fromGroup) {
			if (overTile && overTile !== drag.tileEl) { overTile.classList.add('tile-drop-before'); drag.target = { group, tileId: overTile.dataset.tileId }; }
			return;
		}
		section.classList.add('tile-drop-section');
		drag.target = { group };
	}

	// Scroll the page when dragging near the top/bottom edge.
	let scrollRaf = 0, lastY = 0;
	function autoScroll() {
		if (!drag) { scrollRaf = 0; return; }
		const edge = 70, h = window.innerHeight;
		const dy = lastY < edge ? -(edge - lastY) / 4 : lastY > h - edge ? (lastY - (h - edge)) / 4 : 0;
		if (dy) window.scrollBy(0, dy);
		scrollRaf = requestAnimationFrame(autoScroll);
	}

	function endDrag(cancelled) {
		if (!drag) return;
		const d = drag;
		drag = null;
		d.ghost.remove();
		d.tileEl.classList.remove('opacity-30');
		document.body.classList.remove('tile-dragging');
		clearHighlight();
		swallowClick = true;
		setTimeout(() => { swallowClick = false; }, 350);
		if (cancelled || !d.target) return;
		if (d.target.tileId) handleTileDrop(d.id, d.target.tileId, d.fromGroup);
		else moveTileToGroup(d.id, d.fromGroup, d.target.group);
	}

	function cancelPending() {
		if (pending) clearTimeout(pending.timer);
		pending = null;
	}

	// The new tag list and pin state for a tile moved from one section to another.
	function computeMove(raw, fromGroup, toGroup) {
		const tags = [...(raw.tag_ids || [])];
		let pinned = !!raw.pinned;
		let tagIds = tags;
		if (toGroup === PINNED_GROUP) pinned = true;
		else {
			pinned = false;
			if (toGroup === 'Untagged') tagIds = [];
			else tagIds = [toGroup, ...tags.filter(t => t !== toGroup && t !== fromGroup)];
		}
		return { tag_ids: tagIds, pinned };
	}
	window.computeTileMove = computeMove;

	async function save(id, raw, next) {
		raw.tag_ids = next.tag_ids;
		raw.pinned = next.pinned;
		const shown = tiles.find(t => t.id === id);
		if (shown) shown.tags = [...next.tag_ids];
		applyFilters();
		const { error } = await supa.from('tasks').update({ tag_ids: next.tag_ids, pinned: next.pinned }).eq('id', id);
		return !error;
	}

	async function moveTileToGroup(id, fromGroup, toGroup) {
		const raw = rawTiles[id];
		if (!raw || fromGroup === toGroup) return;
		const before = { tag_ids: [...(raw.tag_ids || [])], pinned: !!raw.pinned };
		const next = computeMove(raw, fromGroup, toGroup);
		window.track?.('tile_moved', { to: toGroup === PINNED_GROUP ? 'pinned' : toGroup === 'Untagged' ? 'untagged' : 'tag' });
		if (!(await save(id, raw, next))) {
			await save(id, raw, before);
			showToast(_t("Couldn't move the task"));
			return;
		}
		showToast(_t('Moved to {name}', { name: groupName(toGroup) }), async () => {
			window.track?.('tile_move_undone');
			await save(id, raw, before);
		});
	}
	window.moveTileToGroup = moveTileToGroup;

	function showToast(text, onUndo) {
		document.getElementById('tileMoveToast')?.remove();
		clearTimeout(undoTimer);
		const t = document.createElement('div');
		t.id = 'tileMoveToast';
		t.className = 'fixed left-1/2 -translate-x-1/2 bottom-6 z-[9999] flex items-center gap-3 max-w-[calc(100vw-2rem)] bg-slate-800 text-white text-sm rounded-xl shadow-lg pl-4 pr-2 py-2';
		const label = document.createElement('span');
		label.className = 'truncate';
		label.textContent = text;
		t.appendChild(label);
		if (onUndo) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'shrink-0 px-3 py-1 rounded-lg font-semibold text-amber-300 hover:bg-white/10';
			b.textContent = _t('Undo');
			b.addEventListener('click', () => { t.remove(); clearTimeout(undoTimer); onUndo(); });
			t.appendChild(b);
		}
		document.body.appendChild(t);
		undoTimer = setTimeout(() => t.remove(), 6000);
	}

	const isControl = el => el.closest('button, a, input, textarea, select');

	// ---- Mouse ----
	document.addEventListener('mousedown', e => {
		if (e.button !== 0) return;
		const tileEl = e.target.closest('#gallery .tile[data-tile-id]');
		if (!tileEl || isControl(e.target)) return;
		pending = { tileEl, x: e.clientX, y: e.clientY, touch: false };
	});
	document.addEventListener('mousemove', e => {
		if (drag) { lastY = e.clientY; moveDrag(e.clientX, e.clientY); e.preventDefault(); return; }
		if (pending && !pending.touch && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > MOVE_SLOP) {
			const p = pending; pending = null;
			startDrag(p.tileEl, p.x, p.y);
			if (drag) { lastY = e.clientY; moveDrag(e.clientX, e.clientY); if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScroll); }
		}
	});
	document.addEventListener('mouseup', () => { cancelPending(); endDrag(false); });

	// ---- Touch (long-press) ----
	document.addEventListener('touchstart', e => {
		if (e.touches.length !== 1) { cancelPending(); return; }
		const tileEl = e.target.closest('#gallery .tile[data-tile-id]');
		if (!tileEl || isControl(e.target)) return;
		const t = e.touches[0];
		pending = { tileEl, x: t.clientX, y: t.clientY, touch: true };
		pending.timer = setTimeout(() => {
			const p = pending; pending = null;
			if (!p) return;
			startDrag(p.tileEl, p.x, p.y, true);
			if (drag) { lastY = p.y; moveDrag(p.x, p.y); if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScroll); }
		}, HOLD_MS);
	}, { passive: true });
	document.addEventListener('touchmove', e => {
		const t = e.touches[0];
		if (drag) { if (e.cancelable) e.preventDefault(); lastY = t.clientY; moveDrag(t.clientX, t.clientY); return; }
		if (pending && Math.hypot(t.clientX - pending.x, t.clientY - pending.y) > MOVE_SLOP) cancelPending();
	}, { passive: false });
	document.addEventListener('touchend', e => { cancelPending(); if (drag) { if (e.cancelable) e.preventDefault(); endDrag(false); } });
	document.addEventListener('touchcancel', () => { cancelPending(); endDrag(true); });

	// No long-press menu / text selection on tiles; no click after a drag.
	document.addEventListener('contextmenu', e => { if (drag || (pending && pending.touch) || e.target.closest('#gallery .tile')) e.preventDefault(); });
	document.addEventListener('click', e => { if (swallowClick) { e.preventDefault(); e.stopPropagation(); swallowClick = false; } }, true);
	document.addEventListener('keydown', e => { if (e.key === 'Escape' && drag) endDrag(true); });

	const style = document.createElement('style');
	style.textContent = `
		#gallery .tile { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
		#gallery .tile img { -webkit-user-drag: none; pointer-events: none; }
		body.tile-dragging, body.tile-dragging * { cursor: grabbing !important; }
		.tile-drop-section { background: rgba(59,130,246,.07); outline: 2px dashed rgba(59,130,246,.55); outline-offset: 6px; border-radius: 14px; }
		.tile-drop-before { box-shadow: -4px 0 0 0 rgb(59,130,246), 0 1px 3px rgba(0,0,0,.1) !important; }
	`;
	document.head.appendChild(style);
})();
