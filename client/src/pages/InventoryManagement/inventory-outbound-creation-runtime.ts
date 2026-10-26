import type { InventoryMovementItem } from '@shared/inventory-management.interface';
import {
  createInventoryOutboundCreationCoordinator,
  type InventoryOutboundCreationCoordinator,
  type InventoryOutboundCreationCoordinatorDependencies,
  type InventoryOutboundCreationCoordinatorEvent,
} from './inventory-outbound-creation-coordinator';
import type {
  InventoryOutboundCreationTaskInput,
  InventoryOutboundCreationTaskJournal,
} from './inventory-outbound-creation-task';

interface RuntimeEntry {
  coordinator: InventoryOutboundCreationCoordinator;
  journal: InventoryOutboundCreationTaskJournal;
}

type CoordinatorFactory = (
  dependencies: InventoryOutboundCreationCoordinatorDependencies,
) => InventoryOutboundCreationCoordinator;

export interface InventoryOutboundCreationRuntimeDependencies extends Omit<
  InventoryOutboundCreationCoordinatorDependencies,
  'onEvent' | 'readJournal'
> {
  readJournals: (
    principalFingerprint: string,
  ) => Promise<InventoryOutboundCreationTaskJournal[]>;
  onEvent: (event: InventoryOutboundCreationCoordinatorEvent) => void;
  createCoordinator?: CoordinatorFactory;
}

export interface InventoryOutboundCreationRuntime {
  start(input: InventoryOutboundCreationTaskInput): Promise<boolean>;
  resume(journal: InventoryOutboundCreationTaskJournal): Promise<boolean>;
  resumeAll(
    journals: readonly InventoryOutboundCreationTaskJournal[],
  ): Promise<boolean>;
  checkNow(): Promise<boolean>;
  reconcileAuthoritativeMovement(
    movement: InventoryMovementItem,
  ): Promise<boolean>;
  hasPendingAcceptance(): boolean;
  getCurrentJournals(): InventoryOutboundCreationTaskJournal[];
  stop(): void;
}

