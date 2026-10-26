const AUTO_CLEANUP_COMMANDS = new Set(['prepare', 'checkpoint', 'verify']);

export async function runInventoryInboundLifecycle({
  command,
  operation,
  hasState,
  cleanup,
}) {
  let result;
  try {
    result = await operation();
  } catch (operationError) {
    if (!AUTO_CLEANUP_COMMANDS.has(command)) {
      throw operationError;
    }

    try {
      if (await hasState()) {
        await cleanup();
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `${command} 失败，自动清理也失败：${errorText(operationError)}；${errorText(
          cleanupError,
        )}`,
      );
    }
    throw operationError;
  }

  if (command === 'verify' && (await hasState())) {
    await cleanup();
  }
  return result;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
