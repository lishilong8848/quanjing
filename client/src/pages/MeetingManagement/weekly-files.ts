export const WEEKLY_FILE_SIZE = 10 * 1024 * 1024;

export function mergeWeeklyFiles(current: File[], incoming: File[]) {
  const next = [...current];
  for (const file of incoming) {
    if (!file.size) throw new Error(`${file.name}：文件为空`);
    if (file.size > WEEKLY_FILE_SIZE)
      throw new Error(`${file.name}：单个附件最多10MB`);
    if (
      !next.some(
        (item) =>
          item.name === file.name &&
          item.size === file.size &&
          item.lastModified === file.lastModified,
      )
    )
      next.push(file);
  }
  return next;
}

export function weeklyImagePreview(file: File) {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
    file.type,
  );
}
