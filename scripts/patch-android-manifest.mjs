// Patch the generated AndroidManifest for:
//  1. the OAuth deep-link intent filter (com.lifeworld.app://login-callback), and
//  2. speech recognition (RECORD_AUDIO permission + speech-service <queries>).
// Run in CI after `npx cap add android` (the native project is regenerated each build).
import { readFileSync, writeFileSync } from 'fs';

const path = 'android/app/src/main/AndroidManifest.xml';
let xml = readFileSync(path, 'utf8');

// --- 1. Deep-link intent filter -------------------------------------------
if (xml.includes('android:scheme="com.lifeworld.app"')) {
  console.log('Deep-link intent filter already present — skipping.');
} else {
  const intentFilter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="com.lifeworld.app" />
            </intent-filter>
        `;
  const mainIdx = xml.indexOf('.MainActivity');
  if (mainIdx === -1) { console.error('Could not find MainActivity in AndroidManifest.xml'); process.exit(1); }
  const closeIdx = xml.indexOf('</activity>', mainIdx);
  if (closeIdx === -1) { console.error('Could not find closing </activity> tag'); process.exit(1); }
  xml = xml.slice(0, closeIdx) + intentFilter + xml.slice(closeIdx);
  console.log('Injected deep-link intent filter for scheme com.lifeworld.app');
}

// --- 2. Speech recognition -------------------------------------------------
// RECORD_AUDIO permission + package-visibility query (Android 11+) so the
// speech-recognition plugin can reach the on-device recognition service.
const manifestTagEnd = xml.indexOf('>', xml.indexOf('<manifest')) + 1;

if (!xml.includes('android.permission.RECORD_AUDIO')) {
  const perm = `\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />`;
  xml = xml.slice(0, manifestTagEnd) + perm + xml.slice(manifestTagEnd);
  console.log('Injected RECORD_AUDIO permission');
} else {
  console.log('RECORD_AUDIO already present — skipping.');
}

if (!xml.includes('android.speech.RecognitionService')) {
  const insertAt = xml.indexOf('>', xml.indexOf('<manifest')) + 1; // recompute after edit
  const queries = `\n    <queries>\n        <intent>\n            <action android:name="android.speech.RecognitionService" />\n        </intent>\n    </queries>`;
  xml = xml.slice(0, insertAt) + queries + xml.slice(insertAt);
  console.log('Injected speech RecognitionService <queries>');
} else {
  console.log('Speech <queries> already present — skipping.');
}

writeFileSync(path, xml);
