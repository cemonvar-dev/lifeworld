import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lifeworld.app',
  appName: 'LifeWorld',
  webDir: 'www',   // minimal shell; the app loads server.url at runtime
  server: {
    url: 'https://lifeworld.vercel.app',
    cleartext: true
  }
};

export default config;