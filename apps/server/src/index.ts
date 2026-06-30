/**
 * Server entrypoint.
 */
import { buildApp, DEMO } from './bootstrap.js';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

buildApp()
  .then(({ app, mode }) => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Scriptorium listening on :${PORT} (store: ${mode})`);
      // eslint-disable-next-line no-console
      console.log(`  Editor:  http://localhost:${PORT}/?session=${DEMO.sessionId}`);
      // eslint-disable-next-line no-console
      console.log(`  Replay:  http://localhost:${PORT}/replay.html?session=${DEMO.sessionId}`);
      if (mode === 'memory') {
        // eslint-disable-next-line no-console
        console.log('  NOTE: in-memory store — data is lost on restart. Set DATABASE_URL to persist.');
      }
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start Scriptorium:', err);
    process.exit(1);
  });
