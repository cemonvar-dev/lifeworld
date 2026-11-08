import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lifeworld.app',
  appName: 'Fiblia',
  webDir: 'www',   // minimal shell; the app loads server.url at runtime
  server: {
    url: 'https://fiblia.com',
    cleartext: true
  }
};

export default config;