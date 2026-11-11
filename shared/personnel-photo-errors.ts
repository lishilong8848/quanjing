export const PERSONAL_PHOTO_MESSAGES = {
  PHOTO_SOURCE_NOT_READY: '照片来源资料尚未就绪，请刷新个人档案或联系管理员核对',
  PHOTO_SOURCE_DENIED: '照片来源暂未授权，请联系管理员核对',
  PHOTO_SOURCE_MISSING: '源照片已失效，请刷新个人档案后重试',
  PHOTO_SOURCE_TIMEOUT: '照片来源响应超时，请重试',
  PHOTO_INVALID_CONTENT: '个人照片读取失败：图片格式或大小不符合要求',
  PHOTO_SOURCE_CHANGED: '照片资料已变化，请刷新个人档案后重试',
  PHOTO_UNAVAILABLE: '个人照片读取失败，请稍后重试',
} as const;
export type PersonalPhotoErrorCode = keyof typeof PERSONAL_PHOTO_MESSAGES;
