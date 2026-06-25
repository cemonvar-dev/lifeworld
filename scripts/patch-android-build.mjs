// Bump the CI-generated Android project to compileSdk/targetSdk 36 and AGP 8.9.1.
// Required because @capgo/capacitor-social-login pulls androidx libraries that
// demand compileSdk >= 36 and Android Gradle Plugin >= 8.9.1.
// Run after `npx cap add android`.
import { readFileSync, writeFileSync } from 'fs';

function patch(file, replacers) {
  let s = readFileSync(file, 'utf8');
  for (const [re, rep] of replacers) {
    if (!re.test(s)) console.warn(`WARN: pattern ${re} not found in ${file}`);
    s = s.replace(re, rep);
  }
  writeFileSync(file, s);
}

patch('android/variables.gradle', [
  [/compileSdkVersion = \d+/, 'compileSdkVersion = 36'],
  [/targetSdkVersion = \d+/, 'targetSdkVersion = 36'],
]);

patch('android/build.gradle', [
  [/com\.android\.tools\.build:gradle:[\d.]+/, 'com.android.tools.build:gradle:8.9.1'],
]);

console.log('Patched Android build: compileSdk/targetSdk=36, AGP=8.9.1');
