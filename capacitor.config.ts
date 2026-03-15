import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lifeworld.app',
  appName: 'LifeWorld',
  webDir: '.',   // important
  server: {
    url: 'https://lifeworld.vercel.app',
    cleartext: true
  }
};

export default config;