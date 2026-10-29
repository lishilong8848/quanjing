import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ACCOUNT_MUTATION_FIELDS } from '../../../shared/access-configuration.interface';

type RequestWithBody = Omit<Request, 'body'> & { body?: unknown };

const LOGIN_BODY_FIELDS = [
  'employeeName',
  'accountType',
  'purchaseBuilding',
  'password',
] as const;

export const ACCESS_LOGIN_MIDDLEWARE_PATH = 'api/access/login';

@Injectable()
export class AccessLoginRedactionMiddleware implements NestMiddleware {
  use(request: RequestWithBody, _response: Response, next: NextFunction): void {
    const path = String(request.originalUrl || request.url || '').split('?')[0];
    if (isRecord(request.body) && /\/access\/personal\/password\/(change|reset)$/.test(path)) {
      const fields = path.endsWith('/reset') ? ['employeeName', 'identityNumber', 'newPassword', 'confirmPassword', 'clientMutationId'] : ['currentPassword', 'newPassword', 'confirmPassword', 'clientMutationId'];
      const body = request.body, safe = Object.create(null) as Record<string, unknown>;
      if (Object.keys(body).some(key => !fields.includes(key))) safe.invalidFields = true;
      for (const field of fields) if (Object.hasOwn(body, field)) Object.defineProperty(safe, field, { value: body[field], enumerable: field === 'clientMutationId', configurable: true, writable: true });
      request.body = safe;
      next();
      return;
    }
    if (isRecord(request.body)) request.body = redactLoginBody(request.body, String(request.originalUrl || request.url || '').split('?')[0].endsWith('/access/configuration/accounts'));
    next();
  }
}

function redactLoginBody(
  body: Record<string, unknown>,
  configuration = false,
): Record<string, unknown> {
  const redacted = Object.create(null) as Record<string, unknown>;
  try {
    if (configuration && Object.keys(body).some(key => !(ACCOUNT_MUTATION_FIELDS as readonly string[]).includes(key))) redacted.invalidFields = true;
    for (const field of configuration ? ACCOUNT_MUTATION_FIELDS : LOGIN_BODY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      const value = body[field];
      if (field === 'password' || field === 'openId' || field === 'employeeName') {
        Object.defineProperty(redacted, field, {
          configurable: true,
          enumerable: false,
          value,
          writable: true,
        });
      } else {
        redacted[field] = value;
      }
    }
  } catch {
    return Object.create(null) as Record<string, unknown>;
  }
  return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
