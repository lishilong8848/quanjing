import {
  UserService,
  type SearchUsersParams,
  type SearchUsersResponse,
  type BatchGetUsersResponse,
} from '@lark-apaas/client-toolkit/tools/services';

export type AccountType = 'apaas' | 'lark';

const userService = new UserService();

/**
 * 搜索用户
 */
export async function searchUsers(
  params: SearchUsersParams,
): Promise<SearchUsersResponse> {
  return userService.searchUsers(params);
}

/**
 * 批量根据用户 ID 查询用户信息
 */
export async function listUsersByIds(
  userIds: string[],
): Promise<BatchGetUsersResponse> {
  return userService.listUsersByIds(userIds);
}

export type { SearchUsersParams, SearchUsersResponse, BatchGetUsersResponse };
