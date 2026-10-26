export interface UserWithAvatarProps {
  /**
   * 用户数据，可以只传 user_id，组件会自动查询 name 和 avatar
   */
  data: IUserProfile;
  /**
   * @default medium
   */
  size?: 'small' | 'medium' | 'large';
  /**
   * @default tag
   */
  mode?: 'tag' | 'plain';
  className?: string;
  /**
   * @default true
   */
  showLabel?: boolean;
  /**
   * 账户类型，用于查询用户信息时确定使用哪个 ID
   * @default 'apaas'
   */
  accountType?: 'apaas' | 'lark';
}

export type IUserProfile = {
  user_id: string;
  /** 用户名称，可选，不传则自动查询 */
  name?: string;
  /** 用户头像，可选，不传则自动查询 */
  avatar?: string;
};
