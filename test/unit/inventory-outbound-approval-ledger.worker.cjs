'use strict';

require('reflect-metadata');

const {
  InventoryOutboundApprovalStore,
} = require('../../server/modules/inventory-outbound-approval/inventory-outbound-approval.store.ts');

let command;

process.on('message', async (message) => {
  try {
    if (!message || typeof message !== 'object') {
      throw new Error('Worker message must be an object');
    }
    if (message.type === 'initialize') {
      if (command) throw new Error('Worker was already initialized');
      command = {
        store: new InventoryOutboundApprovalStore(message.ledgerPath, {
          lockTimeoutMs: 5_000,
          lockRetryDelayMs: 2,
          staleLockMs: 30_000,
        }),
        decision: message.decision,
      };
      send({ type: 'initialized' });
      return;
    }
    if (message.type === 'start') {
      if (!command) throw new Error('Worker is not initialized');
      await waitUntil(message.notBeforeMs);
      try {
        const result = await command.store.claimDecision(command.decision);
        send({
          type: 'result',
          winner: result.claimed,
          eventId: result.decision.eventId,
        });
      } catch (error) {
        send({
          type: 'result',
          winner: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === 'release') {
      if (process.connected) process.disconnect();
      return;
    }
    throw new Error(`Unsupported worker message: ${String(message.type)}`);
  } catch (error) {
    fail(error);
  }
});

async function waitUntil(notBeforeMs) {
  if (!Number.isFinite(notBeforeMs)) return;
  const remaining = notBeforeMs - Date.now();
  if (remaining > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, remaining));
  }
}

function send(message) {
  if (!process.connected) throw new Error('Worker IPC channel is disconnected');
  process.send(message);
}

function fail(error) {
  process.exitCode = 1;
  if (!process.connected) return;
  process.send(
    {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    },
    () => process.connected && process.disconnect(),
  );
}
