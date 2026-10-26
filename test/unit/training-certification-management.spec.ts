import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildTrainingCertificationHref,
  parseTrainingCertificationModule,
} from '../../client/src/pages/TrainingCertificationManagement/model';
import { PAGE_REGISTRY } from '../../client/src/navigation/page-switcher';

describe('training certification module routing', () => {
  it('defaults invalid or missing values to certificate', () => {
    expect(parseTrainingCertificationModule(null)).toBe('certificate');
    expect(parseTrainingCertificationModule(undefined)).toBe('certificate');
    expect(parseTrainingCertificationModule('unknown')).toBe('certificate');
  });

  it('keeps the two supported modules addressable', () => {
    expect(parseTrainingCertificationModule('certificate')).toBe('certificate');
    expect(parseTrainingCertificationModule('training')).toBe('training');
    expect(buildTrainingCertificationHref('certificate')).toBe(
      '/training-certification-management?module=certificate',
    );
    expect(buildTrainingCertificationHref('training')).toBe(
      '/training-certification-management?module=training',
    );
  });
});

describe('training certification management page shell', () => {
  it('presents two accessible business modules inside one page', () => {
    const pageSource = readFileSync(
      resolve(
        process.cwd(),
        'client/src/pages/TrainingCertificationManagement/index.tsx',
      ),
      'utf8',
    );
    const styles = readFileSync(
      resolve(
        process.cwd(),
        'client/src/pages/TrainingCertificationManagement/styles.css',
      ),
      'utf8',
    );

    expect(pageSource).toContain('培训持证管理');
    expect(pageSource).toContain('持证管理');
    expect(pageSource).toContain('培训管理');
    expect(pageSource).toContain('aria-pressed={activeModule === module.key}');
    expect(pageSource).toContain('visitedModules');
    expect(pageSource).toContain('onHeaderStateChange');
    expect(pageSource).toContain('setSearchParams({ module: nextModule })');
    expect(styles).toContain('.training-certification-hero');
    expect(styles).toContain('.training-certification-module-grid');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('certificate dashboard embedded mode', () => {
  it('reports header state and uses a natural responsive layout', () => {
    const pageSource = readFileSync(
      resolve(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/index.tsx',
      ),
      'utf8',
    );
    const styles = readFileSync(
      resolve(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/styles.css',
      ),
      'utf8',
    );

    expect(pageSource).toContain('embedded?: boolean');
    expect(pageSource).toContain('onHeaderStateChange?:');
    expect(pageSource).toContain('certificate-dashboard-embedded');
    expect(pageSource).toContain('useFixedStage(!embedded)');
    expect(pageSource).toContain('onHeaderStateChange?.({');
    expect(styles).toContain('.certificate-dashboard-embedded');
    expect(styles).toMatch(
      /\.certificate-dashboard-embedded[\s\S]*?\.certificate-dashboard-body[\s\S]*?grid-template-columns:/,
    );
  });
});

describe('training dashboard embedded mode', () => {
  it('reports header state and keeps its month control in a responsive layout', () => {
    const pageSource = readFileSync(
      resolve(
        process.cwd(),
        'client/src/pages/CampusTrainingDashboard/index.tsx',
      ),
      'utf8',
    );
    const styles = readFileSync(
      resolve(
        process.cwd(),
        'client/src/pages/CampusTrainingDashboard/styles.css',
      ),
      'utf8',
    );

    expect(pageSource).toContain('embedded?: boolean');
    expect(pageSource).toContain('onHeaderStateChange?:');
    expect(pageSource).toContain('campus-training-dashboard-embedded');
    expect(pageSource).toContain('useResponsiveStage(!embedded)');
    expect(pageSource).toContain('sourceUpdatedAt || dashboard.syncedAt');
    expect(pageSource).toContain('onHeaderStateChange?.({');
    expect(styles).toContain('.campus-training-dashboard-embedded');
    expect(styles).toMatch(
      /\.campus-training-dashboard-embedded[\s\S]*?\.training-metric-grid[\s\S]*?grid-template-columns:/,
    );
  });
});

describe('training certification navigation integration', () => {
  it('exposes one people-domain entry and redirects both legacy routes', () => {
    const appSource = readFileSync(
      resolve(process.cwd(), 'client/src/app.tsx'),
      'utf8',
    );
    const peoplePaths = PAGE_REGISTRY.filter(
      (page) => page.domainKey === 'people',
    ).map((page) => page.path);

    expect(peoplePaths).toContain('/training-certification-management');
    expect(peoplePaths).not.toContain('/campus-certificate-dashboard');
    expect(peoplePaths).not.toContain('/campus-training-dashboard');
    expect(appSource).toContain(
      "import('./pages/TrainingCertificationManagement')",
    );
    expect(appSource).toContain('path="/training-certification-management"');
    expect(appSource).toContain(
      'to="/training-certification-management?module=certificate"',
    );
    expect(appSource).toContain(
      'to="/training-certification-management?module=training"',
    );
  });
});
