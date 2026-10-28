import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { effectivePagePaths, pageApiBinding } from '../../../shared/page-access';
import { isSiteMemberSessionAccountId, SITE_MEMBER_BACKUP_ACCOUNT_ID } from '../../../shared/site-member-backup';
import { businessModuleDefinition, hasBusinessPermissionSomewhere, isProfessionalBusinessPrincipal, personalPermissionPagePaths, validEffectiveAuthorization } from '../../../shared/business-permissions';
import { classifyBusinessRequest } from '../../../shared/business-request-permission';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type {
  AccessPrincipal,
  AccessRole,
} from '@shared/access-control.interface';
import {
  AdminOnlyMetadataKey,
  GuestReadableMetadataKey,
  GuestSubmittableMetadataKey,
  PublicAccessMetadataKey,
  ProfessionalScopedMetadataKey,
} from './unified-access.decorators';
import {
  ACCESS_SESSION_TTL_MS,
  type AccessLoginResult,
  UnifiedAccessService,
} from './unified-access.service';
import { verifyCampusOperationsScreenshotAccessToken } from '../../modules/duty-schedule/monthly-schedule-screenshot-access';

export const FIRST_PARTY_ACCESS_COOKIE_NAME = '__Host-vnet_access_session';
const LOGGED_OUT_COOKIE_VALUE = 'logged-out';

const CONTRACT_API_PREFIX = '/api/contract-management';
const PURCHASE_INVENTORY_API_PREFIX = '/api/purchase-inventory';
const CAMPUS_OPERATIONS_DASHBOARD_API_PATH =
  '/api/bitable/campus-operations-dashboard';
const CONSTRUCTION_MANAGEMENT_API_PREFIX =
  '/api/duty-schedules/construction-management';
const DUTY_EDITOR_EXACT_REQUESTS = new Set([
  'POST /api/duty-schedules/vacancy-substitute',
  'POST /api/duty-schedules/staff-adjustment',
  'GET /api/duty-schedules/travel-staff',
  'POST /api/duty-schedules/travel-staff',
  'POST /api/duty-schedules/travel-staff/adjust',
  'POST /api/duty-schedules/personnel-movement',
  'POST /api/duty-schedules/additional-matter',
  'POST /api/duty-schedules/sealing-registration',
  'POST /api/duty-schedules/leave-request',
  'POST /api/duty-schedules/overtime-request',
  'POST /api/duty-schedules/change-adjustment',
  'POST /api/duty-schedules/change-drill-report',
  'POST /api/duty-schedules/change-summary-report',
  'POST /api/duty-schedules/change-summary-report/abandon',
  'GET /api/duty-schedules/emergency-duty',
  'GET /api/duty-schedules/emergency-duty/options',
  'POST /api/duty-schedules/emergency-duty',
  'GET /api/duty-schedules/long-white-duty-staff',
  'GET /api/duty-schedules/work-calendar',
  'POST /api/duty-schedules/exception-follow-up',
  'GET /api/duty-schedules/exception-follow-ups',
  'POST /api/duty-schedules/exception-follow-up/update',
  'POST /api/change-info/adjustment',
  'GET /api/today-focus-checklist',
  'GET /api/bitable/weather/now',
  'GET /api/bitable/weather/warning',
  'GET /api/bitable/weather/hourly',
  'GET /api/bitable/person-profiles',
  'GET /api/bitable/person-profile-details',
  'GET /api/bitable/festival-schedules',
  'GET /api/bitable/today-leave-staff',
  'POST /api/sync-all-from-feishu',
  'POST /api/duty-schedules/sync-local-fast',
  'POST /api/duty-overview-screenshot/send',
  'GET /api/typhoon-path-screenshot/preview',
  'POST /api/typhoon-path-screenshot/send-group',
  'POST /api/system-monthly-report/submissions',
  'POST /api/system-monthly-report/reviews',
]);
const DUTY_EDITOR_MONTHLY_SCHEDULE_PATH =
  /^\/api\/monthly-schedules\/\d{4}\/(?:0?[1-9]|1[0-2])$/;
const DUTY_EDITOR_EMPLOYEE_PHOTO_PATH =
  /^\/api\/bitable\/employee-photo\/[a-z0-9_-]{1,128}$/i;
const DUTY_EDITOR_PERSON_CHAT_PATH =
  /^\/api\/bitable\/person-chat\/[a-z0-9_-]{1,128}$/i;
const DUTY_EDITOR_YEAR_PATH = /^\/api\/(?:sealing-info|change-info)\/\d{4}$/;
const DUTY_EDITOR_CHANGE_ATTACHMENT_PATH =
  /^\/api\/duty-schedules\/change-records\/[a-z0-9_-]{1,128}\/attachments\/[a-z0-9_-]{1,500}$/i;
const DUTY_EDITOR_CHANGE_SUMMARY_STATUS_PATH =
  /^\/api\/duty-schedules\/change-summary-report-sync\/change-summary-report-[0-9a-f-]{36}$/i;
const DUTY_EDITOR_SYSTEM_MONTHLY_REPORT_RETRY_PATH =
  /^\/api\/system-monthly-report\/tasks\/[a-z0-9_-]{12,160}\/retry$/i;
