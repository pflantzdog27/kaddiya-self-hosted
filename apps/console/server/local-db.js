// One embedded database per process. A checkout holds the entire transaction
// queue, so tenant role changes cannot interleave with another request.
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import lockfile from 'proper-lockfile';
import pg from 'pg';

export class LocalPool {
  constructor(directory) {
    this.tail = Promise.resolve();
    this.ending = false;
    this.ready = this.open(directory);
    // Startup awaits this promise in connect(); avoid an unhandled rejection
    // between construction and the first checkout.
    this.ready.catch(() => {});
  }

  async open(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      this.unlock = await lockfile.lock(directory, { stale: 120_000, retries: 0 });
    } catch (err) {
      if (err.code === 'ELOCKED') throw new Error('This local workspace is already open. Stop the other Kaddiya window first. After a forced shutdown, wait two minutes and retry.');
      throw err;
    }
    try {
      this.engine = new PGlite(directory, {
        // Match node-postgres for ciphertext, bigint IDs and numeric costs.
        parsers: Object.fromEntries([17, 20, 1700].map(id => [id, pg.types.getTypeParser(id)])),
      });
      await this.engine.waitReady;
    } catch (err) {
      await this.unlock();
      this.unlock = null;
      throw err;
    }
  }

  async connect() {
    if (this.ending) throw new Error('The local database is closing.');
    let releaseQueue;
    const previous = this.tail;
    this.tail = new Promise(resolve => { releaseQueue = resolve; });
    await previous;
    try { await this.ready; } catch (err) { releaseQueue(); throw err; }
    let released = false;
    return {
      query: async (sql, params) => {
        if (released) throw new Error('Database checkout was already released.');
        // Migrations contain multiple statements; prepared queries do not.
        if (params?.length) return this.engine.query(sql, params);
        const results = await this.engine.exec(sql);
        return results.at(-1) || { rows: [], rowCount: 0 };
      },
      release: () => {
        if (released) return;
        released = true;
        releaseQueue();
      },
    };
  }

  async end() {
    this.ending = true;
    await this.tail;
    try {
      await this.ready;
      await this.engine.close();
    } finally {
      if (this.unlock) { await this.unlock(); this.unlock = null; }
    }
  }
}
