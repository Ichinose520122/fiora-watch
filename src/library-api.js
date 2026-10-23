export function registerLibraryRoutes(app, { library, requireAdmin }) {
  app.get('/api/library', (_req, res) => res.json({ items: library.list() }));
  app.post('/api/library/remove', requireAdmin, (req, res) => res.json(library.removeBatch(req.body?.ids)));
}
