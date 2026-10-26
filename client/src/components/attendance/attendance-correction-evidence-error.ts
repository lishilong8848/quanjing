interface HttpErrorLike {
  response?: {
    status?: unknown;
  };
}

export function getAttendanceCorrectionEvidenceErrorMessage(
  error: unknown,
): string {
  const status =
    typeof error === 'object' && error !== null
      ? Number((error as HttpErrorLike).response?.status)
      : Number.NaN;
  if (status === 401) return '请先使用飞书授权登录后查看举证图片';
  if (status === 403) return '当前账号无权查看补卡举证';
  if (status === 404) return '未找到对应的补卡举证记录';
  return '举证图片暂时无法读取';
}
