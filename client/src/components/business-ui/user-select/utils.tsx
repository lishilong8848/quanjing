import type { UserInfo, SearchAvatar } from '@lark-apaas/client-toolkit/tools/services';

import type { AccountType } from '@client/src/components/business-ui/api/users/service';
import type {
  User,
  UserSelectValue,
} from '@client/src/components/business-ui/user-select/types';

export function getUserDisplayName(name: UserInfo['name']): string {
  return name.zh_cn || name.en_us || '';
}

export function getUserId(user: UserInfo, accountType: AccountType): string {
  return accountType === 'lark' ? user.larkUserID : user.userID;
}

export function createUnknownUser(id: string): User {
  return {
    id,
    name: '未知用户',
    avatar: undefined,
    raw: undefined,
  };
}

export function userInfoToUser(
  userInfo: UserInfo & SearchAvatar,
  accountType: AccountType,
): User {
  return {
    id: getUserId(userInfo, accountType),
    name: getUserDisplayName(userInfo.name),
    avatar: userInfo.avatar?.image?.large,
    raw: userInfo,
  };
}

export function searchUserInfoToUser(
  userInfo: UserInfo & { avatar?: string },
  accountType: AccountType,
): User {
  return {
    id: getUserId(userInfo, accountType),
    name: getUserDisplayName(userInfo.name),
    avatar: userInfo.avatar,
    raw: userInfo,
  };
}

declare global {
  interface Window {
    MIAODA_APP_ID?: string;
    __platform__?: {
      appId?: string;
    };
    appId?: string;
  }
}

export function getAppId(path: string): string | null | undefined {
  if (window?.__platform__?.appId) {
    return window.__platform__.appId;
  }

  if (window.MIAODA_APP_ID) {
    return window.MIAODA_APP_ID;
  }

  let prefix: string;

  /**
   * 从路径中提取 appId
   * @example "/app/my-app/settings" → "my-app"
   */
  const appMatch = path.match(/\/app\/([^/]+)/);
  if (appMatch) {
    return appMatch[1];
  }

  // 检查路径是否以固定前缀开头
  if (path.includes('/ai/feida/runtime/')) {
    prefix = '/ai/feida/runtime/';
  } else if (path.includes('/spark/r/')) {
    prefix = '/spark/r/';
  } else {
    prefix = '/ai/miaoda/';
  }

  // 兼容全栈appId挂载在window上，作为兜底
  const windowAppId = window.appId || null;

  if (!path.startsWith(prefix)) {
    return windowAppId;
  }

  // 截取前缀后的部分
  const remainder = path.substring(prefix.length);

  // 找到下一个斜杠的位置
  const nextSlashIndex = remainder.indexOf('/');

  // 如果没有斜杠，返回整个remainder；否则返回斜杠前的部分
  if (nextSlashIndex === -1) {
    return remainder || windowAppId;
  }
  return remainder.substring(0, nextSlashIndex) || windowAppId;
}

/**
 * 从 value 中提取 ID 列表
 */
export function extractIdsFromValue(value: UserSelectValue): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [];
    }
    // 检查第一个元素判断类型
    if (typeof value[0] === 'string') {
      return value as string[];
    }
    // User 对象数组
    return (value as User[]).map((u) => u.id);
  }
  // 单个 User 对象
  return [(value as User).id];
}