const CONSTRUCTION_SYNC_TASK_PATH =
  /^\/api\/sync-task\/construction-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENCODED_PATH_SEPARATOR_PATTERN = /%(?:2f|5c)/i;
const REQUEST_TARGET_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_REQUEST_TARGET_PATTERN =
  /^(https?):\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/i;
const MAX_AUTHORIZATION_PATH_DECODE_DEPTH = 3;
const GUEST_SUBMISSION_WINDOW_MS = 10 * 60 * 1000;
const GUEST_SUBMISSION_MAX_PER_SOURCE = 6;
const GUEST_SUBMISSION_MAX_IN_FLIGHT_PER_SOURCE = 1;
const GUEST_SUBMISSION_MAX_GLOBAL_IN_FLIGHT = 2;
const GUEST_SUBMISSION_MAX_TRACKED_SOURCES = 2048;
const INVENTORY_ADMIN_EXACT_REQUESTS = new Set([
  'GET /api/inventory-management/stocktake/overview',
  'GET /api/inventory-management/stocktake/sheet',
  'GET /api/inventory-management/stocktake/sync-status',
  'GET /api/inventory-management/stocktake/bulk-status',
  'POST /api/inventory-management/stocktake/start',
  'POST /api/inventory-management/stocktake/generate',
  'POST /api/inventory-management/stocktake/draft',
  'POST /api/inventory-management/stocktake/confirm',
  'POST /api/inventory-management/stocktake/bulk-confirm',
  'POST /api/inventory-management/stocktake/bulk-undo',
  'POST /api/inventory-management/stocktake/retry-sync',
  'POST /api/inventory-management/stocktake/refresh-line',
  'POST /api/inventory-management/stocktake/complete',
  'GET /api/inventory-management/dashboard',
  'GET /api/operations-tools/snapshot',
  'GET /api/inventory-management/items',
  'GET /api/inventory-management/movements',
  'GET /api/inventory-management/movement-options',
  'GET /api/inventory-management/storage-locations',
  'GET /api/purchase-inventory/applicant-search',
  'POST /api/inventory-management/storage-locations',
  'POST /api/inventory-management/movements',
  'POST /api/inventory-management/movements/deletions',
  'POST /api/inventory-management/outbounds',
  'POST /api/inventory-management/outbounds/batch',
  'GET /api/inventory-management/purchase-inbounds/pending',
  'POST /api/inventory-management/purchase-inbounds/confirm',
  'POST /api/inventory-management/purchase-inbounds/confirm-batch',
  'POST /api/inventory-management/purchase-inbounds/prepare-category',
]);
const INVENTORY_ADMIN_OUTBOUND_CONFIRM_PATH =
  /^\/api\/inventory-management\/outbounds\/[a-z0-9_-]{1,128}\/confirm$/;
const INVENTORY_ADMIN_OUTBOUND_TASK_PATH =
  /^\/api\/inventory-management\/outbounds\/tasks\/[a-z0-9_-]{1,160}$/;
const INVENTORY_ADMIN_INBOUND_TASK_PATH =
  /^\/api\/inventory-management\/inbounds\/tasks\/[a-z0-9_-]{1,160}$/;
const INVENTORY_ADMIN_PURCHASE_INBOUND_CATEGORY_TASK_PATH =
  /^\/api\/inventory-management\/purchase-inbounds\/category-tasks\/[a-z0-9_-]{1,160}$/;
const INVENTORY_ADMIN_MOVEMENT_DELETION_TASK_PATH =
  /^\/api\/inventory-management\/movements\/deletions\/tasks\/[a-z0-9_-]{1,180}$/;
const PURCHASE_APPLICANT_EXACT_REQUESTS = new Set([
  'GET /api/purchase-inventory/dashboard',
  'GET /api/purchase-inventory/application-options',
  'GET /api/purchase-inventory/catalog-search',
  'GET /api/purchase-inventory/applicant-search',
  'POST /api/purchase-inventory/applications',
  'POST /api/purchase-inventory/records/batch-delete',
]);
const PURCHASE_APPLICANT_RECORD_PATH = '/api/purchase-inventory/records/';
const PURCHASE_APPLICANT_WORKFLOW_PATH = '/api/purchase-inventory/workflows/';
const PURCHASE_APPLICANT_APPLICATION_TASK_PATH =
  '/api/purchase-inventory/applications/tasks/';
const PURCHASE_APPLICANT_RECEIPT_TASK_PATH = 'receipt-tasks/';
const POST_DELETE_PATHS = new Set([
  '/api/purchase-inventory/records/batch-delete',
  '/api/duty-schedules/construction-management/attachments/delete',
  '/api/duty-schedules/construction-management/projects/delete',
  '/api/duty-schedules/exception-follow-up/delete',
  '/api/duty-schedules/travel-staff/revoke',
]);

type AccessRequest = Request & {
  accessPrincipal?: AccessPrincipal;
  accessPrincipalFingerprint?: string;
  accessRole?: AccessRole;
  accessPageRead?: boolean;
};

type GuestSubmissionRateState = {
  windowStartedAt: number;
  count: number;
  inFlight: number;
};

export interface StrictCookieResult {
  present: boolean;
  value?: string;
}

