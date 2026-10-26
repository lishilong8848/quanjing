import {
  mergeWeeklyFiles,
  weeklyImagePreview,
} from '../../client/src/pages/MeetingManagement/weekly-files';

const file = (name: string, type = 'image/png', size = 40) =>
  ({ name, type, size, lastModified: 1 }) as File;
describe('会议附件本地选择', () => {
  it('累计超过5张并混合文档，连续添加保留既有文件', () => {
    const images = Array.from({ length: 8 }, (_, index) =>
      file(`截图${index}.png`),
    );
    const selected = mergeWeeklyFiles([], images);
    expect(
      mergeWeeklyFiles(selected, [file('会议纪要.pdf', 'application/pdf')]),
    ).toHaveLength(9);
    expect(mergeWeeklyFiles(selected, [images[0]])).toHaveLength(8);
  });
  it('失败不修改原列表，错误指出文件名', () => {
    const current = [file('截图.png')];
    expect(() =>
      mergeWeeklyFiles(current, [
        file('大文件.zip', 'application/zip', 10 * 1024 * 1024 + 1),
      ]),
    ).toThrow('大文件.zip');
    expect(() =>
      mergeWeeklyFiles(current, [file('空文件.txt', 'text/plain', 0)]),
    ).toThrow('文件为空');
    expect(current).toHaveLength(1);
  });
  it('只为支持的位图生成预览，文档和SVG显示文件', () => {
    expect(weeklyImagePreview(file('截图.png'))).toBe(true);
    expect(weeklyImagePreview(file('图.svg', 'image/svg+xml'))).toBe(false);
    expect(weeklyImagePreview(file('纪要.pdf', 'application/pdf'))).toBe(false);
  });
});
