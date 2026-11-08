'use client'
import { AppShell } from '@/components/layout/app-shell'
import { useServerHealth } from '@/components/server-health'
import { HealthWorkspace } from '@/components/infrastructure/health-workspace'
export default function ServerHealthPage(){const {health,error}=useServerHealth();return <AppShell title="Health & alerts" subtitle="Application readiness, server resources, memory, backups and security exceptions in one place." area="infrastructure"><HealthWorkspace health={health} error={error}/></AppShell>}