export function createInventoryOutboundCreationRuntime(
  dependencies: InventoryOutboundCreationRuntimeDependencies,
): InventoryOutboundCreationRuntime {
  const createCoordinator =
    dependencies.createCoordinator ??
    createInventoryOutboundCreationCoordinator;
  const activeEntries = new Map<string, RuntimeEntry>();
  const allCoordinators = new Set<InventoryOutboundCreationCoordinator>();
  let activationPending = false;
  let stopped = false;

  function cloneJournal(
    journal: InventoryOutboundCreationTaskJournal,
  ): InventoryOutboundCreationTaskJournal {
    return {
      ...journal,
      ...(journal.recoveredFromFailedReceipt
        ? {
            recoveredFromFailedReceipt: {
              ...journal.recoveredFromFailedReceipt,
            },
          }
        : {}),
      request: { ...journal.request },
      draft: {
        ...journal.draft,
        selectedItem: { ...journal.draft.selectedItem },
        applicant: { ...journal.draft.applicant },
      },
      optimisticItem: { ...journal.optimisticItem },
    };
  }

  function currentJournals(): InventoryOutboundCreationTaskJournal[] {
    return [...activeEntries.values()]
      .map((entry) => cloneJournal(entry.journal))
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.clientMutationId.localeCompare(right.clientMutationId),
      );
  }

  function hasPendingAcceptance(): boolean {
    return (
      activationPending ||
      [...activeEntries.values()].some((entry) => entry.journal.taskId === null)
    );
  }

  function createEntry(
    initialJournal: InventoryOutboundCreationTaskJournal,
  ): RuntimeEntry | null {
    if (
      stopped ||
      activeEntries.has(initialJournal.clientMutationId) ||
      (initialJournal.taskId === null &&
        [...activeEntries.values()].some(
          (entry) => entry.journal.taskId === null,
        ))
    ) {
      return null;
    }
    const mutationId = initialJournal.clientMutationId;
    let coordinator!: InventoryOutboundCreationCoordinator;
    const handleEvent = (
      event: InventoryOutboundCreationCoordinatorEvent,
    ): void => {
      const current = activeEntries.get(mutationId);
      if (
        stopped ||
        current?.coordinator !== coordinator ||
        event.journal.clientMutationId !== mutationId
      ) {
        return;
      }
      if (event.type === 'completed' || event.type === 'failed') {
        activeEntries.delete(mutationId);
      } else {
        current.journal = cloneJournal(event.journal);
      }
      dependencies.onEvent(event);
    };
    coordinator = createCoordinator({
      principalFingerprint: dependencies.principalFingerprint,
      submitOutbound: dependencies.submitOutbound,
      getTaskStatus: dependencies.getTaskStatus,
      saveJournal: dependencies.saveJournal,
      finalizeJournal: dependencies.finalizeJournal,
      resolveJournal: dependencies.resolveJournal,
      readJournal: async (principalFingerprint) => {
        const journals = await dependencies.readJournals(principalFingerprint);
        return (
          journals.find((journal) => journal.clientMutationId === mutationId) ||
          null
        );
      },
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.setTimer ? { setTimer: dependencies.setTimer } : {}),
      ...(dependencies.clearTimer
        ? { clearTimer: dependencies.clearTimer }
        : {}),
      onEvent: handleEvent,
    });
    const entry = {
      coordinator,
      journal: cloneJournal(initialJournal),
    };
    activeEntries.set(mutationId, entry);
    allCoordinators.add(coordinator);
    return entry;
  }

  async function start(
    input: InventoryOutboundCreationTaskInput,
  ): Promise<boolean> {
    if (stopped || hasPendingAcceptance()) return false;
    activationPending = true;
    const initialJournal: InventoryOutboundCreationTaskJournal = {
      version: 1,
      ...input,
    };
    const entry = createEntry(initialJournal);
    if (!entry) {
      activationPending = false;
      return false;
    }
    try {
      const started = await entry.coordinator.start(input);
      if (!started) {
        if (activeEntries.get(input.clientMutationId) === entry) {
          activeEntries.delete(input.clientMutationId);
        }
        entry.coordinator.stop();
      }
      return started;
    } finally {
      activationPending = false;
    }
  }

  async function resume(
    journal: InventoryOutboundCreationTaskJournal,
  ): Promise<boolean> {
    if (stopped) return false;
    const entry = createEntry(journal);
    if (!entry) return false;
    const resumed = await entry.coordinator.resume(journal);
    if (!resumed) {
      if (activeEntries.get(journal.clientMutationId) === entry) {
        activeEntries.delete(journal.clientMutationId);
      }
      entry.coordinator.stop();
    }
    return resumed;
  }

  return {
    start,
    resume,
    async resumeAll(journals) {
      const sorted = [...journals].sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.clientMutationId.localeCompare(right.clientMutationId),
      );
      let allResumed = true;
      for (const journal of sorted) {
        if (!(await resume(journal))) allResumed = false;
      }
      return allResumed;
    },
    async checkNow() {
      if (stopped) return false;
      const results = await Promise.all(
        [...allCoordinators].map((coordinator) => coordinator.checkNow()),
      );
      return results.some(Boolean);
    },
    async reconcileAuthoritativeMovement(movement) {
      const mutationId = movement.clientMutationId?.trim();
      if (!mutationId) return false;
      const entry = activeEntries.get(mutationId);
      return entry
        ? entry.coordinator.reconcileAuthoritativeMovement(movement)
        : false;
    },
    hasPendingAcceptance,
    getCurrentJournals: currentJournals,
    stop() {
      if (stopped) return;
      stopped = true;
      activeEntries.clear();
      for (const coordinator of allCoordinators) coordinator.stop();
      allCoordinators.clear();
    },
  };
}
