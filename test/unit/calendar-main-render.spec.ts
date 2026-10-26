import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

function memoDeclaration() {
  const source = readFileSync(resolve(__dirname, '../../client/src/pages/MonthlySchedule/index.tsx'), 'utf8');
  const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'mainScheduleCalendar') declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(declaration).toBeDefined();
  return { ast, declaration: declaration! };
}

describe('main schedule calendar render boundary', () => {
  it('memoizes only the main Calendar element rather than the dialog', () => {
    const { ast, declaration } = memoDeclaration();
    const initializer = declaration.initializer as ts.CallExpression;
    expect(initializer.expression.getText(ast)).toBe('useMemo');
    expect(initializer.arguments[0].getText(ast)).toContain('<Calendar');
    expect(initializer.arguments[0].getText(ast)).not.toContain('<Dialog');
  });

  it('invalidates for every date, data, callback and day-marker input', () => {
    const { ast, declaration } = memoDeclaration();
    const initializer = declaration.initializer as ts.CallExpression;
    const dependencies = initializer.arguments[1] as ts.ArrayLiteralExpression;
    expect(dependencies.elements.map(node => node.getText(ast))).toEqual(expect.arrayContaining([
      'selectedDate', 'handleDateClick', 'StatusCalendarDayButtonWithChanges',
      'getCalendarChangeInfoByDate', 'getSealingInfoByDate', 'setCalendarFollowUpMonth', 'calendarTodayKey',
      'workCalendarRevision',
    ]));
  });

  it('reuses the element in the main panel while keeping its month key and Root', () => {
    const { ast, declaration } = memoDeclaration();
    const initializer = declaration.initializer as ts.CallExpression;
    const body = initializer.arguments[0].getText(ast);
    expect(body).toContain('Root: StableScheduleCalendarRoot');
    expect(body).toContain('selectedDate.getFullYear()');
    expect(body).toContain('selectedDate.getMonth()');
    expect(ast.text).toContain('{mainScheduleCalendar}');
  });
});
