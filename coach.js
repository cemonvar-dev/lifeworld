// Coach bubble (redesign phase 4, from alternative2.html).
// On wider screens a floating "Ask your coach" button sits bottom-right and the
// existing AI chat opens as a panel docked above it, without dimming the page,
// so you can keep ticking tiles while you talk. Once a day the bubble may offer
// a gentle nudge about a struggling tile that's due today. Phones keep the chat
// as a bottom sheet, opened from the AI button in the bottom bar.
// Uses app.js globals: openAiChat, closeAiChat, tiles, rawTiles, isTileScheduledToday,
// todayLocal, escapeHtml, _t.
(function () {
	const NUDGE_KEY = 'lw_coach_nudge';
	const css = `
	#coachFab{position:fixed;right:22px;bottom:22px;z-index:45;height:56px;padding:0 20px 0 7px;border-radius:999px;background:#fff;border:1px solid #dcd5ff;box-shadow:0 18px 44px rgba(76,62,140,.18);display:flex;align-items:center;gap:10px;font-weight:700;font-size:14px;color:#6b5fd6;transition:transform .18s,box-shadow .18s}
	#coachFab:hover{transform:translateY(-2px);box-shadow:0 22px 50px rgba(76,62,140,.22)}
	#coachFab .face{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#efe9ff,#e3f3ff);display:grid;place-items:center;font-size:19px;transition:transform .25s}
	#coachFab.open .face{transform:rotate(90deg)}
	#coachFab .dot{width:8px;height:8px;border-radius:50%;background:#f59aa0;display:none}
	#coachFab.has-nudge .dot{display:block}
	#coachNudge{position:fixed;right:22px;bottom:90px;z-index:45;width:min(300px,calc(100vw - 44px));background:#fff;border:1px solid #e6e0f8;border-radius:18px 18px 6px 18px;box-shadow:0 18px 44px rgba(76,62,140,.16);padding:12px 36px 12px 14px;font-size:13.5px;line-height:1.45;color:#3f3a5e;cursor:pointer;animation:coachIn .35s cubic-bezier(.2,.8,.2,1)}
	#coachNudge b{font-weight:700}
	#coachNudge .x{position:absolute;top:6px;right:6px;width:26px;height:26px;border-radius:50%;color:#a19db6;font-size:15px;line-height:1}
	#coachNudge .x:hover{background:#f5f2ff;color:#6a6683}
	@keyframes coachIn{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}
	@media (max-width:639px){#coachFab,#coachNudge{display:none!important}}
	@media (min-width:640px){
		#aiChatOverlay.lw-docked{background:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;pointer-events:none;align-items:flex-end!important;justify-content:flex-end!important;padding:0 22px 92px 0}
		#aiChatOverlay.lw-docked > div{pointer-events:auto;width:400px;max-height:min(640px,calc(100vh - 120px));transform-origin:bottom right;box-shadow:0 24px 60px rgba(76,62,140,.22)}
		#aiChatOverlay.lw-docked:not(.hidden){animation:none!important}
		#aiChatOverlay.lw-docked:not(.hidden) > div{animation:coachPanel .26s cubic-bezier(.2,.8,.2,1)!important}
	}
	@keyframes coachPanel{from{opacity:0;transform:translateY(10px) scale(.92)}to{opacity:1;transform:none}}
	@media (prefers-reduced-motion:reduce){#coachFab,#coachNudge,#aiChatOverlay.lw-docked > div{animation:none!important;transition:none!important}}`;

	const overlay = () => document.getElementById('aiChatOverlay');
	const isOpen = () => !overlay().classList.contains('hidden');

	function sync() {
		const fab = document.getElementById('coachFab');
		if (!fab) return;
		const open = isOpen();
		fab.classList.toggle('open', open);
		fab.setAttribute('aria-expanded', String(open));
		fab.querySelector('.face').textContent = open ? '✕' : '✨';
		fab.querySelector('.lbl').textContent = open ? _t('Close') : _t('Ask your coach');
		if (open) hideNudge();
	}

	function toggle() {
		if (isOpen()) closeAiChat(); else { openAiChat(); window.track?.('coach_bubble_opened'); }
	}

	// One gentle nudge a day: the weakest tile that's due today and still open.
	function pickNudgeTile() {
		return (tiles || [])
			.filter(t => t.status === 'noaction' && !['completed', 'cancelled', 'failed'].includes(t.taskStatus) && t.health < 40 && isTileScheduledToday(t.id))
			.sort((a, b) => a.health - b.health)[0];
	}
	function hideNudge() {
		document.getElementById('coachNudge')?.remove();
		document.getElementById('coachFab')?.classList.remove('has-nudge');
	}
	function maybeNudge() {
		if (window.innerWidth < 640 || isOpen() || document.getElementById('coachNudge')) return;
		try { if (localStorage.getItem(NUDGE_KEY) === todayLocal()) return; } catch (e) { return; }
		const t = pickNudgeTile();
		if (!t) return;
		try { localStorage.setItem(NUDGE_KEY, todayLocal()); } catch (e) {}
		const n = document.createElement('div');
		n.id = 'coachNudge';
		n.setAttribute('role', 'status');
		const msg = escapeHtml(_t('{name} could use some care. Want a hand?', { name: '\u0000' })).replace('\u0000', `<b translate="no">${escapeHtml(t.name)}</b>`);
		n.innerHTML = `🌱 ${msg}<button type="button" class="x" aria-label="${escapeHtml(_t('Dismiss'))}">✕</button>`;
		n.addEventListener('click', e => {
			hideNudge();
			if (e.target.closest('.x')) { window.track?.('coach_nudge_dismissed'); return; }
			openAiChat();
			const input = document.getElementById('aiChatInput');
			if (input) { input.value = _t('Help me get back on track with {name}', { name: t.name }); input.focus(); }
			window.track?.('coach_nudge_opened');
		});
		document.body.appendChild(n);
		document.getElementById('coachFab')?.classList.add('has-nudge');
		setTimeout(() => { if (document.getElementById('coachNudge') === n) { n.remove(); } }, 15000);
	}

	function mount() {
		const ov = overlay();
		if (!ov || document.getElementById('coachFab')) return;
		const style = document.createElement('style');
		style.textContent = css;
		document.head.appendChild(style);
		ov.classList.add('lw-docked');
		const fab = document.createElement('button');
		fab.type = 'button';
		fab.id = 'coachFab';
		fab.setAttribute('aria-controls', 'aiChatOverlay');
		fab.innerHTML = `<span class="face" aria-hidden="true">✨</span><span class="lbl"></span><span class="dot" aria-hidden="true"></span>`;
		fab.addEventListener('click', toggle);
		document.body.appendChild(fab);
		// Follow every open/close, whichever button or key did it.
		new MutationObserver(sync).observe(ov, { attributes: true, attributeFilter: ['class'] });
		document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen() && window.innerWidth >= 640) closeAiChat(); });
		window.addEventListener('i18n-change', sync);
		sync();
		// Nudge once tiles have loaded and the page has settled.
		let tries = 0;
		const wait = setInterval(() => {
			if ((tiles && tiles.length) || ++tries > 20) { clearInterval(wait); setTimeout(maybeNudge, 3500); }
		}, 500);
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
