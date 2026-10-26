import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import {
  WEATHER_CURRENT_AND_HOURLY_REFRESH_MS,
  WEATHER_WARNING_REFRESH_MS,
  isDisplayActiveWarning,
  shouldApplyWeatherResponse,
  startWeatherRefreshSchedule,
} from '../../client/src/pages/MonthlySchedule/weather-snapshot';
import {
  clearWeatherGuardRegistrationDeepLink,
  readWeatherGuardRegistrationDeepLink,
} from '../../client/src/pages/MonthlySchedule/weather-warning-registration';

function readMonthlySchedulePage(): ts.SourceFile {
  const path = join(
    process.cwd(),
    'client/src/pages/MonthlySchedule/index.tsx',
  );
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function readMonthlyScheduleStyles(): string {
  return readFileSync(join(process.cwd(), 'client/src/index.css'), 'utf8');
}

function readWeatherWarningInfoPopover(): ts.SourceFile {
  const path = join(
    process.cwd(),
    'client/src/pages/MonthlySchedule/WeatherWarningInfoPopover.tsx',
  );

  try {
    return ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') {
      throw new Error(
        'Expected production source file WeatherWarningInfoPopover.tsx to exist',
      );
    }
    throw error;
  }
}

function readSharedPopover(): ts.SourceFile {
  const path = join(process.cwd(), 'client/src/components/ui/popover.tsx');
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function findFunction(
  source: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );

  if (!declaration) {
    throw new Error(`Expected function ${name} to be declared`);
  }

  return declaration;
}

function findCallExpressions(
  node: ts.Node,
  identifier: string,
): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  const visit = (current: ts.Node) => {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === identifier
    ) {
      matches.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return matches;
}

function findIdentifierCallNames(
  node: ts.Node,
  predicate: (identifier: string) => boolean,
): string[] {
  const matches: string[] = [];
  const visit = (current: ts.Node) => {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      predicate(current.expression.text)
    ) {
      matches.push(current.expression.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return matches;
}

function findObjectBindingsInitializedByIdentifier(
  node: ts.Node,
  identifier: string,
): ts.VariableDeclaration[] {
  const matches: ts.VariableDeclaration[] = [];
  const visit = (current: ts.Node) => {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isObjectBindingPattern(current.name) &&
      current.initializer &&
      ts.isIdentifier(current.initializer) &&
      current.initializer.text === identifier
    ) {
      matches.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return matches;
}

function findJsxOpenings(
  node: ts.Node,
  tagName: string,
): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  const matches: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  const visit = (current: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(current) ||
        ts.isJsxSelfClosingElement(current)) &&
      current.tagName.getText() === tagName
    ) {
      matches.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return matches;
}

function findJsxElements(node: ts.Node, tagName: string): ts.JsxElement[] {
  const matches: ts.JsxElement[] = [];
  const visit = (current: ts.Node) => {
    if (
      ts.isJsxElement(current) &&
      current.openingElement.tagName.getText() === tagName
    ) {
      matches.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return matches;
}

function findOwnReturnJsxExpressions(
  declaration: ts.FunctionDeclaration,
): ts.Expression[] {
  const matches: ts.Expression[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isFunctionLike(current)) {
      return;
    }
    if (ts.isReturnStatement(current) && current.expression) {
      let expression = current.expression;
      while (ts.isParenthesizedExpression(expression)) {
        expression = expression.expression;
      }
      if (
        ts.isJsxElement(expression) ||
        ts.isJsxFragment(expression) ||
        ts.isJsxSelfClosingElement(expression)
      ) {
        matches.push(expression);
      }
      return;
    }
    ts.forEachChild(current, visit);
  };

  if (declaration.body) {
    ts.forEachChild(declaration.body, visit);
  }
  return matches;
}

function getImportModuleSpecifiers(source: ts.SourceFile): string[] {
  return source.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

function importsNamedBinding(
  source: ts.SourceFile,
  moduleSpecifier: string,
  binding: string,
): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.moduleSpecifier.text !== moduleSpecifier
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => element.name.text === binding)
    );
  });
}

function getJsxAttributeExpressionText(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  attributeName: string,
): string | null {
  const attribute = opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.text === attributeName,
  );
  if (!attribute?.initializer || !ts.isJsxExpression(attribute.initializer)) {
    return null;
  }

  return attribute.initializer.expression?.getText() ?? null;
}

