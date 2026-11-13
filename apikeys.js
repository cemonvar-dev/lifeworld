// Settings → Account → API keys: create, list and revoke personal keys for /api/v1.
// Uses app.js globals: supa, API_BASE, escapeHtml, _t, copyText.
(function () {
	let loaded = false, justCreated = null;

	async function call(method, path, body) {
		const { data: { session } } = await supa.auth.getSession();
		if (!session) throw new Error(_t('Please sign in.'));
		const r = await fetch(`${API_BASE}/api/v1/keys${path || ''}`, {
			method,
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
			...(body ? { body: JSON.stringify(body) } : {})
		});
		const out = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error((out.error && out.error.message) || _t("Couldn't save. Please try again."));
		return out.data;
	}

	const fmt = iso => iso ? new Date(iso).toLocaleDateString((window.i18n && i18n.lang) || undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

	function render(mount, keys, error) {
		const rows = (keys || []).map(k => `
			<div class="flex items-center gap-2 py-2 border-b border-slate-100 last:border-0">
				<div class="min-w-0 flex-1">
					<div class="text-sm font-medium text-slate-700 truncate" translate="no">${escapeHtml(k.name)}</div>
					<div class="text-[11px] text-slate-400 truncate"><code translate="no">${escapeHtml(k.prefix)}…</code> · ${escapeHtml(k.scopes.includes('write') ? _t('Read & write') : _t('Read only'))} · ${escapeHtml(k.last_used_at ? _t('Last used {date}', { date: fmt(k.last_used_at) }) : _t('Never used'))}</div>
				</div>
				<button type="button" data-revoke="${escapeHtml(k.id)}" class="shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold text-red-600 hover:bg-red-50">${escapeHtml(_t('Revoke'))}</button>
			</div>`).join('');
		mount.innerHTML = `
			<div class="flex items-center justify-between mb-1">
				<div class="text-xs font-semibold text-slate-500">${escapeHtml(_t('API keys'))}</div>
				<a href="developers.html" target="_blank" rel="noopener" class="text-xs font-semibold text-blue-600 hover:underline">${escapeHtml(_t('API docs'))} ↗</a>
			</div>
			<p class="text-[11px] text-slate-500 mb-2">${escapeHtml(_t('Connect Fiblia to other tools (scripts, Zapier, Shortcuts). Treat a key like a password.'))}</p>
			${justCreated ? `<div class="mb-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
				<div class="text-xs font-semibold text-amber-800 mb-1">${escapeHtml(_t("Copy your new key now. You won't see it again."))}</div>
				<div class="flex items-center gap-2"><code translate="no" class="flex-1 min-w-0 truncate rounded-lg bg-white border border-amber-200 px-2 py-1 text-[11px]">${escapeHtml(justCreated)}</code>
				<button type="button" data-copy class="shrink-0 px-2.5 py-1 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700">${escapeHtml(_t('Copy'))}</button></div>
			</div>` : ''}
			${error ? `<div class="mb-2 text-xs text-red-600">${escapeHtml(error)}</div>` : ''}
			<div class="rounded-xl border border-slate-200 px-3">${rows || `<div class="py-3 text-xs text-slate-400">${escapeHtml(_t('No API keys yet.'))}</div>`}</div>
			<form data-create class="mt-2 flex flex-wrap items-center gap-2">
				<input name="name" maxlength="60" placeholder="${escapeHtml(_t('Key name, e.g. Zapier'))}" class="flex-1 min-w-[140px] px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" />
				<label class="inline-flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" name="readonly" class="rounded" /> ${escapeHtml(_t('Read only'))}</label>
				<button type="submit" class="px-3 py-2 rounded-xl bg-blue-50 text-blue-700 border border-blue-200 text-sm font-semibold hover:bg-blue-100">${escapeHtml(_t('Create key'))}</button>
			</form>`;
		mount.querySelector('[data-copy]')?.addEventListener('click', async e => {
			const ok = await copyText(justCreated);
			e.currentTarget.textContent = ok ? `✅ ${_t('Copied')}` : _t("Couldn't copy");
		});
		mount.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
			if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = _t('Revoke?'); b.classList.add('bg-red-50'); return; }
			try { await call('DELETE', '/' + b.dataset.revoke); window.track?.('api_key_revoked'); load(mount); }
			catch (err) { render(mount, keys, err.message); }
		}));
		mount.querySelector('[data-create]').addEventListener('submit', async e => {
			e.preventDefault();
			const f = e.currentTarget;
			const btn = f.querySelector('button[type=submit]');
			btn.disabled = true;
			try {
				const readOnly = f.elements.readonly.checked;
				const created = await call('POST', '', { name: f.elements.name.value, read_only: readOnly });
				justCreated = created.key;
				window.track?.('api_key_created', { read_only: readOnly });
				load(mount);
			} catch (err) { btn.disabled = false; render(mount, keys, err.message); }
		});
	}

	async function load(mount) {
		try { render(mount, await call('GET')); }
		catch (err) { render(mount, [], err.message); }
	}

	function init() {
		const panel = document.getElementById('stabAccount');
		const mount = document.getElementById('apiKeysMount');
		if (!panel || !mount) return;
		const onShow = () => { if (!panel.classList.contains('hidden')) { load(mount); loaded = true; } else if (loaded) { justCreated = null; } };
		new MutationObserver(onShow).observe(panel, { attributes: true, attributeFilter: ['class'] });
		const overlay = document.getElementById('settingsOverlay');
		if (overlay) new MutationObserver(() => { if (overlay.classList.contains('hidden')) justCreated = null; else onShow(); }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
