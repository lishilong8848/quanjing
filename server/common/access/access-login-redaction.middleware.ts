import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

type RequestWithBody = Omit<Request, 'body'> & { body?: unknown };

const LOGIN_BODY_FIELDS = [
  'employeeName',
  'accountType',
  'purchaseBuilding',
  'password',
] as const;
const CONFIGURATION_BODY_FIELDS = ['clientMutationId','expectedRevision','id','kind','name','role','building','enabled','deleted','openId','password','external','specialties','buildings','personalRules','pagePaths'] as const;

export const ACCESS_LOGIN_MIDDLEWARE_PATH = 'api/access/login';

@Injectable()
export class AccessLoginRedactionMiddleware implements NestMiddleware {
  use(request: RequestWithBody, _response: Response, next: NextFunction): void {
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
    if (configuration && Object.keys(body).some(key => !(CONFIGURATION_BODY_FIELDS as readonly string[]).includes(key))) redacted.invalidFields = true;
    for (const field of configuration ? CONFIGURATION_BODY_FIELDS : LOGIN_BODY_FIELDS) {
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
