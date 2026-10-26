import type {
  BaseEntitySelectProps,
  ItemValue,
} from '@client/src/components/business-ui/entity-combobox/shared-types';
import type { I18nText } from '@client/src/components/business-ui/entity-combobox/types';

export type Department = {
  departmentID: string;
  name: I18nText;
};

export type UserInfo = {
  userID: string;
  larkUserID: string;
  name: I18nText;
  avatar: string;
  userType: '_employee' | '_externalUser' | '_anonymousUser';
  department: Department;
};

export type AccountType = 'apaas' | 'lark';

/**
 * 值类型
 * - 'string': value 为 string 或 string[]（与 multiple 联动）
 * - 'object': value 为 User 或 User[]（与 multiple 联动）
 * @default 'string'
 */
export type ValueType = 'string' | 'object';

export type SearchAvatar = {
  avatar: {
    image: {
      large: string;
    };
  };
};

export type User = ItemValue<UserInfo>;

/**
 * 根据 valueType 和 multiple 推断 value 类型
 */
export type InferValue<
  V extends ValueType,
  M extends boolean,
> = V extends 'string'
  ? M extends true
    ? string[]
    : string | null
  : M extends true
    ? User[]
    : User | null;

type UserSelectBaseProps<
  V extends ValueType = 'string',
  M extends boolean = false,
> = Omit<BaseEntitySelectProps<User>, 'value' | 'defaultValue' | 'onChange'> & {
  /**
   * 值类型
   * - 'string': value 为 string 或 string[]（与 multiple 联动）
   * - 'object': value 为 User 或 User[]（与 multiple 联动）
   * @default 'string'
   */
  valueType?: V;
  /**
   * 是否多选
   * @default false
   */
  multiple?: M;
  /**
   * 账户类型，决定 value 中 id 字段的来源
   * - 'apaas' (默认): 使用 userID
   * - 'lark': 使用 larkUserID
   */
  accountType?: AccountType;
  /**
   * 当前值
   */
  value?: InferValue<V, M>;
  /**
   * 默认值
   */
  defaultValue?: InferValue<V, M>;
  /**
   * 值变化回调
   */
  onChange?: (value: InferValue<V, M>) => void;
};

/**
 * UserSelect 组件 Props
 *
 * 类型组合：
 * | valueType | multiple | value 类型 |
 * |-----------|----------|------------|
 * | 'string'  | false    | string | null |
 * | 'string'  | true     | string[] |
 * | 'object'  | false    | User | null |
 * | 'object'  | true     | User[] |
 */
export type UserSelectProps =
  | UserSelectBaseProps<'string', false>
  | UserSelectBaseProps<'string', true>
  | UserSelectBaseProps<'object', false>
  | UserSelectBaseProps<'object', true>;

export type UserSelectValue = User | User[] | string | string[] | null;
