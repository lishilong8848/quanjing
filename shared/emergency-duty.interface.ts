export interface EmergencyDutyPerson {
  key: string;
  name: string;
  role: string;
}

export interface EmergencyDutySchedule {
  recordId: string;
  date: string;
  people: EmergencyDutyPerson[];
  building: string | null;
}

export interface EmergencyDutyScheduleResponse {
  schedules: EmergencyDutySchedule[];
  snapshot: {
    fetchedAt: string;
    expiresAt: string;
    stale: boolean;
  };
}

export interface EmergencyDutyPersonOption {
  key: string;
  name: string;
  role: string;
}

export interface EmergencyDutyOptionsResponse {
  options: EmergencyDutyPersonOption[];
}

export interface EmergencyDutyUpsertRequest {
  date: string;
  personKeys: string[];
  clientMutationId: string;
}

export type EmergencyDutySyncStatus = 'synced' | 'cache_refresh_pending';

export interface EmergencyDutyUpsertResponse {
  record: EmergencyDutySchedule;
  syncStatus: EmergencyDutySyncStatus;
  clientMutationId: string;
}
