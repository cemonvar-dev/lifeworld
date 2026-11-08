// PostHog analytics — posthog-js loader + init.
//
// This is a static multi-page site (no bundler), so this file is included on
// every page and PostHog captures a $pageview on each page load automatically.
//
// Fill in your PostHog project values below. The project API key is a PUBLIC
// client key (safe to embed in client code, exactly like the Supabase anon key
// already in the HTML). If the key is left as the placeholder, PostHog is a
// no-op — the app keeps working normally.
(function () {
	var POSTHOG_KEY = 'phc_oSqvAGCRyJs6cnsrpHamBeBZc82jdPGpZpYChMURgeoq';
	var POSTHOG_HOST = 'https://us.i.posthog.com'; // EU cloud: https://eu.i.posthog.com

	// Not configured yet → do nothing (never break the app for a missing key).
	if (!POSTHOG_KEY || POSTHOG_KEY.indexOf('REPLACE') !== -1) return;

	// Official posthog-js snippet (loads array.js from the PostHog assets host).
	!function (t, e) { var o, n, p, r; e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) { function g(t, e) { var o = e.split("."); 2 == o.length && (t = t[o[0]], e = o[1]), t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } } (p = t.createElement("script")).type = "text/javascript", p.crossOrigin = "anonymous", p.async = !0, p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js", (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r); var u = e; for (void 0 !== a ? u = e[a] = [] : a = "posthog", u.people = u.people || [], u.toString = function (t) { var e = "posthog"; return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e }, u.people.toString = function () { return u.toString(1) + ".people (stub)" }, o = "init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "), n = 0; n < o.length; n++) g(u, o[n]); e._i.push([i, s, a]) }, e.__SV = 1) }(document, window.posthog || []);

	// Strip Supabase OAuth tokens (and similar secrets) out of any URL before it
	// leaves the browser — the sign-in redirect lands on
	// app.html#access_token=…&refresh_token=… and we must not send those
	// to PostHog.
	function scrubUrl(url) {
		if (typeof url !== 'string') return url;
		return url.replace(
			/([#&?])(access_token|refresh_token|provider_token|provider_refresh_token|id_token|token_type|expires_in|expires_at|code)=[^&]*/gi,
			'$1$2=REDACTED'
		);
	}

	window.posthog.init(POSTHOG_KEY, {
		api_host: POSTHOG_HOST,
		person_profiles: 'identified_only', // only create person profiles for identified (logged-in) users
		capture_pageview: true,             // automatic pageview on each page load
		capture_pageleave: true,
		disable_session_recording: true,    // no screen/session replay — pageviews + events only

		// Runs on every event: redact auth tokens from URL-bearing properties.
		sanitize_properties: function (properties) {
			['$current_url', '$referrer', '$pathname', '$initial_current_url'].forEach(function (k) {
				if (properties[k]) properties[k] = scrubUrl(properties[k]);
			});
			return properties;
		}
	});
})();

// Report uncaught browser errors to PostHog as `client_error` events, with
// secrets and email addresses removed. Capped so a loop can't flood the project.
(function () {
	var MAX_REPORTS_PER_PAGE = 10;
	var reported = {};
	var reportCount = 0;

	function clean(text) {
		return String(text || '')
			.replace(/\b(access_token|refresh_token|provider_token|id_token|code)=[^&\s"']*/gi, '$1=REDACTED')
			.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, 'REDACTED')
			.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'REDACTED');
	}

	function report(message, source, line, column, stack) {
		if (!window.posthog || typeof window.posthog.capture !== 'function') return;
		var text = clean(message);
		// Cross-origin script noise and a harmless browser layout warning.
		if (!text || /^Script error\.?$/.test(text) || /ResizeObserver loop/.test(text)) return;
		var fingerprint = text + '|' + source + '|' + line;
		if (reported[fingerprint] || reportCount >= MAX_REPORTS_PER_PAGE) return;
		reported[fingerprint] = true;
		reportCount++;
		window.posthog.capture('client_error', {
			error_message: text.slice(0, 300),
			error_source: clean(String(source || '').split(/[?#]/)[0]),
			error_line: line || null,
			error_column: column || null,
			error_stack: clean(stack).slice(0, 1500),
			app_language: window.i18n ? window.i18n.lang : 'en'
		});
	}

	window.addEventListener('error', function (event) {
		if (event.target && event.target !== window) return; // failed image or script load
		report(event.message, event.filename, event.lineno, event.colno, event.error && event.error.stack);
	});
	window.addEventListener('unhandledrejection', function (event) {
		var reason = event.reason || {};
		report(reason.message || reason, '', null, null, reason.stack);
	});
})();

// Identify the signed-in Supabase user (call after a session is known).
// Safe to call repeatedly; no-op if PostHog isn't configured.
window.posthogIdentify = function (user) {
	if (!user || !window.posthog || typeof window.posthog.identify !== 'function') return;
	window.posthog.identify(user.id, { email: user.email });
};

// Clear identity on sign-out. No-op if PostHog isn't configured.
window.posthogReset = function () {
	if (window.posthog && typeof window.posthog.reset === 'function') window.posthog.reset();
};