@Injectable()
export class UnifiedAccessGuard implements CanActivate {
  private readonly guestSubmissionRates = new Map<
    string,
    GuestSubmissionRateState
  >();
  private guestSubmissionsInFlight = 0;

  constructor(
    private readonly reflector: Reflector,
    private readonly access: UnifiedAccessService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AccessRequest>();
    const path = normalizeApiPath(request);

    if (path === null) return false;
    if (!isApiPath(path)) return true;
    if (!this.access.isAccessControlEnabled() && !path.startsWith('/api/access/configuration')) {
      request.accessPrincipal = { role: 'admin', purchaseBuilding: null };
      request.accessPrincipalFingerprint =
        this.access.getUnrestrictedPrincipalFingerprint();
      request.accessRole = 'admin';
      return true;
    }
    if (this.hasMetadata(PublicAccessMetadataKey, context)) return true;

    const now = Date.now();
    const cookie = readAccessCookie(
      request.headers?.cookie,
      this.access,
      now,
    );
    const renewed = this.access.renew(cookie.value, now);
    const principal: AccessPrincipal = renewed?.principal ? {...renewed.principal} : {
      role: 'guest',
      purchaseBuilding: null,
    };
    request.accessPrincipal = principal;
    request.accessPrincipalFingerprint = renewed?.principalFingerprint;
    request.accessRole = principal.role;

    if (path.startsWith('/api/access/configuration')) return principal.role === 'admin';

    const classification = classifyBusinessRequest(path, request.method, hasForcedRefresh(request) || hasPageReadSideEffect(request));
    const business = classification.permission;
    if (business) principal.permissionContext = business;
    const scopedBusiness = isProfessionalBusinessPrincipal(principal);
    if (business) {
      if (!principal.effectiveAuthorization && scopedBusiness) {
        if (!classification.permissions?.every(permission=>hasBusinessPermissionSomewhere(principal,permission)) ||
          classification.candidatePermissions && !classification.candidatePermissions.some(permission=>hasBusinessPermissionSomewhere(principal,permission))) return false;
        principal.permissionContext=classification.candidatePermissions?.find(permission=>hasBusinessPermissionSomewhere(principal,permission)) || business;
        principal.permissionRequirements=classification.permissions;
      }
    }

    if (isAuthorizedCampusOperationsScreenshotRequest(request, path, now)) return true;

    if (principal.effectiveAuthorization && principal.role !== 'admin') {
      if (!validEffectiveAuthorization(principal.effectiveAuthorization) || classification.kind === 'admin' || classification.kind === 'denied') return false;
      if (classification.kind === 'business') {
        if (!classification.permissions?.every(permission=>hasBusinessPermissionSomewhere(principal,permission)) ||
          classification.candidatePermissions && !classification.candidatePermissions.some(permission=>hasBusinessPermissionSomewhere(principal,permission))) return false;
        const permission=classification.candidatePermissions?.find(permission=>hasBusinessPermissionSomewhere(principal,permission)) || business;
        if (!permission) return false;
        principal.permissionContext=permission;
        principal.permissionRequirements=classification.permissions;
        if (businessModuleDefinition(permission.module).scoped && isProfessionalBusinessPrincipal(principal) && !this.hasHandlerMetadata(ProfessionalScopedMetadataKey,context)) return false;
        if (this.hasHandlerMetadata(GuestSubmittableMetadataKey,context) && String(request.method).toUpperCase()==='POST') this.reserveGuestSubmission(context,request,now);
        if (permission.action==='read') request.accessPageRead=true;
        return true;
      }
      if (classification.kind === 'auxiliary' && classification.route?.dependencies) {
        if (!classification.route.dependencies.some(permission=>hasBusinessPermissionSomewhere(principal,permission))) return false;
        request.accessPageRead=true;
        return true;
      }
    }

    const inherited = this.access.pagePermissions?.(principal.role,principal.accountId,principal.authorizationVersion) ?? { paths: effectivePagePaths(principal.role), configured: false };
    const permissions = { ...inherited, paths: personalPermissionPagePaths(principal, inherited.paths) };
    const binding = pageApiBinding(path);
    const pageAllowed = binding?.pages.some(page => permissions.paths.includes(page));
    const isRead = String(request.method || '').toUpperCase() === 'GET';
    if (principal.role !== 'admin' && binding && (permissions.configured || principal.role === 'guest') && !pageAllowed) return false;
    if (principal.role === 'guest' && (/^\/api\/attendance(?:\/|$)/.test(path) || ['/api/duty-schedules/long-white-duty-staff', '/api/duty-schedules', '/api/bitable/non-duty-schedules'].includes(path))) return false;
    if (principal.role === 'site_member' && !(scopedBusiness && business)) {
      if (!renewed || !isSiteMemberSessionAccountId(principal.accountId) ||
        hasForcedRefresh(request) || hasPageReadSideEffect(request) || queryHasTrueValue(request.query?.recheck) ||
        rawQueryHasTrueValue(request.originalUrl || request.url || '') || this.hasHandlerMetadata(AdminOnlyMetadataKey, context)) return false;
      if (isRead) {
        const permitted=(!binding || !!pageAllowed) && !isAdminProtectedRequest(request.method,path) &&
          (!!binding?.readable || this.hasMetadata(GuestReadableMetadataKey,context));
        if (permitted && binding?.readable && permissions.configured) request.accessPageRead=true;
        return permitted;
      }
      if (principal.accountId !== SITE_MEMBER_BACKUP_ACCOUNT_ID && String(request.method || '').toUpperCase() === 'POST' && permissions.paths.includes('/monthly-schedule') &&
        ['/api/duty-schedules/leave-request', '/api/duty-schedules/overtime-request'].includes(path) &&
        this.hasHandlerMetadata(GuestSubmittableMetadataKey, context)) {
        this.reserveGuestSubmission(context, request, now); return true;
      }
      return false;
    }

    if (!(scopedBusiness && business) && principal.role !== 'admin' && permissions.configured && pageAllowed && binding?.readable && isRead &&
      !this.hasHandlerMetadata(AdminOnlyMetadataKey, context) && !hasPageReadSideEffect(request) &&
      !queryHasTrueValue(request.query?.recheck) && !rawQueryHasTrueValue(request.originalUrl || request.url || '')) {
      request.accessPageRead = true;
      return true;
    }

    if ((principal.role === 'guest' || principal.role === 'professional_admin' || principal.role === 'professional_engineer') &&
      (isConstructionManagementPath(path) || CONSTRUCTION_SYNC_TASK_PATH.test(path))) {
      return false;
    }


    if (principal.role === 'guest' && !(scopedBusiness && business) && (/^\/api\/(?:operations-kb|meeting-management|system-monthly-report|ali-monthly-report|attendance)(?:\/|$)/.test(path) || /^\/api\/bitable\/monthly-operations-[a-z-]+(?:\/|$)/.test(path) || path === '/api/duty-schedules/long-white-duty-staff')) return false;

    const requiresAdmin =
      isAdminProtectedRequest(request.method, path) ||
      this.hasMetadata(AdminOnlyMetadataKey, context) ||
      isContractManagementPath(path);
    if (principal.role === 'admin') return true;
    if (scopedBusiness && (principal.role === 'professional_admin' || business)) {
      if (/^\/api\/(?:operations-kb|meeting-management|system-monthly-report|ali-monthly-report)(?:\/|$)/.test(path)) return true;
      if (this.hasHandlerMetadata(ProfessionalScopedMetadataKey, context)) return true;
      if (!requiresAdmin && String(request.method || '').toUpperCase() === 'POST' && this.hasHandlerMetadata(GuestSubmittableMetadataKey, context)) {
        this.reserveGuestSubmission(context, request, now);
        return true;
      }
      return !requiresAdmin && String(request.method || '').toUpperCase() === 'GET' && this.hasMetadata(GuestReadableMetadataKey, context) && !hasForcedRefresh(request);
    }
    if (
      principal.role !== 'guest' &&
      !requiresAdmin &&
      String(request.method || '').toUpperCase() === 'GET' &&
      this.hasMetadata(GuestReadableMetadataKey, context)
    ) {
      return true;
    }
    if (
      !requiresAdmin &&
      String(request.method || '').toUpperCase() === 'POST' &&
      this.hasHandlerMetadata(GuestSubmittableMetadataKey, context)
    ) {
      if (principal.role !== 'editor' && principal.role !== 'duty_editor') {
        this.reserveGuestSubmission(context, request, now);
      }
      return true;
    }
    if (principal.role === 'inventory_admin') {
      return canInventoryAdministratorAccess(request.method, path);
    }
    if (principal.role === 'building_admin') {
      const method = String(request.method || '').toUpperCase();
      if (
        requiresAdmin &&
        !isPurchaseApplicantAdminOnlyException(method, path) &&
        !(method === 'POST' && /^\/api\/purchase-inventory\/records\/[^/]+\/approval$/.test(path)) &&
        !(method === 'GET' && /^\/api\/purchase-inventory\/approval\/tasks\/[^/]+$/.test(path))
      ) {
        return false;
      }
      if (
        method === 'POST' &&
        /^\/api\/purchase-inventory\/workflows\/reminders\/[^/]+\/run$/.test(path)
      ) {
        return false;
      }
      return (
        (method === 'GET' && /^\/api\/equipment-ledger\/(dashboard|items|lifecycle|lifecycle-dashboard|history|history-devices)$/.test(path)) ||
        canInventoryAdministratorAccess(method, path) ||
        isPurchaseInventoryPath(path) ||
        (method === 'GET' &&
          (path === '/api/bitable/campus-training-dashboard' ||
            path === '/api/bitable/campus-certificate-dashboard' ||
            path.startsWith('/api/risk-inspection/'))) ||
        (method === 'PATCH' &&
          /^\/api\/risk-inspection\/ali-monthly-quality\/issues\/[a-z0-9_-]{1,128}\/supplemental$/i.test(path))
      );
    }
    if (principal.role === 'purchase_admin') {
      return isPurchaseInventoryPath(path) || isContractManagementPath(path);
    }
    if (principal.role === 'supply_chain_admin') {
      return isPurchaseInventoryPath(path) || isContractManagementPath(path);
    }
    if (principal.role === 'purchase_applicant') {
      const canAccess = canPurchaseApplicantAccess(request.method, path);
      if (!canAccess) return false;
      return (
        !requiresAdmin ||
        isPurchaseApplicantAdminOnlyException(request.method, path)
      );
    }
    if (principal.role === 'construction_admin') {
      return canConstructionAdministratorAccess(request.method, path);
    }
    if (principal.role === 'duty_editor') {
      return canDutyEditorAccess(request, path);
    }
    if (principal.role === 'editor') {
      return (
        !requiresAdmin ||
        isPurchaseRecordDeleteAdminOnlyException(request.method, path)
      );
    }
    if (requiresAdmin) return false;
    if (principal.role !== 'guest') return false;

    return (
      String(request.method || '').toUpperCase() === 'GET' &&
      this.hasMetadata(GuestReadableMetadataKey, context) &&
      !hasForcedRefresh(request)
    );
  }

