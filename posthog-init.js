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
		// Runs on every event: redact auth tokens from URL-bearing properties.
		sanitize_properties: function (properties) {
			['$current_url', '$referrer', '$pathname', '$initial_current_url'].forEach(function (k) {
				if (properties[k]) properties[k] = scrubUrl(properties[k]);
			});
			return properties;
		}
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
