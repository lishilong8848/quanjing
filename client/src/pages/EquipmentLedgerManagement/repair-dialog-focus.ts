export function createRepairDialogFocus(
  requestFrame: typeof requestAnimationFrame = requestAnimationFrame,
  cancelFrame: typeof cancelAnimationFrame = cancelAnimationFrame,
) {
  let frame: number | undefined;
  let generation = 0;
  const cancel = () => {
    generation += 1;
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
  };
  return {
    cancel,
    schedule(target: () => HTMLInputElement | null) {
      cancel();
      const current = generation;
      frame = requestFrame(() => {
        if (current !== generation) return;
        frame = requestFrame(() => {
          if (current !== generation) return;
          frame = undefined;
          const input = target();
          if (input?.isConnected) input.focus({ preventScroll: true });
        });
      });
    },
  };
}