  private hasMetadata(key: string, context: ExecutionContext): boolean {
    return Boolean(
      this.reflector.getAllAndOverride<boolean>(key, [
        context.getHandler(),
        context.getClass(),
      ]),
    );
  }

  private hasHandlerMetadata(key: string, context: ExecutionContext): boolean {
    return Boolean(this.reflector.get<boolean>(key, context.getHandler()));
  }

  private reserveGuestSubmission(
    context: ExecutionContext,
    request: AccessRequest,
    now: number,
  ): void {
    for (const [source, state] of this.guestSubmissionRates) {
      if (
        state.inFlight === 0 &&
        state.windowStartedAt + GUEST_SUBMISSION_WINDOW_MS <= now
      ) {
        this.guestSubmissionRates.delete(source);
      }
    }

    const source = normalizeGuestSubmissionSource(request);
    let state = this.guestSubmissionRates.get(source);
    if (
      state &&
      state.inFlight === 0 &&
      state.windowStartedAt + GUEST_SUBMISSION_WINDOW_MS <= now
    ) {
      state = { windowStartedAt: now, count: 0, inFlight: 0 };
      this.guestSubmissionRates.set(source, state);
    }
    if (!state) {
      if (
        this.guestSubmissionRates.size >= GUEST_SUBMISSION_MAX_TRACKED_SOURCES
      ) {
        throw tooManyGuestSubmissions();
      }
      state = { windowStartedAt: now, count: 0, inFlight: 0 };
      this.guestSubmissionRates.set(source, state);
    }
    if (
      state.count >= GUEST_SUBMISSION_MAX_PER_SOURCE ||
      state.inFlight >= GUEST_SUBMISSION_MAX_IN_FLIGHT_PER_SOURCE ||
      this.guestSubmissionsInFlight >= GUEST_SUBMISSION_MAX_GLOBAL_IN_FLIGHT
    ) {
      throw tooManyGuestSubmissions();
    }

    state.count += 1;
    state.inFlight += 1;
    this.guestSubmissionsInFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state!.inFlight = Math.max(0, state!.inFlight - 1);
      this.guestSubmissionsInFlight = Math.max(
        0,
        this.guestSubmissionsInFlight - 1,
      );
    };
    const response = context.switchToHttp().getResponse<Response>();
    if (response && typeof response.once === 'function') {
      response.once('finish', release);
      response.once('close', release);
    } else {
      release();
    }
  }
}

