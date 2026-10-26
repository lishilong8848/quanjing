export interface PersonnelRecoveryActor { id: string; name: string; authorizationVersion: number; }
export interface PersonnelRecoveryRequest {
  module: 'purchase' | 'contracts';
  taskId: string;
  expectedVersion: string;
  clientMutationId: string;
  selections?: string[];
}
export interface PersonnelRecoveryAudit {
  clientMutationId: string;
  previousVersion: string;
  actorId: string;
  actorName: string;
  authorizationVersion: number;
  requestedAt: string;
  evidence?: { hash: string; recordIds: string[] };
}
export interface PersonnelRecoveryTask {
  module: 'purchase' | 'contracts';
  id: string;
  recordId: string;
  title: string;
  actorName: string;
  createdAt: string;
  status: 'pending' | 'running' | 'failed' | 'completed';
  message: string;
  version: string;
  actionLabel: string;
  available: boolean;
  hint: string;
}
export interface PersonnelRecoveryResult { status: 'pending' | 'completed'; message: string; }
export interface PersonnelRecoveryPreview {
  task: PersonnelRecoveryTask;
  version: string;
  facts: { label: string; value: string }[];
  choices: { label: string; options: { value: string; label: string }[] }[];
  canConfirm: boolean;
  message?: string;
  acknowledgement: string;
}
