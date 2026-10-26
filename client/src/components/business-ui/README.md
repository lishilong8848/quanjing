# 用户与部门组件文档

本文档包含用户选择、部门选择、用户展示等业务组件的使用说明。

---

## 目录

- [UserSelect 用户选择组件](#userselect-用户选择组件)
- [DepartmentSelect 部门选择组件](#departmentselect-部门选择组件)
- [UserDisplay 用户展示组件](#userdisplay-用户展示组件)
- [UserProfile 用户详情组件](#userprofile-用户详情组件)

---

## UserSelect 用户选择组件

**组件路径**：`@/components/business-ui/user-select`

### 功能概述

- 用户字段选择组件，用于表单中录入"人员"字段
- 通过触发器打开弹层，弹层内置搜索功能（始终可用）
- 仅支持 **ID 模式**：`value/onChange` 只使用用户 `id`（string）
- 组件在 UI 上可展示用户信息（头像/名称），但对外值仅返回/接收 `id`
- 组件自带用户检索能力，无需额外传搜索接口/数据源

### 类型定义

```typescript
/** 用户数据结构（仅用于 getOptionDisabled 回调入参） */
interface User {
  /** 用户 ID */
  id: string;
  /** 用户名称 */
  name?: string;
  /** 头像地址 */
  avatar?: string;
}

/** 触发器类型 */
type TriggerType = 'button' | 'search' | 'custom';

/** 单选模式 Props */
interface UserSelectSingleProps {
  /** 当前选中的用户 ID，空值为 null */
  value: string | null;
  /** 选中变化回调 */
  onChange: (value: string | null) => void;
  /** 是否多选，单选时为 false 或不传 */
  multiple?: false;
  /** 触发器类型，仅影响样式，不影响搜索功能 */
  triggerType?: TriggerType;
  /** 是否禁用 */
  disabled?: boolean;
  /** 占位文本 */
  placeholder?: string;
  /** 判断选项是否禁用，返回 true 时该选项仍展示但不可选（若已选中仍可回显） */
  getOptionDisabled?: (user: User) => boolean;
}

/** 多选模式 Props */
interface UserSelectMultipleProps {
  /** 当前选中的用户 ID 列表，空值为 [] */
  value: string[];
  /** 选中变化回调 */
  onChange: (value: string[]) => void;
  /** 是否多选，多选时为 true */
  multiple: true;
  /** 触发器类型 */
  triggerType?: TriggerType;
  /** 是否禁用 */
  disabled?: boolean;
  /** 占位文本 */
  placeholder?: string;
  /** 判断选项是否禁用 */
  getOptionDisabled?: (user: User) => boolean;
}

type UserSelectProps = UserSelectSingleProps | UserSelectMultipleProps;
```

### Props 说明

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `value` | `string \| null` / `string[]` | - | **必填**。单选传 `string \| null`（用户 ID），多选传 `string[]` |
| `onChange` | `function` | - | **必填**。值变化回调，返回值形态与 `value` 匹配 |
| `multiple` | `boolean` | `false` | 是否多选 |
| `triggerType` | `'button' \| 'search' \| 'custom'` | `'button'` | 触发器类型，仅影响样式 |
| `disabled` | `boolean` | `false` | 是否禁用 |
| `placeholder` | `string` | `'请选择'` | 占位文本 |
| `getOptionDisabled` | `(user: User) => boolean` | - | 判断选项是否禁用，入参包含 `id`、`name`、`avatar` |

### 受控规范

> ⚠️ **强约束**

1. **必须受控**：始终传 `value` + `onChange`
2. **禁止传**：`undefined` / `User` 对象 / 其他类型
3. **空值规则**：
   - 单选清空：`null`
   - 多选清空：`[]`

### 使用示例

```tsx
import { useState } from 'react';
import { UserSelect } from '@/components/business-ui/user-select';

// 单选
function SingleSelectExample() {
  const [userId, setUserId] = useState<string | null>(null);

  return (
    <UserSelect
      value={userId}
      onChange={setUserId}
      placeholder="请选择用户"
    />
  );
}

// 多选
function MultipleSelectExample() {
  const [userIds, setUserIds] = useState<string[]>([]);

  return (
    <UserSelect
      multiple
      value={userIds}
      onChange={setUserIds}
      placeholder="请选择用户"
      getOptionDisabled={(user) => user.id === 'disabled-id'}
    />
  );
}
```

---

## DepartmentSelect 部门选择组件

**组件路径**：`@/components/business-ui/department-select`

### 功能概述

- 部门字段选择组件，用于表单中录入"部门/组织"字段
- 通过触发器打开弹层，弹层内置搜索功能（始终可用）
- 仅支持**对象模式**（不支持传 ID/string）
- 选择后自动回显已选部门信息：部门名称（多选以 tag 形式展示）
- 组件自带部门检索能力，无需额外传搜索接口/数据源

### 类型定义

```typescript
/** 部门数据结构 */
interface Department {
  /** 唯一标识：用于 key/去重/选中判断，内部对应 departmentID */
  id: string;
  /** 展示名称：内部优先 zh_cn，其次 en_us */
  name: string;
}

/** 触发器类型 */
type TriggerType = 'button' | 'search' | 'custom';

/** 单选模式 Props */
interface DepartmentSelectSingleProps {
  /** 当前选中的部门 */
  value: Department | null;
  /** 选中变化回调 */
  onChange: (value: Department | null) => void;
  /** 是否多选，单选时为 false 或不传 */
  multiple?: false;
  /** 触发器类型，仅影响样式，不影响搜索功能 */
  triggerType?: TriggerType;
  /** 是否禁用 */
  disabled?: boolean;
  /** 占位文本 */
  placeholder?: string;
  /** 判断选项是否禁用 */
  getOptionDisabled?: (department: Department) => boolean;
}

/** 多选模式 Props */
interface DepartmentSelectMultipleProps {
  /** 当前选中的部门列表 */
  value: Department[];
  /** 选中变化回调 */
  onChange: (value: Department[]) => void;
  /** 是否多选，多选时为 true */
  multiple: true;
  /** 触发器类型 */
  triggerType?: TriggerType;
  /** 是否禁用 */
  disabled?: boolean;
  /** 占位文本 */
  placeholder?: string;
  /** 判断选项是否禁用 */
  getOptionDisabled?: (department: Department) => boolean;
}

type DepartmentSelectProps = DepartmentSelectSingleProps | DepartmentSelectMultipleProps;
```

### Props 说明

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `value` | `Department \| null` / `Department[]` | - | **必填**。单选传 `Department \| null`，多选传 `Department[]` |
| `onChange` | `function` | - | **必填**。值变化回调，返回值形态与 `value` 匹配 |
| `multiple` | `boolean` | `false` | 是否多选 |
| `triggerType` | `'button' \| 'search' \| 'custom'` | `'button'` | 触发器类型，仅影响样式 |
| `disabled` | `boolean` | `false` | 是否禁用 |
| `placeholder` | `string` | `'请选择部门'` | 占位文本 |
| `getOptionDisabled` | `(department: Department) => boolean` | - | 判断选项是否禁用，被禁用的已选项 tag 不显示删除按钮 |

### 受控规范

> ⚠️ **强约束**

1. **必须受控**：始终传 `value` + `onChange`
2. **禁止传**：`undefined` / `string` / `string[]`
3. **空值规则**：
   - 单选清空：`null`
   - 多选清空：`[]`

### 使用示例

```tsx
import { useState } from 'react';
import { DepartmentSelect, type Department } from '@/components/business-ui/department-select';

// 单选
function SingleSelectExample() {
  const [department, setDepartment] = useState<Department | null>(null);

  return (
    <DepartmentSelect
      value={department}
      onChange={setDepartment}
      placeholder="请选择部门"
    />
  );
}

// 多选
function MultipleSelectExample() {
  const [departments, setDepartments] = useState<Department[]>([]);

  return (
    <DepartmentSelect
      multiple
      value={departments}
      onChange={setDepartments}
      placeholder="请选择部门"
    />
  );
}
```

---

## UserDisplay 用户展示组件

**组件路径**：`@/components/business-ui/user-display`

### 功能概述

- 用于所有用户信息的展示场景
- 显示用户**头像**和**姓名**
- 支持单用户和多用户展示
- 点击用户会弹出 `UserProfile` 卡片
- 当没有用户的name和avatar时，只要确保传递了user_id即可，用户即可正常展示

> ⚠️ **注意**：当不传递 `showLabel` 时，组件会同时展示用户头像和姓名。如果只需要头像，需要传递 `showLabel={false}`

### 类型定义

```typescript
/** 用户信息结构 */
interface IUserProfile {
  /** 用户 ID */
  user_id: string;
  /** 用户姓名 */
  name?: string;
  /** 头像地址 */
  avatar?: string;
}

/** 头像尺寸 */
type AvatarSize = 'small' | 'medium' | 'large';

/** UserDisplay Props */
interface IUserDisplayProps {
  /** 用户信息数组（必填） */
  users: IUserProfile[];
  /** 头像尺寸 */
  size?: AvatarSize;
  /** 自定义样式类名 */
  className?: string;
  /** 自定义内联样式 */
  style?: React.CSSProperties;
  /** 是否显示用户姓名，默认 true。设为 false 则只展示头像 */
  showLabel?: boolean;
}
```

### Props 说明

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `users` | `IUserProfile[]` | - | **必填**。用户信息数组 |
| `size` | `'small' \| 'medium' \| 'large'` | `'medium'` | 头像尺寸 |
| `className` | `string` | - | 自定义样式类名 |
| `style` | `React.CSSProperties` | - | 自定义内联样式 |
| `showLabel` | `boolean` | `true` | 是否显示用户姓名，设为 `false` 只展示头像 |

### 使用示例

```tsx
import { UserDisplay, type IUserProfile } from '@/components/business-ui/user-display';

// 单个用户展示
function SingleUserExample() {
  const users: IUserProfile[] = [
    { user_id: '123' },
  ];

  return (
    <UserDisplay
      users={users}
      size="small"
    />
  );
}

// 多用户展示
function MultipleUsersExample() {
  const users: IUserProfile[] = [
    { user_id: '1' },
    { user_id: '2' },
  ];

  return (
    <UserDisplay
      users={users}
      size="medium"
      className="project-members"
    />
  );
}

// 仅展示头像
function AvatarOnlyExample() {
  const users: IUserProfile[] = [
    { user_id: '1' },
  ];

  return (
    <UserDisplay
      users={users}
      showLabel={false}
    />
  );
}
```

### 最佳实践

- 根据展示场景选择合适的组件尺寸
- 对于用户信息 `userId`，**禁止直接展示文本**，总是使用 `UserDisplay` 组件展示
- 对于需要显示完整用户详情的场景，使用 `UserProfile` 组件

---

## UserProfile 用户详情组件

**组件路径**：`@/components/business-ui/user-profile/user-profile`

### 功能概述

- 用于显示用户详细信息卡片
- 支持两种显示模式：简单信息卡片和飞书官方用户卡片
- 自动处理用户状态和类型标识
- 提供邮箱链接功能
- 支持错误重试机制

### 类型定义

```typescript
/** UserProfile Props */
interface UserProfileProps {
  /** 用户 ID */
  userId?: string;
}
```

### Props 说明

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `userId` | `string` | - | 用户 ID |

### 使用示例

```tsx
import { UserProfile } from '@/components/business-ui/user-profile/user-profile';

// 基础用法
function BasicExample() {
  return <UserProfile userId="user-123" />;
}
```
