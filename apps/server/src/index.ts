/**
 * Server entrypoint.
 */
import { buildApp } from './bootstrap.js';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

buildApp()
  .then(({ app, mode, demo }) => {
    app.listen(PORT, () => {
      const base = `http://localhost:${PORT}`;
      // eslint-disable-next-line no-console
      console.log(`Scriptorium listening on :${PORT} (store: ${mode})`);
      // eslint-disable-next-line no-console
      console.log(`  Instructor sign-in: ${base}/login.html`);
      // eslint-disable-next-line no-console
      console.log(`    demo login: ${demo.instructorEmail} / ${demo.instructorPassword}`);
      if (demo.studentLink) {
        // eslint-disable-next-line no-console
        console.log(`  Demo student link:  ${base}${demo.studentLink}`);
      }
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
