# 豆仓库备份文件格式（Inventory File Format）

本文档定义海星图豆（StarPicDots）豆仓库导出文件的格式，供本应用、未来的账户系统以及第三方工具共同遵循。

- 当前版本：`formatVersion: 1`
- 文件扩展名约定：`.json`，MIME `application/json`
- 实现位置：`src/core/inventory.js`（`serializeInventoryFile` / `parseInventoryFile`）

## format v1：信封（envelope）

导出的 JSON 是一个带元信息的信封对象，字段如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 恒为 `"starpicdots-inventory"`，格式判别字段 |
| `formatVersion` | number | 恒为 `1`；未来格式变更时递增，驱动迁移 |
| `exportedAt` | string | 导出时间，ISO 8601（如 `2026-09-27T08:30:00.000Z`） |
| `app.name` | string | 恒为 `"StarPicDots"` |
| `app.version` | string | 导出的应用版本（如 `"1.0.0"`），可为空字符串 |
| `owner` | string \| null | **保留字段**，为未来账户 id 预留；当前导出恒为 `null` |
| `inventories` | object | 多仓库数据本体，形状与历史裸 store 完全一致（见下） |

`inventories` 的形状：

```json
{
  "activeId": "inv-1",
  "items": [
    { "id": "inv-1", "name": "默认仓库", "providerId": "mard221", "codes": ["H2", "H7"] }
  ]
}
```

- `activeId`：激活仓库的 id；空列表时为 `null`。
- `items[].id`：仓库 id，非空字符串，全局唯一。
- `items[].name`：仓库名，非空字符串。
- `items[].providerId`：色卡 provider（当前为 `"mard221"`）。
- `items[].codes`：色号字符串数组（如 `"H2"`、`"A1"`），去重、保序，**绝不依赖数组位置语义**。

### 完整示例

```json
{
  "type": "starpicdots-inventory",
  "formatVersion": 1,
  "exportedAt": "2026-09-27T08:30:00.000Z",
  "app": { "name": "StarPicDots", "version": "1.0.0" },
  "owner": null,
  "inventories": {
    "activeId": "inv-1",
    "items": [
      { "id": "inv-1", "name": "默认仓库", "providerId": "mard221", "codes": ["H2", "H7", "A1"] }
    ]
  }
}
```

## 历史格式（legacy raw store）

早期版本导出的是**裸 store**，即没有信封的 `inventories` 本体：

```json
{ "activeId": "inv-1", "items": [ { "id": "inv-1", "name": "默认仓库", "providerId": "mard221", "codes": ["H2"] } ] }
```

判别方式：顶层对象**不含** `type` 与 `formatVersion` 字段。

## 兼容规则（导入方必须遵守）

1. **必须同时接受两种格式**：含 `type`/`formatVersion` 判别字段的按信封处理；不含的按历史裸 store 处理。
2. 信封处理：`type` 必须等于 `"starpicdots-inventory"`；`formatVersion` 必须等于当前支持的版本；`inventories` 必须存在且为对象。任一不满足即拒绝。
3. **`formatVersion` 大于当前版本时必须拒绝**并向用户报告“文件无效或版本不受支持”，不得猜测解析。未来版本的应用读取旧文件时按版本号逐级迁移。
4. **未知的顶层字段必须忽略**（包括 `owner`、`exportedAt`、`app` 等元信息），不得因此拒绝文件。
5. 色号过滤：条目中的色号按对应 provider 的合法色号表过滤，未知色号静默丢弃；畸形仓库条目静默丢弃或修复，不得抛异常中断导入。

## 未来账户系统接入

- 服务端接受**同一份文件**的上传：校验 `type` 与 `formatVersion` 后解析 `inventories`，与客户端规则一致。
- 上传后把文件绑定到登录账户；`owner` 字段即为此预留（账户 id）。当前客户端恒导出 `null`，服务端落库时自行填充。
- 账户体系的每一次格式演进都通过递增 `formatVersion` 表达：服务端按版本号做迁移链（v1 → v2 → …），旧客户端读到更高版本时按规则 3 拒绝并提示升级。
- 多设备同步可直接以 `inventories` 本体做合并或整包替换；`exportedAt` 可用于“最新 wins”的粗粒度冲突裁决。
