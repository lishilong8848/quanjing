import { useEffect } from 'react';
import axios from 'axios';
export const axiosForBackend = axios.create();
export const logger = { error() {}, warn() {}, info() {}, debug() {} };
export function useAccess() { return { role: 'guest', capabilities: { canForceRefresh: false } }; }
export function useNantongAssistantPageSummary() {}
export function useTodayAttendanceSnapshot() { return null; }
export function OnDutyPeopleDialog() { return null; }
export function OperationsPanels({ onReadyChange }: { onReadyChange: (ready: boolean) => void }) {
  useEffect(() => { onReadyChange(true); }, [onReadyChange]);
  return null;
}
export * from '../../../client/src/api';
async function read(path: string) {
  const response = await fetch(`${path}?mode=${sessionStorage.getItem('panorama-recovery-mode') || 'fresh'}`);
  if (!response.ok) throw new Error('Fixture read failed');
  return response.json();
}
export function getTodayOperationsOverview() { return read('/fixture/overview'); }
export function getYearlySealingInfo() { return read('/fixture/sealing'); }
export async function getTodayOperationsKpis() { throw new Error('Outside fixture scope'); }
export async function getTodayOperationsAlarmDashboard() { throw new Error('Outside fixture scope'); }