function normalizeGuestSubmissionSource(request: AccessRequest): string {
  if (environmentFlag('LOCAL_ACCESS_TRUST_PROXY')) {
    const forwarded = request.headers?.['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const forwardedAddress = String(first || '')
      .split(',')[0]
      .trim()
      .slice(0, 128);
    if (forwardedAddress) return `forwarded:${forwardedAddress}`;
  }
  return (
    String(request.ip || request.socket?.remoteAddress || 'unknown')
      .trim()
      .slice(0, 128) || 'unknown'
  );
}

function tooManyGuestSubmissions(): HttpException {
  return new HttpException(
    '游客提交过于频繁，请稍后再试',
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function readStrictCookie(
  header: string | undefined,
  expectedName: string,
): StrictCookieResult {
  if (typeof header !== 'string' || !header) return { present: false };

  let value: string | undefined;
  let matches = 0;
  for (const rawPart of header.split(';')) {
    const separator = rawPart.indexOf('=');
    if (separator < 1) {
      if (rawPart.trim() === expectedName) {
        matches += 1;
        if (matches > 1) return { present: true };
      }
      continue;
    }
    const name = rawPart.slice(0, separator).trim();
    if (name !== expectedName) continue;
    matches += 1;
    if (matches > 1) return { present: true };

    const encoded = rawPart.slice(separator + 1).trim();
    if (!encoded || encoded.startsWith('"') || encoded.endsWith('"')) {
      continue;
    }
    try {
      value = decodeURIComponent(encoded);
    } catch {
      value = undefined;
    }
  }

  return matches
    ? { present: true, ...(value ? { value } : {}) }
    : { present: false };
}

export function readAccessCookie(
  header: string | undefined,
  access: UnifiedAccessService,
  now = Date.now(),
): StrictCookieResult & { diagnostic?: 'duplicate' | 'malformed' | 'rejected' } {
  const firstParty = readStrictCookie(header, FIRST_PARTY_ACCESS_COOKIE_NAME);
  const legacy = readStrictCookie(header, access.cookieName);
  const selected = firstParty.present ? firstParty : legacy;
  const selectedName = firstParty.present ? FIRST_PARTY_ACCESS_COOKIE_NAME : access.cookieName;
  if (selected.present && !selected.value) {
    const matches = typeof header === 'string'
      ? header.split(';').filter(part => part.split('=', 1)[0].trim() === selectedName).length
      : 0;
    return { present: true, diagnostic: matches > 1 ? 'duplicate' : 'malformed' };
  }
  if (firstParty.value === LOGGED_OUT_COOKIE_VALUE) return { present: false };
  if (firstParty.value && legacy.value && firstParty.value !== legacy.value) {
    const firstPartyIssuedAt = access.readSessionIssuedAt(firstParty.value, now);
    const legacyIssuedAt = access.readSessionIssuedAt(legacy.value, now);
    // Partial cookie writes must not confirm an older identity after an account switch.
    if (firstPartyIssuedAt === null ||
      (legacyIssuedAt !== null && firstPartyIssuedAt <= legacyIssuedAt)) {
      return { present: true, diagnostic: 'rejected' };
    }
  }
  return selected;
}

export function writeAccessCookie(
  response: Response,
  request: Request,
  name: string,
  session: AccessLoginResult,
  now: number,
): void {
  const options = accessCookieSecurityOptions(request);
  const { partitioned, ...unpartitionedOptions } = options;
  // Partitioned cookies do not replace a same-name cookie from older releases.
  if (partitioned) response.clearCookie(name, unpartitionedOptions);
  response.cookie(name, session.token, {
    ...options,
    expires: new Date(session.expiresAt),
    maxAge: Math.max(0, session.expiresAt - now),
  });
  if (options.secure) {
    response.cookie(FIRST_PARTY_ACCESS_COOKIE_NAME, session.token, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      expires: new Date(session.expiresAt),
      maxAge: Math.max(0, session.expiresAt - now),
    });
  }
}

export function clearAccessCookie(
  response: Response,
  request: Request,
  name: string,
): void {
  const options = accessCookieSecurityOptions(request);
  const { partitioned, ...unpartitionedOptions } = options;
  if (partitioned) response.clearCookie(name, unpartitionedOptions);
  response.clearCookie(name, options);
  if (options.secure) {
    // A container may refuse partitioned deletion; block legacy fallback until every old session expires.
    response.cookie(FIRST_PARTY_ACCESS_COOKIE_NAME, LOGGED_OUT_COOKIE_VALUE, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      maxAge: ACCESS_SESSION_TTL_MS,
      expires: new Date(Date.now() + ACCESS_SESSION_TTL_MS),
    });
  }
}

function accessCookieSecurityOptions(request: Request) {
  const secure = isSecureRequest(request);
  return {
    httpOnly: true as const,
    sameSite: secure ? ('none' as const) : ('strict' as const),
    path: '/',
    secure,
    ...(secure ? { partitioned: true } : {}),
  };
}

function isSecureRequest(request: Request): boolean {
  if (
    request.secure ||
    request.protocol === 'https' ||
    Boolean((request.socket as { encrypted?: boolean } | undefined)?.encrypted)
  ) {
    return true;
  }
  if (environmentFlag('LOCAL_ACCESS_COOKIE_SECURE')) return true;
  if (!environmentFlag('LOCAL_ACCESS_TRUST_PROXY')) return false;

  const forwarded = request.headers?.['x-forwarded-proto'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (
    String(first || '')
      .split(',')[0]
      .trim()
      .toLowerCase() === 'https'
  );
}

function environmentFlag(name: string): boolean {
  return (
    String(process.env[name] || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

interface ParsedRequestTarget {
  pathname: string;
  searchParams: URLSearchParams;
}

function normalizeApiPath(request: Request): string | null {
  const requestPath = requestPathname(request);
  if (requestPath === null) return null;
  let path = requestPath.toLowerCase();
  const basePath = normalizeClientBasePath(process.env.CLIENT_BASE_PATH);
  if (basePath === null) return null;
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
    path = path.slice(basePath.length) || '/';
  }
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
}

function normalizeClientBasePath(value: string | undefined): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  if (
    trimmed.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(trimmed) ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    return null;
  }

  const normalized = `${trimmed.startsWith('/') ? '' : '/'}${trimmed}`.replace(
    /\/+$/g,
    '',
  );
  if (!isSafeAuthorizationPath(normalized)) return null;
  return normalized.toLowerCase();
}

function requestPathname(request: Request): string | null {
  const rawRequestTargets = [request.originalUrl, request.url];
  for (const candidate of rawRequestTargets) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== 'string' || !candidate) return null;
    return parseRequestTarget(candidate)?.pathname ?? null;
  }

  const parsedPath = request.path;
  if (typeof parsedPath !== 'string' || !parsedPath) return null;
  return parseRequestTarget(parsedPath)?.pathname ?? null;
}

function parseRequestTarget(value: unknown): ParsedRequestTarget | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('/')) {
    return parseOriginFormRequestTarget(value);
  }
  return parseAbsoluteFormRequestTarget(value);
}