function getJsxAttributeStringText(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  attributeName: string,
): string | null {
  const attribute = opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.text === attributeName,
  );
  if (!attribute?.initializer || !ts.isStringLiteral(attribute.initializer)) {
    return null;
  }

  return attribute.initializer.text;
}

function hasJsxBooleanAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  attributeName: string,
): boolean {
  return opening.attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) &&
      property.name.text === attributeName &&
      property.initializer === undefined,
  );
}

function hasJsxAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  attributeName: string,
): boolean {
  return opening.attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) && property.name.text === attributeName,
  );
}

describe('MonthlySchedule weather refresh policy', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('refreshes the warning snapshot every 10 minutes and current weather plus hourly data every 30 minutes', () => {
    jest.useFakeTimers();
    const refreshSnapshot = jest.fn();
    const refreshCurrentAndHourly = jest.fn();

    const stop = startWeatherRefreshSchedule({
      refreshSnapshot,
      refreshCurrentAndHourly,
    });

    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(refreshCurrentAndHourly).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(WEATHER_WARNING_REFRESH_MS);
    expect(refreshSnapshot).toHaveBeenCalledTimes(2);
    expect(refreshCurrentAndHourly).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(
      WEATHER_CURRENT_AND_HOURLY_REFRESH_MS - WEATHER_WARNING_REFRESH_MS,
    );
    expect(refreshSnapshot).toHaveBeenCalledTimes(4);
    expect(refreshCurrentAndHourly).toHaveBeenCalledTimes(2);

    stop();
    jest.advanceTimersByTime(WEATHER_CURRENT_AND_HOURLY_REFRESH_MS);
    expect(refreshSnapshot).toHaveBeenCalledTimes(4);
    expect(refreshCurrentAndHourly).toHaveBeenCalledTimes(2);
  });

  it('only applies the response belonging to the latest request sequence', () => {
    expect(
      shouldApplyWeatherResponse({
        latestRequestId: 3,
        responseRequestId: 2,
      }),
    ).toBe(false);
    expect(
      shouldApplyWeatherResponse({
        latestRequestId: 3,
        responseRequestId: 3,
      }),
    ).toBe(true);
    expect(
      shouldApplyWeatherResponse({
        latestRequestId: 3,
        responseRequestId: 4,
      }),
    ).toBe(false);
  });

  it('uses the same terminal-status and end-time rules as the warning snapshot service', () => {
    const nowMs = Date.parse('2026-08-04T00:00:00.000Z');

    expect(
      isDisplayActiveWarning(
        null as unknown as Parameters<typeof isDisplayActiveWarning>[0],
        nowMs,
      ),
    ).toBe(false);

    expect(
      isDisplayActiveWarning(
        {
          id: 'active-warning',
          sender: 'nantong',
          pubTime: '2026-08-03T23:00:00.000Z',
          title: '暴雨橙色预警',
          startTime: '2026-08-03T23:00:00.000Z',
          endTime: '2026-08-04T01:00:00.000Z',
          status: '发布',
          level: '橙色',
          type: '暴雨',
          text: '',
        },
        nowMs,
      ),
    ).toBe(true);

    expect(
      isDisplayActiveWarning(
        {
          id: 'released-warning',
          sender: 'nantong',
          pubTime: '2026-08-03T23:00:00.000Z',
          title: '暴雨橙色预警',
          startTime: '2026-08-03T23:00:00.000Z',
          endTime: '2026-08-04T01:00:00.000Z',
          status: ' 已解除 ',
          level: '橙色',
          type: '暴雨',
          text: '',
        },
        nowMs,
      ),
    ).toBe(false);

    expect(
      isDisplayActiveWarning(
        {
          id: 'expired-warning',
          sender: 'nantong',
          pubTime: '2026-08-03T23:00:00.000Z',
          title: '暴雨橙色预警',
          startTime: '2026-08-03T23:00:00.000Z',
          endTime: '2026-08-03T23:59:59.000Z',
          status: '发布',
          level: '橙色',
          type: '暴雨',
          text: '',
        },
        nowMs,
      ),
    ).toBe(false);

    expect(
      isDisplayActiveWarning(
        {
          id: 'invalid-time-warning',
          sender: 'nantong',
          pubTime: '2026-08-03T23:00:00.000Z',
          title: '暴雨橙色预警',
          startTime: '2026-08-03T23:00:00.000Z',
          endTime: '2026-08-04T01:00:00',
          status: '发布',
          level: '橙色',
          type: '暴雨',
          text: '',
        },
        nowMs,
      ),
    ).toBe(false);
  });

  it('creates one shared weather snapshot and injects the exact result into both weather sections', () => {
    const source = readMonthlySchedulePage();
    const page = findFunction(source, 'MonthlySchedulePageContent');

    expect(findCallExpressions(page, 'useWeatherSnapshot')).toHaveLength(1);

    for (const componentName of ['WeatherWidget', 'WeatherTrendPanel']) {
      const openings = findJsxOpenings(page, componentName);
      expect(openings).toHaveLength(1);
      expect(
        getJsxAttributeExpressionText(openings[0], 'weatherSnapshot'),
      ).toBe('weatherSnapshot');
    }
  });

  it('keeps weather requests out of both presentation components and derives both screenshot callbacks from the shared readiness', () => {
    const source = readMonthlySchedulePage();

    for (const componentName of ['WeatherWidget', 'WeatherTrendPanel']) {
      const component = findFunction(source, componentName);
      expect(findCallExpressions(component, 'getQWeatherNow')).toHaveLength(0);
      expect(findCallExpressions(component, 'getQWeatherWarning')).toHaveLength(
        0,
      );
      expect(findCallExpressions(component, 'getQWeatherHourly')).toHaveLength(
        0,
      );
      expect(findCallExpressions(component, 'setInterval')).toHaveLength(0);

      const loadStateCalls = findCallExpressions(
        component,
        'onLoadStateChange',
      );
      expect(loadStateCalls).toHaveLength(1);
      expect(loadStateCalls[0].arguments[0]?.getText()).toBe(
        'weatherSnapshot.screenshotReadiness',
      );
    }

    const trend = findFunction(source, 'WeatherTrendPanel');
    expect(findCallExpressions(trend, 'useWeatherSnapshot')).toHaveLength(0);
    const weatherSnapshotParameter = trend.parameters.find(
      (parameter) =>
        ts.isObjectBindingPattern(parameter.name) &&
        parameter.name.elements.some(
          (element) =>
            element.propertyName === undefined &&
            ts.isIdentifier(element.name) &&
            element.name.text === 'weatherSnapshot',
        ),
    );
    expect(weatherSnapshotParameter).toBeDefined();

    const snapshotBindings = findObjectBindingsInitializedByIdentifier(
      trend,
      'weatherSnapshot',
    );
    expect(snapshotBindings).toHaveLength(1);
    const snapshotBinding = snapshotBindings[0];
    expect(snapshotBinding.parent.flags & ts.NodeFlags.Const).toBeTruthy();
    expect(ts.isObjectBindingPattern(snapshotBinding.name)).toBe(true);
    if (!ts.isObjectBindingPattern(snapshotBinding.name)) {
      throw new Error('Expected weatherSnapshot to use object destructuring');
    }
    expect(
      snapshotBinding.name.elements.map((element) => element.name.getText()),
    ).toEqual(['weather', 'hourlyWeather', 'warningSnapshot']);
    const warningSnapshotBinding = snapshotBinding.name.elements.find(
      (element) => element.name.getText() === 'warningSnapshot',
    );
    expect(warningSnapshotBinding?.propertyName).toBeUndefined();
    expect(warningSnapshotBinding?.initializer).toBeUndefined();
  });

  it('removes the weather-warning test-card control and its page-owned state', () => {
    const source = readMonthlySchedulePage();
    const pageSource = source.getFullText();
    const removedControls = [
      '预警卡片测试',
      'WeatherWarningTestCardDialog',
      'weatherWarningTestCardDialogOpen',
      'setWeatherWarningTestCardDialogOpen',
    ];

    expect(
      removedControls.filter((control) => pageSource.includes(control)),
    ).toEqual([]);
  });

  it('removes the legacy shared registration form from all remaining weather UI files', () => {
    const paths = [
      'client/src/pages/MonthlySchedule/index.tsx',
      'client/src/pages/MonthlySchedule/WeatherWarningInfoPopover.tsx',
      'client/src/pages/MonthlySchedule/WeatherWarningTestCardDialog.tsx',
      'client/src/pages/MonthlySchedule/weather-warning-links.ts',
    ];
    const sources = paths.map((relativePath) =>
      readFileSync(join(process.cwd(), relativePath), 'utf8'),
    );

    for (const source of sources) {
      expect(source).not.toContain('/share/base/form/');
      expect(source).not.toContain('WEATHER_WARNING_REGISTRATION_URL');
    }
    expect(sources[2]).not.toContain('APPROVAL_URL');
    expect(sources[2]).not.toContain('提交审批');
  });

  it('keeps one cached trigger in every trend branch and renders one persistent summary beside the calendar', () => {
    const source = readMonthlySchedulePage();
    const trend = findFunction(source, 'WeatherTrendPanel');
    const returnExpressions = findOwnReturnJsxExpressions(trend);

    expect(returnExpressions).toHaveLength(3);
    for (const returnExpression of returnExpressions) {
      const triggerOpenings = findJsxOpenings(
        returnExpression,
        'WeatherWarningInfoPopover',
      );
      const refreshOpenings = findJsxOpenings(
        returnExpression,
        'WeatherRefreshIndicator',
      );

      expect(triggerOpenings).toHaveLength(1);
      expect(
        findJsxOpenings(returnExpression, 'WeatherWarningSnapshotSummary'),
      ).toHaveLength(0);
      expect(refreshOpenings).toHaveLength(1);
      expect(
        getJsxAttributeExpressionText(triggerOpenings[0], 'warningSnapshot'),
      ).toBe('warningSnapshot');
      expect(
        getJsxAttributeExpressionText(triggerOpenings[0], 'warningStatus'),
      ).toBe('weatherSnapshot.warningStatus');
      expect(
        getJsxAttributeExpressionText(triggerOpenings[0], 'warningError'),
      ).toBe('weatherSnapshot.warningError');
      expect(
        getJsxAttributeExpressionText(triggerOpenings[0], 'warningFailureKind'),
      ).toBe('weatherSnapshot.warningFailureKind');
      expect(
        getJsxAttributeExpressionText(triggerOpenings[0], 'onRegisterGuard'),
      ).toBe('onRegisterGuard');
      expect(
        getJsxAttributeExpressionText(refreshOpenings[0], 'isRefreshing'),
      ).toBe('weatherSnapshot.isRefreshing');
    }

    expect(findJsxOpenings(trend, 'WeatherWarningInfoPopover')).toHaveLength(3);
    expect(
      findJsxOpenings(trend, 'WeatherWarningSnapshotSummary'),
    ).toHaveLength(0);
    expect(findJsxOpenings(trend, 'WeatherRefreshIndicator')).toHaveLength(3);

    const summaries = findJsxOpenings(source, 'WeatherWarningSnapshotSummary');
    expect(summaries).toHaveLength(1);
    expect(getJsxAttributeExpressionText(summaries[0], 'warningSnapshot')).toBe(
      'weatherSnapshot.warningSnapshot',
    );
    expect(getJsxAttributeExpressionText(summaries[0], 'warningStatus')).toBe(
      'weatherSnapshot.warningStatus',
    );
    expect(getJsxAttributeExpressionText(summaries[0], 'onRegisterGuard')).toBe(
      'weatherGuardRegistrationEnabled\n                ? handleWeatherGuardRegistrationOpen\n                : undefined',
    );
  });

  it('reads only an exact registration deep link and clears only its three parameters', () => {
    expect(
      readWeatherGuardRegistrationDeepLink(
        new URLSearchParams(
          'view=compact&weatherGuardRegistration=1&warningId=warning-7&source=feishu-card',
        ),
      ),
    ).toEqual({ warningId: 'warning-7', source: 'feishu-card' });
    expect(
      readWeatherGuardRegistrationDeepLink(
        new URLSearchParams(
          'weatherGuardRegistration=1&warningId=%20warning-7&source=feishu-card',
        ),
      ),
    ).toBeNull();

    const cleared = clearWeatherGuardRegistrationDeepLink(
      new URLSearchParams(
        'view=compact&weatherGuardRegistration=1&warningId=warning-7&source=feishu-card&tab=weather',
      ),
    );
    expect(cleared.toString()).toBe('view=compact&tab=weather');
    expect(`/monthly-schedule?${cleared.toString()}#warning`).toBe(
      '/monthly-schedule?view=compact&tab=weather#warning',
    );
  });

  it('owns one feature-gated registration dialog and refreshes only the warning snapshot after success', () => {
    const source = readMonthlySchedulePage();
    const page = findFunction(source, 'MonthlySchedulePageContent');
    const pageText = page.getText();
    const dialogs = findJsxOpenings(
      page,
      'WeatherWarningGuardRegistrationDialog',
    );

    expect(dialogs).toHaveLength(1);
    expect(
      source.getFullText().match(/<WeatherWarningGuardRegistrationDialog/gu),
    ).toHaveLength(1);
    expect(pageText).toContain(
      'useState<WeatherGuardRegistrationDeepLink | null>(null)',
    );
    expect(pageText).toContain('readWeatherGuardRegistrationDeepLink(');
    expect(pageText).toContain('new URLSearchParams(window.location.search)');
    expect(pageText).toContain("source: 'page'");

    expect(getJsxAttributeExpressionText(dialogs[0], 'open')).toBe(
      'weatherGuardRegistration !== null',
    );
    expect(getJsxAttributeExpressionText(dialogs[0], 'warningId')).toBe(
      'weatherGuardRegistration?.warningId ?? null',
    );
    expect(getJsxAttributeExpressionText(dialogs[0], 'source')).toBe(
      "weatherGuardRegistration?.source ?? 'page'",
    );
    const submitted =
      getJsxAttributeExpressionText(dialogs[0], 'onSubmitted') ?? '';
    expect(submitted).toContain('void weatherSnapshot.refreshWarning()');
    expect(submitted).not.toContain('refreshAll');
    expect(submitted).not.toContain('reload');
    expect(submitted).not.toContain('onOpenChange');

    const trend = findJsxOpenings(page, 'WeatherTrendPanel');
    const summaries = findJsxOpenings(page, 'WeatherWarningSnapshotSummary');
    expect(trend).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(getJsxAttributeExpressionText(trend[0], 'onRegisterGuard')).toBe(
      'weatherGuardRegistrationEnabled\n                ? handleWeatherGuardRegistrationOpen\n                : undefined',
    );
    expect(getJsxAttributeExpressionText(summaries[0], 'onRegisterGuard')).toBe(
      'weatherGuardRegistrationEnabled\n                ? handleWeatherGuardRegistrationOpen\n                : undefined',
    );
    expect(pageText).toMatch(
      /weatherGuardRegistrationEnabled\s*&&\s*\(\s*<WeatherWarningGuardRegistrationDialog/u,
    );
  });

  it('fails closed when registration or progress feature flags are absent or disabled', () => {
    const source = readMonthlySchedulePage();
    const page = findFunction(source, 'MonthlySchedulePageContent');
    const pageText = page.getText();
    const popoverText = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningInfoPopover.tsx',
      ),
      'utf8',
    );

    expect(pageText).toContain(
      "warningSnapshot?.features?.registrationEnabled === true",
    );
    expect(pageText).toContain(
      'useState<WeatherGuardRegistrationDeepLink | null>(null)',
    );
    expect(pageText).toMatch(
      /warningStatus !== 'ready'[\s\S]*warningStatus !== 'error'/u,
    );
    expect(pageText).toContain('readWeatherGuardRegistrationDeepLink(');
    expect(pageText).toContain('clearWeatherGuardRegistrationDeepLink(');
    expect(pageText).toMatch(
      /onRegisterGuard=\{\s*weatherGuardRegistrationEnabled\s*\?\s*handleWeatherGuardRegistrationOpen\s*:\s*undefined\s*\}/u,
    );
    expect(pageText).toMatch(
      /weatherGuardRegistrationEnabled\s*&&\s*\(\s*<WeatherWarningGuardRegistrationDialog/u,
    );

    expect(popoverText).toContain(
      "warningSnapshot?.features?.progressNotificationsEnabled === true",
    );
    expect(popoverText).toContain(
      "warningSnapshot?.features?.registrationEnabled === true",
    );
    expect(popoverText).toMatch(
      /progressNotificationsEnabled[\s\S]*weatherGuardCheckId/u,
    );
    expect(popoverText).toContain('WEATHER_WARNING_CHECKLIST_URL');
    expect(popoverText).toMatch(
      /registrationEnabled[\s\S]*提交戒备登记/u,
    );
  });

  it('restores focus to a connected registration opener while deep links close safely without one', () => {
    const pageText = findFunction(
      readMonthlySchedulePage(),
      'MonthlySchedulePageContent',
    ).getText();
    const popoverText = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningInfoPopover.tsx',
      ),
      'utf8',
    );

    expect(pageText).toMatch(
      /const weatherGuardRegistrationReturnFocusRef\s*=\s*useRef<HTMLElement \| null>\(\s*null,?\s*\)/u,
    );
    expect(pageText).toMatch(
      /const weatherGuardRegistrationFallbackRef\s*=\s*useRef<HTMLElement \| null>\(null\)/u,
    );
    expect(pageText).toContain('returnFocusTarget?: HTMLElement | null');
    expect(pageText).toContain('document.activeElement');
    expect(pageText).toContain('window.requestAnimationFrame');
    expect(pageText).toContain('returnFocusTarget?.isConnected');
    expect(pageText).toContain('weatherGuardRegistrationFallbackRef.current');
    expect(pageText).toContain('focusTarget?.focus({ preventScroll: true })');
    expect(pageText).toContain('ref={weatherGuardRegistrationFallbackRef}');
    expect(pageText).toContain('aria-label="天气预警与戒备区域"');
    expect(popoverText).toContain(
      'const weatherWarningTriggerRef = useRef<HTMLButtonElement | null>(null)',
    );
    expect(popoverText).toContain('cloneElement');
    expect(popoverText).toContain('ref: weatherWarningTriggerRef');
    expect(popoverText).toMatch(
      /onRegisterGuard\(\s*registrationWarningId,\s*weatherWarningTriggerRef\.current,?\s*\)/u,
    );
  });

  it('clears deep-link state before replacing the current URL without dropping path, query, or hash', () => {
    const page = findFunction(
      readMonthlySchedulePage(),
      'MonthlySchedulePageContent',
    );
    const pageText = page.getText();
    const stateClearIndex = pageText.indexOf(
      'setWeatherGuardRegistration(null)',
    );
    const historyIndex = pageText.indexOf('window.history.replaceState');

    expect(stateClearIndex).toBeGreaterThanOrEqual(0);
    expect(historyIndex).toBeGreaterThan(stateClearIndex);
    expect(pageText).toContain(
      'clearWeatherGuardRegistrationDeepLink(currentSearchParams)',
    );
    expect(pageText).toContain('window.location.pathname');
    expect(pageText).toContain('window.location.hash');
    expect(pageText).not.toContain('window.location.reload');
  });

  it('keeps the calendar and weather stacked below 1280px while sharing one bottom edge on desktop', () => {
    const pageText = readMonthlySchedulePage().getFullText();
    const styles = readMonthlyScheduleStyles();
    const warningSummary = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningSnapshotSummary.tsx',
      ),
      'utf8',
    );

    expect(pageText).toContain(
      'grid duty-calendar-weather-grid items-stretch gap-3',
    );
    expect(pageText).not.toContain(
      'grid duty-calendar-weather-grid items-start gap-3',
    );
    expect(pageText).toContain('duty-calendar-panel h-full w-full min-w-0');
    expect(pageText).toContain(
      'flex h-full min-w-0 self-stretch flex-col gap-3',
    );
    expect(warningSummary).toContain(
      'flex min-h-0 flex-1 flex-col overflow-hidden',
    );
    expect(styles).not.toContain(
      '@media (min-width: 1024px) {\n  .duty-calendar-weather-grid',
    );
    expect(styles).toMatch(
      /@media \(min-width: 1280px\) \{\s*\.duty-calendar-weather-grid \{\s*grid-template-columns:/u,
    );
  });

  it('uses a directly wrapped accessible trigger and does not wire popover open to another request', () => {
    const source = readWeatherWarningInfoPopover();
    const popover = findFunction(source, 'WeatherWarningInfoPopover');
    const popoverRoots = findJsxOpenings(popover, 'Popover');
    const popoverTriggers = findJsxElements(popover, 'PopoverTrigger');
    const popoverContents = findJsxOpenings(popover, 'PopoverContent');
    const headingOpenings = findJsxOpenings(popover, 'h2');
    const detailSections = findJsxOpenings(popover, 'section');
    const detailHeadings = findJsxOpenings(popover, 'h3');
    const links = findJsxOpenings(popover, 'a');
    const sourceText = source.getFullText();
    const popoverText = popover.getText();
    const apiImports = getImportModuleSpecifiers(source).filter(
      (moduleSpecifier) =>
        moduleSpecifier === '@/api' ||
        moduleSpecifier.startsWith('@/api/') ||
        ((moduleSpecifier.startsWith('./') ||
          moduleSpecifier.startsWith('../')) &&
          /(^|\/)api(?:$|[./-])/.test(moduleSpecifier)),
    );

    expect(popoverRoots).toHaveLength(1);
    expect(popoverContents).toHaveLength(1);
    expect(hasJsxBooleanAttribute(popoverContents[0], 'forceMount')).toBe(
      false,
    );
    expect(
      getJsxAttributeExpressionText(popoverContents[0], 'aria-labelledby'),
    ).toBe('weatherWarningTitleId');
    expect(
      getJsxAttributeStringText(popoverContents[0], 'className'),
    ).toContain('overflow-x-hidden');
    expect(
      getJsxAttributeStringText(popoverContents[0], 'className'),
    ).toContain('overscroll-contain');
    expect(
      getJsxAttributeStringText(popoverContents[0], 'className'),
    ).toContain('data-[state=open]:!animate-none');
    expect(
      getJsxAttributeStringText(popoverContents[0], 'className'),
    ).toContain('data-[state=closed]:!animate-none');
    expect(
      getJsxAttributeStringText(popoverContents[0], 'className'),
    ).not.toContain('data-[state=closed]:invisible');
    expect(headingOpenings).toHaveLength(1);
    expect(getJsxAttributeExpressionText(headingOpenings[0], 'id')).toBe(
      'weatherWarningTitleId',
    );
    expect(
      detailSections.map((section) =>
        getJsxAttributeExpressionText(section, 'aria-labelledby'),
      ),
    ).toEqual([
      'weatherWarningListId',
      'weatherGuardActionsId',
      'weatherGuardCheckId',
    ]);
    expect(
      detailHeadings.map((heading) =>
        getJsxAttributeExpressionText(heading, 'id'),
      ),
    ).toEqual([
      'weatherWarningListId',
      'weatherGuardActionsId',
      'weatherGuardCheckId',
    ]);
    expect(hasJsxAttribute(popoverRoots[0], 'onOpenChange')).toBe(false);
    expect(popoverTriggers).toHaveLength(1);
    expect(
      hasJsxBooleanAttribute(popoverTriggers[0].openingElement, 'asChild'),
    ).toBe(true);
    const triggerChildren = popoverTriggers[0].children.filter(
      (child) => !(ts.isJsxText(child) && child.text.trim() === ''),
    );
    expect(triggerChildren).toHaveLength(1);
    expect(ts.isJsxExpression(triggerChildren[0])).toBe(true);
    if (!ts.isJsxExpression(triggerChildren[0])) {
      throw new Error(
        'Expected PopoverTrigger to receive the selected button element',
      );
    }
    expect(triggerChildren[0].expression?.getText()).toBe('resolvedTrigger');
    const triggerButtons = findJsxOpenings(popover, 'button');
    expect(triggerButtons).toHaveLength(2);
    const triggerButton = triggerButtons.find(
      (button) => !hasJsxAttribute(button, 'onClick'),
    );
    const registrationButton = triggerButtons.find((button) =>
      hasJsxAttribute(button, 'onClick'),
    );
    expect(triggerButton).toBeDefined();
    expect(registrationButton).toBeDefined();
    if (!triggerButton || !registrationButton) {
      throw new Error(
        'Expected one popover trigger and one registration button',
      );
    }
    expect(getJsxAttributeStringText(triggerButton, 'type')).toBe('button');
    expect(hasJsxAttribute(triggerButton, 'onClick')).toBe(false);
    expect(getJsxAttributeExpressionText(triggerButton, 'aria-label')).toBe(
      'presentation.ariaLabel',
    );

    expect(getJsxAttributeStringText(registrationButton, 'type')).toBe(
      'button',
    );
    expect(getJsxAttributeExpressionText(registrationButton, 'disabled')).toBe(
      '!registrationWarningId || !onRegisterGuard',
    );
    const registrationClick =
      getJsxAttributeExpressionText(registrationButton, 'onClick') ?? '';
    expect(registrationClick).toContain(
      'if (!registrationWarningId || !onRegisterGuard) return',
    );
    expect(registrationClick).toMatch(
      /onRegisterGuard\(\s*registrationWarningId,\s*weatherWarningTriggerRef\.current,?\s*\)/u,
    );

    const expectedHrefExpressions = ['WEATHER_WARNING_CHECKLIST_URL'];
    expect(links).toHaveLength(1);
    expect(
      links.map((link) => getJsxAttributeExpressionText(link, 'href')),
    ).toEqual(expectedHrefExpressions);
    const linkConstants = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/weather-warning-links.ts',
      ),
      'utf8',
    );
    expect(linkConstants).toContain(
      'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
    );
    expect(linkConstants).not.toContain('WEATHER_WARNING_REGISTRATION_URL');
    expect(linkConstants).not.toContain('/share/base/form/');
    for (const link of links) {
      expect(getJsxAttributeStringText(link, 'target')).toBe('_blank');
      expect(getJsxAttributeStringText(link, 'rel')).toBe('noreferrer');
    }

    const presentationCalls = findCallExpressions(
      popover,
      'getWeatherWarningTriggerPresentation',
    );
    expect(presentationCalls).toHaveLength(1);
    const presentationArgument = presentationCalls[0].arguments[0];
    expect(ts.isObjectLiteralExpression(presentationArgument)).toBe(true);
    if (!ts.isObjectLiteralExpression(presentationArgument)) {
      throw new Error('Expected presentation props to use an object literal');
    }
    expect(
      presentationArgument.properties.map((property) => property.getText()),
    ).toEqual([
      'warningSnapshot',
      'warningStatus',
      'warningError',
      'warningFailureKind',
    ]);
    const summaryCalls = findCallExpressions(
      popover,
      'getWeatherWarningSummaryPresentation',
    );
    expect(summaryCalls).toHaveLength(1);
    const summaryArgument = summaryCalls[0].arguments[0];
    expect(ts.isObjectLiteralExpression(summaryArgument)).toBe(true);
    if (!ts.isObjectLiteralExpression(summaryArgument)) {
      throw new Error('Expected summary props to use an object literal');
    }
    expect(
      summaryArgument.properties.map((property) => property.getText()),
    ).toEqual([
      'warningSnapshot',
      'warningStatus',
      'warningError',
      'warningFailureKind',
    ]);
    const returnExpressions = findOwnReturnJsxExpressions(popover);
    expect(returnExpressions).toHaveLength(1);
    for (const propName of ['warningSnapshot', 'warningError']) {
      expect(returnExpressions[0].getText()).toContain(propName);
    }
    expect(returnExpressions[0].getText()).toContain(
      'summary.canRegisterGuard',
    );

    expect(apiImports).toEqual([]);
    expect(popoverText).not.toContain('onOpenChange');
    expect(findCallExpressions(popover, 'useEffect')).toHaveLength(0);
    expect(
      findIdentifierCallNames(popover, (identifier) =>
        /^use[A-Z]/.test(identifier),
      ),
    ).toEqual(['useRef', 'useId']);
    expect(sourceText).not.toContain('getWeatherWarningSnapshot');
    expect(sourceText).not.toContain('refreshWarning');
    expect(sourceText).not.toContain('fetch(');
    expect(sourceText).toContain('[overflow-wrap:anywhere]');
  });

  it('keeps the shared popover on the default Radix mount lifecycle', () => {
    const source = readSharedPopover();
    const sharedContent = findFunction(source, 'PopoverContent');
    const portals = findJsxOpenings(sharedContent, 'PopoverPrimitive.Portal');
    const contents = findJsxOpenings(sharedContent, 'PopoverPrimitive.Content');

    expect(portals).toHaveLength(1);
    expect(contents).toHaveLength(1);
    expect(hasJsxAttribute(portals[0], 'forceMount')).toBe(false);
    expect(hasJsxAttribute(contents[0], 'forceMount')).toBe(false);
  });

  it('uses the dedicated persistent summary while keeping obsolete inline summaries removed', () => {
    const source = readMonthlySchedulePage();

    expect(
      source.statements.some(
        (statement) =>
          ts.isFunctionDeclaration(statement) &&
          statement.name?.text === 'WeatherWarningSnapshotSummary',
      ),
    ).toBe(false);
    expect(
      source.statements.some(
        (statement) =>
          ts.isFunctionDeclaration(statement) &&
          statement.name?.text === 'WeatherWarningSummary',
      ),
    ).toBe(false);
    expect(importsNamedBinding(source, '@/api', 'QWeatherWarning')).toBe(false);
    expect(
      importsNamedBinding(
        source,
        './WeatherWarningSnapshotSummary',
        'WeatherWarningSnapshotSummary',
      ),
    ).toBe(true);
  });
});
