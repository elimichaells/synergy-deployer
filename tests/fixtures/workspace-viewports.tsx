export default async function Viewports({ searchParams }: { searchParams: Promise<{ view?: string; section?: string }> }) {
  const { view, section } = await searchParams
  const target = view === 'data' ? '/data-services' : view === 'settings' ? '/settings?section=' + encodeURIComponent(section || 'general') : view === 'cloudflare' ? '/domains' : view === 'new' ? '/sites/new' : view === 'related' ? '/sites/fixture-app?tab=overview' : '/sites/fixture-app?tab=setup'
  return <main style={{ padding: 20, background: '#222', minHeight: '100vh' }}>
    <h1 style={{ fontSize: 16, marginBottom: 16 }}>Mobile setup / 390 x 844</h1>
    <iframe title="Mobile application setup" src={target} style={{ display: 'block', width: 390, height: 844, border: '1px solid #555' }} />
    <h2 style={{ fontSize: 16, margin: '24px 0 16px' }}>Compact mobile / 320 x 740</h2>
    <iframe title="Compact mobile application list" src={view ? target : '/sites'} style={{ display: 'block', width: 320, height: 740, border: '1px solid #555' }} />
    <h2 style={{ fontSize: 16, margin: '24px 0 16px' }}>Desktop application list / 1440 x 900</h2>
    <iframe title="Desktop applications" src={view ? target : '/sites'} style={{ display: 'block', width: 1440, height: 900, border: '1px solid #555' }} />
  </main>
}