function parseOriginFormRequestTarget(
  value: string,
): ParsedRequestTarget | null {
  if (value.includes('#')) return null;
  const queryIndex = value.indexOf('?');
  const pathname = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  if (!pathname || !isSafeAuthorizationPath(pathname)) return null;
  return {
    pathname,
    searchParams: new URLSearchParams(
      queryIndex >= 0 ? value.slice(queryIndex + 1) : '',
    ),
  };
}

function parseAbsoluteFormRequestTarget(
  value: string,
): ParsedRequestTarget | null {
  if (
    REQUEST_TARGET_CONTROL_PATTERN.test(value) ||
    value.includes('\\') ||
    value.includes('#')
  ) {
    return null;
  }
  const match = ABSOLUTE_REQUEST_TARGET_PATTERN.exec(value);
  if (!match) return null;
  const pathname = match[3] || '/';
  if (!isSafeAuthorizationPath(pathname)) return null;

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return {
      pathname,
      searchParams: new URLSearchParams(match[4] || ''),
    };
  } catch {
    return null;
  }
}

function isSafeAuthorizationPath(pathname: string): boolean {
  let layer = pathname;
  for (
    let decodeDepth = 0;
    decodeDepth <= MAX_AUTHORIZATION_PATH_DECODE_DEPTH;
    decodeDepth += 1
  ) {
    if (
      REQUEST_TARGET_CONTROL_PATTERN.test(layer) ||
      layer.includes('\\') ||
      ENCODED_PATH_SEPARATOR_PATTERN.test(layer) ||
      hasDotPathSegment(layer)
    ) {
      return false;
    }
    if (
      decodeDepth === MAX_AUTHORIZATION_PATH_DECODE_DEPTH ||
      !layer.includes('%')
    ) {
      return true;
    }
    try {
      const decodedLayer = decodeURIComponent(layer);
      if (decodedLayer === layer) return true;
      layer = decodedLayer;
    } catch {
      return decodeDepth > 0;
    }
  }
  return true;
}

