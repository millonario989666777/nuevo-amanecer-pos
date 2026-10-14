import { WorkflowEntrypoint } from 'cloudflare:workers';
import { EXPORT_PATH, apiResult, backupKey, manifest, requireEnv, sha256Hex, stripInternalImageRows } from './backup-core.js';

const RETRY = { retries: { limit: 30, delay: '2 seconds', backoff: 'constant' }, timeout: '5 minutes' };

export class D1BackupWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    requireEnv(this.env);
    const timestamp = event.schedule?.scheduledTime ?? event.timestamp.getTime();
    const sqlKey = backupKey(timestamp, 'sql');
    const manifestKey = backupKey(timestamp, 'manifest.json');
    const url = EXPORT_PATH(this.env.ACCOUNT_ID, this.env.DATABASE_ID);
    const headers = { authorization: `Bearer ${this.env.D1_REST_API_TOKEN}`, 'content-type': 'application/json' };
    let bookmark = null;

    try {
      bookmark = await step.do('start D1 export', RETRY, async () => {
        const result = await apiResult(await fetch(url, { method: 'POST', headers, body: JSON.stringify({ output_format: 'polling' }) }));
        if (!result.at_bookmark) throw new Error('D1 export did not return at_bookmark');
        return result.at_bookmark;
      });

      const recorded = await step.do('download, verify and store D1 export', RETRY, async () => {
        const result = await apiResult(await fetch(url, { method: 'POST', headers, body: JSON.stringify({ output_format: 'polling', current_bookmark: bookmark }) }));
        if (result.status !== 'complete' || !result.result?.signed_url) throw new Error('D1 export is not complete');
        const response = await fetch(result.result.signed_url);
        if (!response.ok) throw new Error(`D1 export download failed (${response.status})`);
        // Bounded buffering prevents isolate exhaustion. A larger database needs
        // a streaming/multipart implementation before this limit is reached.
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 16 * 1024 * 1024) throw new Error('Backup exceeds 16 MiB safety limit');
          chunks.push(chunk);
        }
        if (!size) throw new Error('Empty SQL export');
        const raw = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
        const exported = new TextEncoder().encode(stripInternalImageRows(new TextDecoder().decode(raw)));
        const sha256 = await sha256Hex(exported);
        const metadata = { database_id: this.env.DATABASE_ID, bookmark, sha256 };
        await this.env.BACKUP_BUCKET.put(sqlKey, exported, { customMetadata: metadata, httpMetadata: { contentType: 'application/sql' } });
        const saved = await this.env.BACKUP_BUCKET.get(sqlKey);
        if (!saved || saved.size !== exported.byteLength || saved.customMetadata?.sha256 !== sha256) throw new Error('R2 SQL verification failed');
        if (await sha256Hex(await saved.arrayBuffer()) !== sha256) throw new Error('R2 SQL hash verification failed');
        return { size: exported.byteLength, sha256 };
      });
      return await step.do('store PASS backup manifest', async () => {
        const value = manifest({ timestamp, databaseId: this.env.DATABASE_ID, bookmark, sqlKey, size: recorded.size, sha256: recorded.sha256, status: 'PASS' });
        await this.env.BACKUP_BUCKET.put(manifestKey, JSON.stringify(value, null, 2) + '\n', { httpMetadata: { contentType: 'application/json' } });
        return value;
      });
    } catch (error) {
      await step.do('store failed backup manifest', async () => {
        const value = manifest({ timestamp, databaseId: this.env.DATABASE_ID, bookmark, status: 'FAIL' });
        await this.env.BACKUP_BUCKET.put(manifestKey, JSON.stringify(value, null, 2) + '\n', { httpMetadata: { contentType: 'application/json' } });
      });
      throw error;
    }
  }
}

export default {
  fetch() { return new Response('Not found', { status: 404 }); },
  async scheduled(controller, env) {
    await env.BACKUP_WORKFLOW.create({ params: { scheduledTime: controller.scheduledTime } });
  },
};
