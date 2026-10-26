'use strict';

require('reflect-metadata');

const { appendFileSync, existsSync } = require('node:fs');
const {
  InventoryOutboundTaskLedgerStore,
} = require('../../server/modules/inventory-management/inventory-outbound-task-ledger.store.ts');

let command;
let observedAbsent = false;
let started = false;
let completed = false;

process.on('message', async (message) => {
  try {
    if (!message || typeof message !== 'object') {
      throw new Error('Worker message must be an object');
    }
    switch (message.type) {
      case 'initialize':
        initialize(message);
        break;
      case 'start':
        await start(message);
        break;
      case 'commit':
        commit();
        break;
      case 'release':
        release();
        break;
      default:
        throw new Error(`Unsupported worker message: ${String(message.type)}`);
    }
  } catch (error) {
    fail(error);
  }
});

function initialize(message) {
  if (command) throw new Error('Worker was already initialized');
  if (message.action === 'lockless-reserve-probe') {
    if (typeof message.probePath !== 'string' || !message.probePath) {
      throw new Error('Lockless probe path is required');
    }
    if (typeof message.taskId !== 'string' || !message.taskId) {
      throw new Error('Lockless task id is required');
    }
    command = {
      action: message.action,
      probePath: message.probePath,
      taskId: message.taskId,
    };
  } else if (message.action === 'production-reserve') {
    if (typeof message.ledgerPath !== 'string' || !message.ledgerPath) {
      throw new Error('Production ledger path is required');
    }
    if (!message.entry || typeof message.entry !== 'object') {
      throw new Error('Production reservation entry is required');
    }
    command = {
      action: message.action,
      entry: message.entry,
      store: productionStore(message.ledgerPath),
    };
  } else if (
    message.action === 'production-claim' ||
    message.action === 'production-claim-uncertain'
  ) {
    if (typeof message.ledgerPath !== 'string' || !message.ledgerPath) {
      throw new Error('Production ledger path is required');
    }
    if (typeof message.taskId !== 'string' || !message.taskId) {
      throw new Error('Production claim task id is required');
    }
    command = {
      action: message.action,
      store: productionStore(message.ledgerPath),
      taskId: message.taskId,
    };
  } else {
    throw new Error(`Unsupported worker action: ${String(message.action)}`);
  }
  send({ type: 'initialized' });
}

async function start(message) {
  if (!command) throw new Error('Worker is not initialized');
  if (started) throw new Error('Worker was already started');
  started = true;
  await waitUntil(message.notBeforeMs);
  if (command.action === 'production-reserve') {
    completed = true;
    const reservation = await command.store.reserve(command.entry);
    send({
      type: 'result',
      winner: reservation.created,
      taskId: reservation.entry.task.id,
    });
    return;
  }
  if (command.action === 'production-claim') {
    completed = true;
    const claim = await command.store.claimPending(command.taskId);
    send({
      type: 'result',
      winner: claim.claimed,
      taskId: claim.entry.task.id,
    });
    return;
  }
  if (command.action === 'production-claim-uncertain') {
    completed = true;
    const claim = await command.store.claimUncertain(command.taskId);
    send({
      type: 'result',
      winner: claim.claimed,
      taskId: claim.entry.task.id,
    });
    return;
  }
  observedAbsent = !existsSync(command.probePath);
  send({
    type: 'phase',
    name: observedAbsent ? 'observed-absent' : 'observed-existing',
  });
}

function commit() {
  if (!command || !started) throw new Error('Worker has not read the probe');
  if (command.action !== 'lockless-reserve-probe') {
    throw new Error('Only the lockless probe has a commit phase');
  }
  if (completed) throw new Error('Worker was already committed');
  completed = true;
  if (observedAbsent) {
    appendFileSync(command.probePath, `${process.pid}\n`, 'utf8');
  }
  send({
    type: 'result',
    winner: observedAbsent,
    taskId: command.taskId,
  });
}

function release() {
  if (process.connected) process.disconnect();
}

function productionStore(ledgerPath) {
  return new InventoryOutboundTaskLedgerStore(ledgerPath, {
    lockTimeoutMs: 5_000,
    lockRetryDelayMs: 2,
    staleLockMs: 30_000,
  });
}

async function waitUntil(notBeforeMs) {
  if (!Number.isFinite(notBeforeMs)) return;
  const remaining = notBeforeMs - Date.now();
  if (remaining <= 0) return;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, remaining));
}

function send(message, callback) {
  if (!process.connected) throw new Error('Worker IPC channel is disconnected');
  process.send(message, callback);
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  if (!process.connected) return;
  process.send({ type: 'error', message }, () => {
    if (process.connected) process.disconnect();
  });
}