function hasDotPathSegment(pathname: string): boolean {
  return pathname
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

function isPurchaseInventoryPath(path: string): boolean {
  return (
    path === PURCHASE_INVENTORY_API_PREFIX ||
    path.startsWith(`${PURCHASE_INVENTORY_API_PREFIX}/`)
  );
}

function canInventoryAdministratorAccess(
  method: string,
  path: string,
): boolean {
  const normalizedMethod = String(method || '').toUpperCase();
  return (
    INVENTORY_ADMIN_EXACT_REQUESTS.has(`${normalizedMethod} ${path}`) ||
    (normalizedMethod === 'POST' &&
      INVENTORY_ADMIN_OUTBOUND_CONFIRM_PATH.test(path)) ||
    (normalizedMethod === 'GET' &&
      (INVENTORY_ADMIN_OUTBOUND_TASK_PATH.test(path) ||
        INVENTORY_ADMIN_INBOUND_TASK_PATH.test(path) ||
        INVENTORY_ADMIN_PURCHASE_INBOUND_CATEGORY_TASK_PATH.test(path) ||
        INVENTORY_ADMIN_MOVEMENT_DELETION_TASK_PATH.test(path)))
  );
}

function isContractManagementPath(path: string): boolean {
  return (
    path === CONTRACT_API_PREFIX || path.startsWith(`${CONTRACT_API_PREFIX}/`)
  );
}

function isConstructionManagementPath(path: string): boolean {
  return (
    path === CONSTRUCTION_MANAGEMENT_API_PREFIX ||
    path.startsWith(`${CONSTRUCTION_MANAGEMENT_API_PREFIX}/`)
  );
}

function canConstructionAdministratorAccess(
  method: string,
  path: string,
): boolean {
  if (isConstructionManagementPath(path)) return true;
  return canReadSafeSyncTask(method, path);
}

function canDutyEditorAccess(request: Request, path: string): boolean {
  const normalizedMethod = String(request.method || '').toUpperCase();
  if (normalizedMethod === 'POST' && path === '/api/change-info/adjustment') {
    const body = request.body;
    if (hasOwnProperty(body, 'clearAdjustment')) {
      const clearAdjustment = body.clearAdjustment;
      if (typeof clearAdjustment !== 'boolean' || clearAdjustment === true) {
        return false;
      }
    }
  }
  if (DUTY_EDITOR_EXACT_REQUESTS.has(`${normalizedMethod} ${path}`)) {
    return true;
  }
  if (
    normalizedMethod === 'GET' &&
    (DUTY_EDITOR_MONTHLY_SCHEDULE_PATH.test(path) ||
      DUTY_EDITOR_EMPLOYEE_PHOTO_PATH.test(path) ||
      DUTY_EDITOR_PERSON_CHAT_PATH.test(path) ||
      DUTY_EDITOR_YEAR_PATH.test(path) ||
      DUTY_EDITOR_CHANGE_ATTACHMENT_PATH.test(path) ||
      DUTY_EDITOR_CHANGE_SUMMARY_STATUS_PATH.test(path))
  ) {
    return true;
  }
  if (
    normalizedMethod === 'POST' &&
    DUTY_EDITOR_SYSTEM_MONTHLY_REPORT_RETRY_PATH.test(path)
  ) {
    return true;
  }
  return false;
}

function canReadSafeSyncTask(method: string, path: string): boolean {
  return (
    String(method || '').toUpperCase() === 'GET' &&
    CONSTRUCTION_SYNC_TASK_PATH.test(path)
  );
}

function hasOwnProperty(
  value: unknown,
  property: string,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, property)
  );
}

