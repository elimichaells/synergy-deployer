import { getSetting } from '@/lib/settings'

export const config = {
  apps: [
    {
      id: 'trueid',
      name: 'trueid.info',
      displayName: 'TrueID Main',
      pm2Name: 'trueid.info',
      path: 'C:\\web\\production\\trueid.info',
      port: 9000,
      url: 'https://trueid.info',
      color: '#667eea',
      icon: '🏠',
      hasGit: true
    },
    {
      id: 'app',
      name: 'app.trueid.info',
      displayName: 'TrueID App',
      pm2Name: 'app.trueid.info',
      path: 'C:\\web\\production\\app.trueid.info',
      port: 9001,
      url: 'https://app.trueid.info',
      color: '#f59e0b',
      icon: '📱',
      hasGit: true
    },
    {
      id: 'owner',
      name: 'owner.trueid.info',
      displayName: 'TrueID Owner',
      pm2Name: 'owner.trueid.info',
      path: 'C:\\web\\production\\owner.trueid.info',
      port: 9002,
      url: 'https://owner.trueid.info',
      color: '#10b981',
      icon: '👤',
      hasGit: true
    },
    {
      id: 'caddy',
      name: 'caddy',
      displayName: 'Caddy Server',
      pm2Name: 'caddy',
      path: 'C:\\web',
      port: 443,
      url: null,
      color: '#3b82f6',
      icon: '🌐',
      hasGit: false
    }
  ],

  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    name: process.env.DATABASE_NAME || 'trueid',
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || ''
  },
}

export async function getPaths() {
  return {
    production: await getSetting('PRODUCTION_PATH'),
    logs: await getSetting('LOGS_PATH'),
    caddy: await getSetting('CADDY_PATH'),
  }
}
