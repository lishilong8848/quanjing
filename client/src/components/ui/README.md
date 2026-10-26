# shadcn/ui 组件开发指南

## 核心原则

- 组件位置：`/client/src/components/ui/`
- 图标库：必须使用 `lucide-react`，禁用 Emoj
- 查阅源码实现：直接读取组件源码了解最新组件实现

## 关键组件规范

### 1. Button 颜色规范

```tsx
// ✅ 使用变体或语义化配对
<Button variant="secondary">标准按钮</Button>
<Button className="bg-primary text-primary-foreground">自定义按钮</Button>

// ❌ 避免颜色冲突
<Button className="bg-accent text-accent">不可见</Button>
```

### 2. Badge 自定义颜色

```tsx
// 预定义颜色变体
<Badge color="blue">信息</Badge>
<Badge color="emerald">成功</Badge>
<Badge color="orange">警告</Badge>
<Badge color="red">错误</Badge>
<Badge color="indigo">品牌</Badge>
<Badge color="neutral">中性</Badge>

// 与变体组合
<Badge variant="outline" color="blue">蓝色边框</Badge>
```

### 3. Alert 扩展变体

```tsx
// 新增变体
<Alert variant="success">
  <CheckCircle className="size-4" />
  <AlertTitle>操作成功</AlertTitle>
</Alert>

<Alert variant="warning">
  <AlertTriangle className="size-4" />
  <AlertTitle>注意事项</AlertTitle>
</Alert>
```

### 4. Card Padding 系统

- `CardHeader`: `p-6` (24px 全方向)
- `CardContent`: `p-6 pt-0` (与 header 无缝衔接)
- `CardFooter`: `p-6 pt-0` (与 content 无缝衔接)

### 5. Dialog

Dialog 默认提供了右上角的close能力，同时也提供了自定义关闭按钮的能力，即通过设置showCloseButton为false来关闭默认的关闭按钮。所以当默认存在close时，禁止在内容区域提供自定义的关闭按钮。

### 6. Image

**组件特性：**

- 支持 `<img/>` 标签所有原生属性
- 智能图片优化：自动生成多尺寸图片，支持 WebP 格式降级
- 响应式支持：基于 `sizes` 属性实现自适应图片加载
- 性能优化：默认懒加载、异步解码、背景渐变占位

**使用规范：**

1. **响应式图片场景**：当图片尺寸需要根据视口宽度变化时
   - 必须设置 `sizes` 属性，指定不同视口宽度下应该使用的图片尺寸，组件会自动生成对应的 srcset 实现响应式加载

2. **非响应式图片场景**：当图片有固定尺寸时
   - 必须设置 `width` 属性指定宽度，宽度应该等于图片要展示的宽度，而非图片文件的原始宽度
   - 组件会自动生成 1x 和 2x 两种 srcset 配置的图片

3. **通用要求：**
   - 所有图片必须提供有意义的 `alt` 属性

**代码示例：**

```tsx
// 响应式图片
<Image
  src="/path/to/image.jpg"
  alt="描述文字"
  sizes="(max-width: 768px) 100vw, 50vw"
/>

// 固定尺寸图片
<Image
  src="/path/to/image.jpg"
  alt="描述文字"
  width={300}
  height={200}
/>
```
