// ISR Test Page - regenerates every 10 seconds
// After first request, page is cached in R2
// Subsequent requests serve cached version while revalidating in background

export const revalidate = 10; // seconds

export default async function ISRTestPage() {
  const timestamp = new Date().toISOString();

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>ISR Test</h1>
      <p>Generated at: <strong>{timestamp}</strong></p>
      <p style={{ color: '#888', marginTop: '1rem' }}>
        Refresh the page - timestamp updates every ~10 seconds (cached in R2)
      </p>
      <p style={{ marginTop: '2rem' }}>
        <a href="/" style={{ color: '#0070f3' }}>← Back home</a>
      </p>
    </main>
  );
}
