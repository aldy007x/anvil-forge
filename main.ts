// main.ts — anvil-forge: a GitHub-shaped git forge core in a single process.
//
// Boot contract with the trial harness:
//   1. read MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN from the environment,
//   2. start the HTTP service on an ephemeral port,
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register so the harness finds us,
//   4. poll $MAKEFUN_ENV_URL/done until it answers {"done": true},
//   5. shut down and exit 0.
//
// The service itself (REST + GraphQL + MCP + git smart HTTP over one
// in-memory store) lives under src/; this file is only the lifecycle.

import { Forge } from './src/forge.ts';
import { createForgeServer } from './src/httpapi.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** POST the registration body, retrying briefly while the harness warms up. */
async function registerWithHarness(envUrl: string, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (answer.ok) return;
      lastError = new Error(`register answered HTTP ${answer.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError instanceof Error ? lastError : new Error('registration never succeeded');
}

/** Poll the harness until it says the trial is over. */
async function waitForTrialEnd(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const answer = await fetch(`${envUrl}/done`);
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A harness that is briefly unreachable is not a finished trial.
    }
    await sleep(200);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set; there is no trial to serve');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const forge = new Forge();
  const server = createForgeServer(forge, token);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind a port');
  console.log(`anvil-forge listening on 127.0.0.1:${address.port}`);

  await registerWithHarness(envUrl.replace(/\/+$/, ''), address.port);
  await waitForTrialEnd(envUrl.replace(/\/+$/, ''));

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('anvil-forge failed to run', error);
  process.exit(1);
});
