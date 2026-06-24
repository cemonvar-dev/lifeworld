// Inject a deep-link intent filter into the generated AndroidManifest so the
// OAuth redirect (com.lifeworld.app://login-callback) reopens the app.
// Run in CI after `npx cap add android` (the native project is regenerated each build).
import { readFileSync, writeFileSync } from 'fs';

const path = 'android/app/src/main/AndroidManifest.xml';
let xml = readFileSync(path, 'utf8');

if (xml.includes('android:scheme="com.lifeworld.app"')) {
  console.log('Deep-link intent filter already present — nothing to do.');
  process.exit(0);
}

const intentFilter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="com.lifeworld.app" />
            </intent-filter>
        `;

const mainIdx = xml.indexOf('.MainActivity');
if (mainIdx === -1) {
  console.error('Could not find MainActivity in AndroidManifest.xml');
  process.exit(1);
}
const closeIdx = xml.indexOf('</activity>', mainIdx);
if (closeIdx === -1) {
  console.error('Could not find closing </activity> tag');
  process.exit(1);
}

xml = xml.slice(0, closeIdx) + intentFilter + xml.slice(closeIdx);
writeFileSync(path, xml);
console.log('Injected deep-link intent filter for scheme com.lifeworld.app');
