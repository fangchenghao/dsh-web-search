# 让 DSH 插件的配置出现在「设置」里：四层判定链

> 结论先行：一个插件配置项要能在 Settings 里编辑，需要**同时**满足四层条件。
> 任何一层不满足，症状都完全一样——**设置页空白**。这就是它难 debug 的原因。
> 本文的 file:line 均来自 `DeepSeek Harness.app/Contents/Resources/app.asar`（2026-10 版本）。

## 症状

设置页显示插件标题和描述，但下面没有控件；或显示「当前部署尚未提供此插件的设置」。
插件本身加载正常（工具能用），日志里可能有一行 `warning: 1 entry did not activate`。

## 四层判定链

### 第 1 层：插件必须真正激活（`fiber.state === 2`）

`@deepseek-ai/dsh-settings/lib/index.js` 的 `describe()` 开头：

```js
const schema = this.schema(entry);
if (schema === undefined || entry.fiber === undefined
    || entry.fiber.runtime === null || entry.fiber.state !== 2) return [];
```

而 `schema(entry)` 是：

```js
schema(entry) {
  const schema = entry.fiber?.runtime?.Config;
  return schema !== undefined && 'toJSON' in schema ? schema : undefined;
}
```

**要点：schema 挂在「运行时对象」上，不是模块命名空间上。**

Loader 的 `unwrapExports`（`cordis-plugin-loader/lib/index.js:669`）：

```js
exports = exports.default ?? exports;
```

| 插件导出写法 | 结果 |
|---|---|
| `export function apply` + `export { Config }`（无 default） | ✅ `plugin` = 命名空间，`plugin.Config` 命中 |
| `export default Object.assign(apply, { Config, inject })` | ✅ `plugin` = default，`Config` 命中 |
| `export default apply` 再另写 `export const Config` | ❌ default 存在 → 命名空间被丢弃 → `runtime.Config` 为 undefined |

**函数式插件若用 default 导出，必须把 `Config` 和 `inject` 一起挂上去**；只挂 `Config` 会得到
`Error: cannot get property "web" without inject`——Cordis 从它挂载的那个对象读 `inject`。

### 第 2 层：配置校验必须通过

Loader 只校验一次，校验的是 **`entry.options.config`（patch 里的原始值）**：

```js
// cordis/lib/index.js:1355 → :1345 → :956
const result = runtime.Config['~standard'].validate(config);
if (result.issues) throw new ValidationError(result.issues);
return result.value;
```

**校验后的 `result.value` 里，每个 volatile 字段都是 `{ get }` 持有器，不是值。**

最容易踩的坑：**别把已经解析过的 config 再喂回 schema**。

```ts
// ❌ 在 apply 内部这样写，必炸
const settings = Config(config as PluginConfig);
// ValidationError: $.timeoutMs expected number but got [object Object]
```

这条错误消息**没有** `invalid config:` 前缀，说明它是 schemastery 抛的（你自己的代码），
却被 Host 报成「entry did not activate」，极易误判成插件加载失败。

正确做法：先解包再校验，或干脆只在校验时用 plain 值、输出时优先用调用方的持有器。

### 第 3 层：至少一个字段带 `meta.volatile`

`lib/types/schema.js:43`：

```js
export function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema);
  if (schema.type === 'object') {
    // 只保留 volatileForm !== undefined 的子字段
    return Object.keys(dict).length === 0 ? undefined : z.object(dict);
  }
  return undefined;
}
```

`describe()` 里 `if (form === undefined) return [];`——**一个 volatile 字段都没有，整个命名空间被丢弃**。

### 第 4 层：消费方必须 `.get()`

一旦标了 `.volatile()`，schema 解析结果是 `{ get: fn }`：

```js
z.object({ timeoutMs: z.number().default(15000).volatile() })({})
// → { timeoutMs: { get: [Function], [Symbol(cosmokit.volatile.write)]: [Function] } }
//   .get() === 15000
```

所以读取处必须解包：

```ts
const read = (v: unknown) => {
  const holder = v as { get?: unknown } | null;
  return typeof holder?.get === 'function' ? (holder.get as () => unknown)() : v;
};
```

数组也一样——`{}` 只是持有器的 **JSON 形态**（`get` 是函数、writer 是 symbol）。不标数组反而会让
设置页保存时报 `Config field "hosts" is not volatile`（`dsh-settings/lib/types/index.js:351`）。

## 最小 checklist（新插件抄这个）

```ts
export const Config = z.object({
  someScalar: z.string().default('').description('…').volatile(),   // 标量标 volatile
  someArray: z.array(z.string()).default([]).description('…').volatile(), // 数组也标
});

export function apply(ctx, config) {
  // config 里已是持有器：读的时候必须 .get()
  const value = config.someScalar.get();
}

export default Object.assign(apply, { Config, inject });   // Config + inject 一起挂
```

保存/生效语义：**只有 volatile 字段变化**才走 live commit（原地改持有器、不重挂载，
`cordis-plugin-loader/lib/index.js:382-435`）；其他字段变化会整个插件重挂载。因此
如果插件在 `apply` 里缓存了配置快照，volatile 的实时改动对缓存那份不生效——要么每次调用重读，
要么接受「需重挂载」。

## 诊断顺序（不要跳步）

1. **先确认插件激活**：看有没有 `did not activate`，有就先修激活，别动设置页；
2. **确认 `runtime.Config` 存在**：`describe()` 第一行就依赖它；
3. **确认 patch 校验通过**：注意报错有没有 `invalid config:` 前缀，没有就是你自己代码抛的；
4. **确认命名空间被收录**：字段有没有 `meta.volatile`；
5. **确认客户端读的是正确的 ns 名**：`entry.options.id`（通常等于 patch 里的 `id`）；
6. 最后才怀疑客户端渲染。

## 这次踩过的四个误判（供警惕）

| 当时的判断 | 为什么看起来合理 | 实际 |
|---|---|---|
| 「客户端没 inject `configForms`」 | 页面确实什么都没渲染 | 真实存在但非根因 |
| 「表单是异步投影，读太早」 | 加订阅后报错消失 | 真实存在但非根因 |
| 「字段缺 `.volatile()`」 | 官方插件都有这个标记 | 真实存在但非根因 |
| 「要重装/换安装方式」 | 别的插件能显示，我们是手装的 | 无关 |

**根因是第 2 层**：`apply` 内部二次校验已解析的 config，抛在 plugin 内 → 表现为「未激活」。
四层都修对之后页面才出来——所以每次只修一层，症状看起来完全没变。

**教训：先定位「命名空间有没有被 Host 收录」，再改客户端。** 客户端加一行诊断
（把 `settings.describe()` 返回的 ns 列表打印出来）能在 10 分钟内省掉上面四个误判。
