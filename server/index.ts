import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRoutes } from './routes.js';
import { agentRoutes } from './agent-routes.js';
import { setupWebSocket } from './ws.js';
import { createBridgeMountRouter } from './bridge.js';
import { getCollabRuntime, startCollabRuntimeEmbedded } from './collab.js';
import { discoveryRoutes } from './discovery-routes.js';
import { shareWebRoutes } from './share-web-routes.js';
import {
  capabilitiesPayload,
  enforceApiClientCompatibility,
  enforceBridgeClientCompatibility,
} from './client-capabilities.js';
import { getBuildInfo } from './build-info.js';
import { getDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || '4000', 10);
const DEFAULT_ALLOWED_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'null',
];

function parseAllowedCorsOrigins(): Set<string> {
  const configured = (process.env.PROOF_CORS_ALLOW_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_CORS_ORIGINS);
}

async function main(): Promise<void> {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const allowedCorsOrigins = parseAllowedCorsOrigins();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Serve built frontend assets but not index.html (we handle / with our own landing page)
  app.use('/assets', express.static(path.join(__dirname, '..', 'dist', 'assets')));

  app.use((req, res, next) => {
    const originHeader = req.header('origin');
    if (originHeader && allowedCorsOrigins.has(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      [
        'Content-Type',
        'Authorization',
        'X-Proof-Client-Version',
        'X-Proof-Client-Build',
        'X-Proof-Client-Protocol',
        'x-share-token',
        'x-bridge-token',
        'x-auth-poll-token',
        'X-Agent-Id',
        'X-Window-Id',
        'X-Document-Id',
        'Idempotency-Key',
        'X-Idempotency-Key',
      ].join(', '),
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/browse/documents', (_req, res) => {
    const rows = getDb().prepare(`
      SELECT slug, title, share_state, created_at, updated_at
      FROM documents
      WHERE share_state != 'DELETED'
      ORDER BY created_at DESC
      LIMIT 100
    `).all() as Array<{ slug: string; title: string | null; share_state: string; created_at: string; updated_at: string }>;

    const docs = rows.map((r) => ({ ...r, url: `/d/${r.slug}` }));
    res.json({ documents: docs });
  });

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proof SDK</title>
    <style>
      * { box-sizing: border-box; margin: 0; }
      body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 48px 24px; color: #17261d; background: #f7faf5; }
      main { max-width: 760px; margin: 0 auto; }
      h1 { font-size: 2.5rem; margin: 0 0 0.25rem; }
      .subtitle { font-size: 1.05rem; color: #4a6355; margin-bottom: 32px; }
      .toolbar { display: flex; gap: 12px; margin-bottom: 24px; align-items: center; }
      #new-title { flex: 1; padding: 10px 14px; border: 1px solid #c8d6c0; border-radius: 8px; font-size: 1rem; outline: none; }
      #new-title:focus { border-color: #266854; box-shadow: 0 0 0 2px rgba(38,104,84,0.15); }
      .btn { padding: 10px 20px; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; font-weight: 500; }
      .btn-primary { background: #266854; color: #fff; }
      .btn-primary:hover { background: #1d5443; }
      .doc-list { list-style: none; padding: 0; }
      .doc-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border: 1px solid #e2ead9; border-radius: 10px; margin-bottom: 8px; background: #fff; transition: box-shadow 0.15s; }
      .doc-item:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
      .doc-title { font-weight: 500; color: #17261d; text-decoration: none; font-size: 1.05rem; }
      .doc-title:hover { color: #266854; }
      .doc-meta { font-size: 0.85rem; color: #7a8f7e; }
      .empty { text-align: center; padding: 48px 0; color: #7a8f7e; }
      .loading { text-align: center; padding: 48px 0; color: #7a8f7e; }
      .links { margin-top: 24px; font-size: 0.9rem; color: #7a8f7e; }
      .links a { color: #266854; }
    </style>
  </head>
  <body>
    <main>
      <h1>Proof SDK</h1>
      <p class="subtitle">Collaborative markdown editing with provenance tracking</p>
      <div class="toolbar">
        <input id="new-title" type="text" placeholder="New document title..." />
        <button class="btn btn-primary" onclick="createDoc()">Create</button>
      </div>
      <div id="docs" class="loading">Loading documents...</div>
      <div class="links">
        <a href="/agent-docs">Agent docs</a> &middot; <a href="/.well-known/agent.json">Discovery</a>
      </div>
    </main>
    <script>
      async function loadDocs() {
        const el = document.getElementById('docs');
        try {
          const res = await fetch('/api/browse/documents');
          const data = await res.json();
          if (!data.documents.length) {
            el.innerHTML = '<div class="empty">No documents yet. Create one above.</div>';
            return;
          }
          el.innerHTML = '<ul class="doc-list">' + data.documents.map(d => {
            const date = new Date(d.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return '<li class="doc-item">'
              + '<div><a class="doc-title" href="' + d.url + '">' + (d.title || d.slug) + '</a>'
              + '<div class="doc-meta">' + date + '</div></div>'
              + '<span class="doc-meta">' + d.share_state + '</span>'
              + '</li>';
          }).join('') + '</ul>';
        } catch (e) {
          el.innerHTML = '<div class="empty">Failed to load documents.</div>';
        }
      }
      async function createDoc() {
        const title = document.getElementById('new-title').value.trim() || 'Untitled';
        const res = await fetch('/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: '# ' + title + '\\n\\nStart writing...', title, role: 'editor' })
        });
        const data = await res.json();
        if (data.tokenUrl) window.location.href = data.tokenUrl;
        else if (data.shareUrl) window.location.href = data.shareUrl;
      }
      document.getElementById('new-title').addEventListener('keydown', e => { if (e.key === 'Enter') createDoc(); });
      loadDocs();
    </script>
  </body>
</html>`);
  });

  app.get('/health', (_req, res) => {
    const buildInfo = getBuildInfo();
    res.json({
      ok: true,
      buildInfo,
      collab: getCollabRuntime(),
    });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json(capabilitiesPayload());
  });

  app.use(discoveryRoutes);
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  setupWebSocket(wss);
  await startCollabRuntimeEmbedded(PORT);

  const HOST = process.env.HOST || '0.0.0.0';
  server.listen(PORT, HOST, () => {
    console.log(`[proof-sdk] listening on http://${HOST}:${PORT}`);
  });
}

main().catch((error) => {
  console.error('[proof-sdk] failed to start server', error);
  process.exit(1);
});