function canPurchaseApplicantAccess(method: string, path: string): boolean {
  const normalizedMethod = String(method || '').toUpperCase();
  if (PURCHASE_APPLICANT_EXACT_REQUESTS.has(`${normalizedMethod} ${path}`)) {
    return true;
  }
  if (
    normalizedMethod === 'GET' &&
    path.startsWith(PURCHASE_APPLICANT_APPLICATION_TASK_PATH)
  ) {
    return isSingleSafePathSegment(
      path.slice(PURCHASE_APPLICANT_APPLICATION_TASK_PATH.length),
    );
  }
  if (path.startsWith(PURCHASE_APPLICANT_WORKFLOW_PATH)) {
    const suffix = path.slice(PURCHASE_APPLICANT_WORKFLOW_PATH.length);
    if (normalizedMethod === 'GET') {
      if (suffix.startsWith(PURCHASE_APPLICANT_RECEIPT_TASK_PATH)) {
        return isSingleSafePathSegment(
          suffix.slice(PURCHASE_APPLICANT_RECEIPT_TASK_PATH.length),
        );
      }
      return (
        suffix !== PURCHASE_APPLICANT_RECEIPT_TASK_PATH.slice(0, -1) &&
        isSingleSafePathSegment(suffix)
      );
    }
    if (normalizedMethod === 'POST') {
      for (const action of ['/order', '/receive']) {
        if (suffix.endsWith(action)) {
          return isSingleSafePathSegment(suffix.slice(0, -action.length));
        }
      }
    }
    return false;
  }
  if (
    normalizedMethod !== 'PATCH' ||
    !path.startsWith(PURCHASE_APPLICANT_RECORD_PATH)
  ) {
    return false;
  }

  return isSingleSafePathSegment(
    path.slice(PURCHASE_APPLICANT_RECORD_PATH.length),
  );
}

function isSingleSafePathSegment(value: string): boolean {
  if (!value || value.includes('/')) return false;
  try {
    const decodedRecordId = decodeURIComponent(value);
    return (
      Boolean(decodedRecordId) &&
      !decodedRecordId.includes('/') &&
      !decodedRecordId.includes('\\')
    );
  } catch {
    return false;
  }
}

function isPurchaseApplicantAdminOnlyException(
  method: string,
  path: string,
): boolean {
  return (
    String(method || '').toUpperCase() === 'POST' &&
    path === '/api/purchase-inventory/records/batch-delete'
  );
}

function isPurchaseRecordDeleteAdminOnlyException(
  method: string,
  path: string,
): boolean {
  return (
    String(method || '').toUpperCase() === 'POST' &&
    path === '/api/purchase-inventory/records/batch-delete'
  );
}

function isAdminProtectedRequest(method: string, path: string): boolean {
  const normalizedMethod = String(method || '').toUpperCase();
  return (
    normalizedMethod === 'DELETE' ||
    (normalizedMethod === 'POST' && POST_DELETE_PATHS.has(path))
  );
}

function hasPageReadSideEffect(request: Request): boolean {
  const params = parseRequestTarget(request.originalUrl || request.url || '')?.searchParams;
  return ['refresh', 'forceRefresh', 'recheck', 'force'].some(key => {
    const values = [...(params?.getAll(key) || []), ...(Array.isArray(request.query?.[key]) ? request.query[key] as unknown[] : [request.query?.[key]])];
    return values.some(value => value !== undefined && !['', '0', 'false'].includes(String(value).trim().toLowerCase()) &&
      !(key==='refresh' && value==='active' && normalizeApiPath(request)==='/api/purchase-inventory/dashboard'));
  });
}
function hasForcedRefresh(request: Request): boolean {
  return (
    queryHasTrueValue(request.query?.refresh) ||
    queryHasTrueValue(request.query?.forceRefresh) ||
    rawQueryHasTrueValue(request.originalUrl || request.url || '')
  );
}

function isAuthorizedCampusOperationsScreenshotRequest(
  request: Request,
  path: string,
  now: number,
): boolean {
  if (
    String(request.method || '').toUpperCase() !== 'GET' ||
    path !== CAMPUS_OPERATIONS_DASHBOARD_API_PATH ||
    hasForcedRefresh(request)
  ) {
    return false;
  }

  const screenshotDate = readSingleQueryText(request.query?.screenshotDate);
  const screenshotShift = readSingleQueryText(request.query?.screenshotShift);
  const screenshotToken = readSingleQueryText(request.query?.screenshotToken);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(screenshotDate) ||
    (screenshotShift !== 'white' && screenshotShift !== 'night') ||
    !screenshotToken
  ) {
    return false;
  }

  return verifyCampusOperationsScreenshotAccessToken(
    screenshotDate,
    screenshotShift,
    screenshotToken,
    now,
  );
}

function readSingleQueryText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function queryHasTrueValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(queryHasTrueValue);
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function rawQueryHasTrueValue(url: string): boolean {
  const parsed = parseRequestTarget(url);
  if (!parsed) return false;
  return ['refresh', 'forceRefresh', 'recheck'].some((key) =>
    parsed.searchParams.getAll(key).some(queryHasTrueValue),
  );
}
