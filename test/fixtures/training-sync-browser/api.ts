import type { CampusTrainingDashboardResponse } from '../../../shared/campus-training-dashboard.interface';

export async function getCampusTrainingDashboard(
  month?: string,
  forceRefresh = false,
): Promise<CampusTrainingDashboardResponse> {
  const params = new URLSearchParams();
  if (month) params.set('month', month);
  if (forceRefresh) params.set('forceRefresh', '1');
  const response = await fetch(
    `/api/bitable/campus-training-dashboard?${params}`,
  );
  if (!response.ok) throw new Error('Synthetic training response unavailable');
  return response.json();
}

const outsideScope = async (): Promise<never> => {
  throw new Error('Certificate module is outside this synthetic fixture');
};
export const getCampusCertificateDashboard = outsideScope;
export const getCampusCertificateExpiryNotificationPreview = outsideScope;
export const sendCampusCertificateExpiryNotifications = outsideScope;
