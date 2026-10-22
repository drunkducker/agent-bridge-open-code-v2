// Usage: node scripts/research/compare-agy-proxy-live.mjs <fresh-dist> <results.json>
import { runStudy, PersistentStdio } from './other-harnesses-common.mjs';
await runStudy({ harness: 'agy', model: 'gemini-3.8-flash-low',
  direct: { implemented: false, measured: false, reason: 'Private v1internal endpoints and OAuth replay are not an authorized third-party API under the documented consumer terms. No token extracted.',
    sources: ['https://antigravity.google/terms', 'https://www.antigravity.google/docs/faq/'] },
  limitations: ['Official documentation also says wrapping headless agy in third-party applications is unsupported under consumer plans. These local measurements do not establish permission for deployment.',
    'Persistent stream-json stdin is documented, retains conversation, and does not expose progressive native client-tool arguments.'],
  persistent: async ({ dist, scratch }) => new PersistentStdio('agy', 'gemini-3.8-flash-low', dist, scratch) });
