import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PurchaseInventoryController purchase application submission', () => {
  const source = readFileSync(
    join(
      process.cwd(),
      'server/modules/purchase-inventory/purchase-inventory.controller.ts',
    ),
    'utf8',
  );
  const mainSource = readFileSync(
    join(process.cwd(), 'server/main.ts'),
    'utf8',
  );

  it('submits purchase applications without reading an OAuth cookie', () => {
    const method = source.slice(
      source.indexOf("@Post('applications')"),
      source.indexOf("@Get('workflows/status')"),
    );

    expect(method).not.toContain('getRequiredSession');
    expect(method).not.toContain('session.accessToken');
    expect(method).toContain('this.applicationService.acceptApplications(');
    expect(method).toContain('@HttpCode(HttpStatus.ACCEPTED)');
  });

  it('requires and forwards the idempotency key and verified content fingerprint', () => {
    const method = source.slice(
      source.indexOf("@Post('applications')"),
      source.indexOf("@Get('applications/tasks/:taskId')"),
    );

    expect(source).toContain('Headers,');
    expect(method).toContain("@Headers('x-idempotency-key')");
    expect(method).toContain("@Headers('x-idempotency-fingerprint')");
    expect(method).toContain(
      'normalizePurchaseApplicationIdempotencyKey(idempotencyKey)',
    );
    expect(method).toContain(
      'normalizePurchaseApplicationSubmissionFingerprint(',
    );
    expect(source).toContain('accessPrincipalFingerprint?: string;');
    expect(method).toContain('requireAccessPrincipalFingerprint(req)');
    expect(method).toContain('findAcceptedApplication(');
    expect(method).not.toContain(
      'await this.applicationService.resolveApplicantForBuilding(',
    );
    expect(method).toMatch(
      /acceptApplications\(\s*request,\s*files,\s*undefined,\s*normalizedIdempotencyKey,\s*normalizedSubmissionFingerprint,\s*fingerprintRequest,\s*principalFingerprint,\s*true,?\s*\)/,
    );
    expect(method).not.toContain('return idempotencyKey ?');
    expect(method).not.toContain(
      'this.applicationService.acceptApplications(request, files);',
    );
  });

  it('renders the purchase SPA without a personal OAuth callback bridge', () => {
    expect(mainSource).not.toContain(
      "req.path === '/purchase-inventory-management'",
    );
    expect(mainSource).not.toContain('req.query.code');
    expect(mainSource).not.toContain('req.query.state');
    expect(mainSource).not.toContain(
      '/purchase-inventory/application-auth/callback',
    );
  });
});
