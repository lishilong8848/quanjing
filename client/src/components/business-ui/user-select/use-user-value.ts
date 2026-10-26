'use client';

import { useCallback, useMemo } from 'react';

import { useUsersByIds } from '@client/src/components/business-ui/api/users/queries';
import type {
  AccountType,
  User,
  UserSelectValue,
  ValueType,
} from '@client/src/components/business-ui/user-select/types';
import {
  extractIdsFromValue,
  userInfoToUser,
  createUnknownUser,
} from '@client/src/components/business-ui/user-select/utils';

export type UseUserValueResult = {
  /**
   * 标准化后的内部 value（User 对象格式）
   * 用于传递给 BaseCombobox
   */
  internalValue: User | User[] | null;

  /**
   * 是否正在加载用户信息
   */
  isLoading: boolean;

  /**
   * 将内部 User 对象转换回外部格式
   * ID 模式时返回字符串，对象模式时返回 User
   */
  toExternalValue: (
    internalVal: User | User[] | null,
    multiple: boolean,
  ) => UserSelectValue;
};

/**
 * 处理 UserSelect 的 value 类型转换
 *
 * - 根据 valueType 决定 value 是 ID 字符串还是 User 对象
 * - ID 模式下调用 API 获取完整用户信息（使用 react-query 缓存）
 * - 无效 ID 生成 "未知用户" 占位
 *
 * @param value - 外部传入的 value
 * @param multiple - 是否多选模式
 * @param accountType - 账户类型
 * @param valueType - 值类型，'string' 表示 ID 模式，'object' 表示 User 对象模式
 */
export function useUserValue(
  value: UserSelectValue,
  multiple: boolean = false,
  accountType: AccountType = 'apaas',
  valueType: ValueType = 'string',
): UseUserValueResult {
  const isIdMode = valueType === 'string';

  // 提取当前 value 中的所有 ID
  const currentIds = useMemo(() => extractIdsFromValue(value), [value]);

  // ID 模式下需要获取的 ID 列表（去重和排序，确保相同的 ID 集合有相同的 queryKey）
  const idsToFetch = useMemo(() => {
    if (!isIdMode) return [];
    return [...new Set(currentIds.map(String))].filter(Boolean).sort();
  }, [isIdMode, currentIds]);

  // 使用 react-query hook 获取用户信息
  const { data: response, isLoading } = useUsersByIds(idsToFetch, accountType);

  // 构建 ID -> User 的映射
  const usersMap = useMemo(() => {
    const map = new Map<string, User>();
    const userInfoMap = response?.data?.userInfoMap || {};

    for (const id of idsToFetch) {
      const userInfo = userInfoMap[id];
      const user = userInfo
        ? userInfoToUser(userInfo, accountType)
        : createUnknownUser(id);
      map.set(String(id), user);
    }
    return map;
  }, [response, idsToFetch, accountType]);

  const internalValue = useMemo((): User | User[] | null => {
    if (value === null || value === undefined) {
      return multiple ? [] : null;
    }

    if (Array.isArray(value) && value.length === 0) {
      return [];
    }

    if (!isIdMode) {
      return value as User | User[];
    }

    const users = currentIds
      .map((id) => usersMap.get(String(id)))
      .filter((u): u is User => u !== undefined);

    if (multiple) {
      return users;
    }

    return users[0] ?? null;
  }, [value, isIdMode, currentIds, usersMap, multiple]);

  const toExternalValue = useCallback(
    (
      internalVal: User | User[] | null,
      isMultiple: boolean,
    ): UserSelectValue => {
      if (internalVal === null) {
        return null;
      }

      if (isIdMode) {
        if (isMultiple) {
          return (internalVal as User[]).map((u) => String(u.id));
        }
        return String((internalVal as User).id);
      }

      return internalVal;
    },
    [isIdMode],
  );

  return {
    internalValue,
    isLoading,
    toExternalValue,
  };
}
