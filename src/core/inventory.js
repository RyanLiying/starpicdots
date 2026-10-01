/**
 * 豆仓库（库存）核心逻辑：用户标记自己拥有的色号，后续转换只使用已拥有的颜色。
 *
 * 纯逻辑模块：不触碰 DOM 与 localStorage，所有持久化都通过注入的
 * storage 参数完成（接口与 localStorage 兼容）。JSON 永远只存色号字符串
 * （如 'A1'、'H2'），绝不依赖数组位置；色板对象的 index 永不重排。
 */

import { DEFAULT_PALETTE_PROVIDER_ID, PALETTE_PROVIDERS } from '../palettes/catalog.js';

export const INVENTORY_STORAGE_KEY = 'bead-grid-studio:inventory:v1';

// 多仓库（v2）存储键：与 v1 单仓库键并存，互不影响。
export const INVENTORIES_STORAGE_KEY = 'bead-grid-studio:inventories:v2';

// 归一化失败时的兜底仓库名（调用方通常通过 legacyDefaultName / name 提供）。
const DEFAULT_INVENTORY_NAME = '未命名库存';

// 归一化：只保留非空字符串色号，去重并保持原有顺序。接受数组或任意可迭代对象（如 Set）。
function normalizeCodes(codes) {
  if (!codes || typeof codes[Symbol.iterator] !== 'function') return [];
  const seen = new Set();
  const result = [];
  for (const code of codes) {
    if (typeof code !== 'string' || !code || seen.has(code)) continue;
    seen.add(code);
    result.push(code);
  }
  return result;
}

function toCodeSet(codeSet) {
  return codeSet instanceof Set ? codeSet : new Set(normalizeCodes(codeSet));
}

export function validCodesFor(providerId) {
  const provider = PALETTE_PROVIDERS[providerId];
  return provider ? new Set(provider.colors.map((color) => color.code)) : null;
}

// 参与自动转换的判定：优先用 provider.autoMatchable（全色板会排除特效色 Q/Y/ZG 与透明色），
// 未提供 provider 时退化为仅排除透明豆（与 getAllowedPalette 的旧规则一致）。
function matchRule(provider) {
  return typeof provider?.autoMatchable === 'function'
    ? provider.autoMatchable
    : (color) => !color.isTransparent;
}

// 相对亮度（Rec.709 luma），用于近似判断“近白 / 近黑”锚点色。
function hexLuma(hex) {
  const match = typeof hex === 'string' ? /^#([0-9a-f]{6})$/i.exec(hex) : null;
  if (!match) return 0.5;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const NEAR_WHITE_LUMA = 0.93;
const NEAR_BLACK_LUMA = 0.06;

export function filterPaletteByInventory(palette, codeSet, provider) {
  // 与 getAllowedPalette 同一规则：不参与自动匹配的颜色（透明豆、特效色）即使用户标记了也不用。
  const owned = toCodeSet(codeSet);
  const matchable = matchRule(provider);
  return palette.filter((color) => matchable(color) && owned.has(color.code));
}

export function getEffectivePalette(palette, codeSet, provider) {
  // codeSet 为 null/undefined 表示库存功能未启用：返回完整可自动匹配色板（同 getAllowedPalette）。
  if (codeSet == null) return palette.filter(matchRule(provider));
  return filterPaletteByInventory(palette, codeSet, provider);
}

export function inventoryWarnings(palette, codeSet, provider) {
  // 锚点守卫：过滤掉所有近白（H2 类）或近黑（H7 类）颜色是允许的，但把事实结构化地交给 UI 提示。
  const effective = getEffectivePalette(palette, codeSet, provider);
  const knownCodes = new Set(palette.map((color) => color.code));
  const missingCodes = codeSet == null
    ? []
    : [...toCodeSet(codeSet)].filter((code) => !knownCodes.has(code));
  return {
    noWhite: !effective.some((color) => hexLuma(color.hex) >= NEAR_WHITE_LUMA),
    noBlack: !effective.some((color) => hexLuma(color.hex) <= NEAR_BLACK_LUMA),
    empty: effective.length === 0,
    missingCodes,
  };
}

// 缺色清单：理想（完整色板）转换用到、但库存未拥有的颜色，按用量降序排列。
// idealCounts 为可迭代的 [index, count] 对（如 Map），index 是色板数组位置而非库存子集位置。
// codeSet 为 null/undefined 表示库存功能未启用：没有“缺失”概念，返回空清单。
export function computeMissingColors(idealCounts, codeSet, palette, provider) {
  if (codeSet == null) return [];
  if (!idealCounts || typeof idealCounts[Symbol.iterator] !== 'function') return [];
  const owned = toCodeSet(codeSet);
  const matchable = matchRule(provider);
  const rows = [];
  for (const entry of idealCounts) {
    const [index, count] = entry || [];
    if (!Number.isInteger(count) || count <= 0) continue;
    const color = palette?.[index];
    if (!color || !matchable(color)) continue;
    if (owned.has(color.code)) continue;
    rows.push({ code: color.code, name: color.name, hex: color.hex, count, series: color.series });
  }
  rows.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return rows;
}

export function serializeInventories(all) {
  const out = {};
  if (all && typeof all === 'object') {
    for (const [providerId, codes] of Object.entries(all)) {
      out[providerId] = normalizeCodes(codes);
    }
  }
  return JSON.stringify(out);
}

export function parseInventories(json, validCodesByProvider = {}) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out = {};
  for (const [providerId, codes] of Object.entries(parsed)) {
    const normalized = normalizeCodes(codes);
    const valid = validCodesByProvider?.[providerId];
    if (!valid) {
      out[providerId] = normalized;
      continue;
    }
    // 提供了合法色号表的 provider：未知色号静默丢弃。
    const validSet = valid instanceof Set ? valid : new Set(normalizeCodes(valid));
    out[providerId] = normalized.filter((code) => validSet.has(code));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 多仓库（multi-inventory, v2）
 *
 * 数据模型：{ activeId: 'inv-<n>' | null, items: [{ id, name, providerId, codes }] }
 * 不变量（由本模块所有出口维护）：
 *   - id 为非空字符串且唯一；name 为去空白后的非空字符串；
 *   - codes 只含色号字符串（去重、保序），provider 已知时剔除非法色号；
 *   - activeId 要么为 null（空仓库列表），要么指向存在的 item。
 * 所有“修改”函数都是纯函数：返回新 store，绝不改动入参。
 * ------------------------------------------------------------------ */

// 名字归一化：去首尾空白；空白结果返回 null 表示“不可用”。
function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed ? trimmed : null;
}

// 解析某 provider 的合法色号表：优先用调用方注入的表，其次用注册表；都不知道则返回 null（不过滤）。
function resolveValidCodes(providerId, validCodesByProvider) {
  const provided = validCodesByProvider?.[providerId];
  if (provided) return toCodeSet(provided);
  return validCodesFor(providerId);
}

// 色号归一化 + 按 provider 合法性过滤（合法表未知时保留全部归一化结果）。
function normalizeItemCodes(codes, providerId, validCodesByProvider) {
  const normalized = normalizeCodes(codes);
  const valid = resolveValidCodes(providerId, validCodesByProvider);
  return valid ? normalized.filter((code) => valid.has(code)) : normalized;
}

// 归一化单个仓库条目；形状非法（id/name 不可用）时返回 null 由调用方丢弃。
function normalizeInventoryItem(raw, validCodesByProvider) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const name = normalizeName(raw.name);
  if (!id || !name) return null;
  const providerId = typeof raw.providerId === 'string' ? raw.providerId : '';
  return { id, name, providerId, codes: normalizeItemCodes(raw.codes, providerId, validCodesByProvider) };
}

// 空 store：一个仓库都没有。UI 层通常应保证至少一个（见 loadInventories 的兜底）。
export function emptyInventoryStore() {
  return { activeId: null, items: [] };
}

// 归一化整个 store：丢弃畸形条目、按出现顺序去重 id、修复悬空 activeId（指向首个条目）。
// 永不抛异常；任何垃圾输入都收敛为合法 store。
export function normalizeInventoryStore(store, validCodesByProvider) {
  try {
    const source = store && typeof store === 'object' ? store : {};
    const rawItems = Array.isArray(source.items) ? source.items : [];
    const items = [];
    const seenIds = new Set();
    for (const raw of rawItems) {
      const item = normalizeInventoryItem(raw, validCodesByProvider);
      if (!item || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      items.push(item);
    }
    const activeId = typeof source.activeId === 'string' && seenIds.has(source.activeId)
      ? source.activeId
      : (items[0]?.id ?? null);
    return { activeId, items };
  } catch (_) {
    return emptyInventoryStore();
  }
}

let inventoryIdCounter = 0;

// 默认 id 工厂：优先 crypto.randomUUID；不可用时退化为 时间戳+自增计数（模块内单调，足够唯一）。
function defaultInventoryId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `inv-${uuid}`;
  inventoryIdCounter += 1;
  return `inv-${Date.now()}-${inventoryIdCounter}`;
}

// 生成唯一 id：注入工厂产出空值或撞号时追加序号兜底，保证不与现有 id 冲突。
function uniqueInventoryId(existingIds, idFactory) {
  const factory = typeof idFactory === 'function' ? idFactory : defaultInventoryId;
  let candidate = factory();
  let suffix = 0;
  while (typeof candidate !== 'string' || !candidate || existingIds.has(candidate)) {
    suffix += 1;
    const base = typeof candidate === 'string' && candidate ? candidate : 'inv';
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

// 序列化为稳定形状的 JSON 字符串（只含 id/name/providerId/codes，色号字符串不依赖数组位置）。
export function serializeInventoryStore(store) {
  const normalized = normalizeInventoryStore(store);
  return JSON.stringify({
    activeId: normalized.activeId,
    items: normalized.items.map(({ id, name, providerId, codes }) => ({ id, name, providerId, codes })),
  });
}

// 解析序列化结果：JSON 非法或顶层形状不符（非对象 / items 非数组）时返回 null；
// 条目级畸形由 normalizeInventoryStore 静默修复或丢弃。
export function parseInventoryStore(json, validCodesByProvider) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.items)) return null;
  return normalizeInventoryStore(parsed, validCodesByProvider);
}

// 读取多仓库：优先 v2 键；缺失/损坏时从 v1 单仓库键迁移（每个 provider 条目生成一个仓库，
// 名为 legacyDefaultName，码值按 provider 合法性过滤）；两者都没有时返回“一个空仓库”的兜底 store，
// 保证 UI 永远有东西可显示。永不抛异常。
export function loadInventories(storage, { validCodesByProvider, legacyProviderId, legacyDefaultName } = {}) {
  const fallbackName = normalizeName(legacyDefaultName) ?? DEFAULT_INVENTORY_NAME;
  const fallbackProviderId = typeof legacyProviderId === 'string' && legacyProviderId
    ? legacyProviderId
    : DEFAULT_PALETTE_PROVIDER_ID;
  try {
    const raw = storage.getItem(INVENTORIES_STORAGE_KEY);
    if (raw) {
      const parsed = parseInventoryStore(raw, validCodesByProvider);
      if (parsed && parsed.items.length > 0) return parsed;
    }
  } catch (_) {}
  try {
    let legacy = null;
    try {
      const rawLegacy = storage.getItem(INVENTORY_STORAGE_KEY);
      if (rawLegacy) {
        const parsedLegacy = JSON.parse(rawLegacy);
        if (parsedLegacy && typeof parsedLegacy === 'object' && !Array.isArray(parsedLegacy)) legacy = parsedLegacy;
      }
    } catch (_) {}
    if (legacy) {
      const items = [];
      for (const [providerId, codes] of Object.entries(legacy)) {
        if (!codes || typeof codes[Symbol.iterator] !== 'function') continue;
        items.push({
          id: defaultInventoryId(),
          name: fallbackName,
          providerId,
          codes: normalizeItemCodes(codes, providerId, validCodesByProvider),
        });
      }
      if (items.length > 0) return { activeId: items[0].id, items };
    }
  } catch (_) {}
  const only = { id: defaultInventoryId(), name: fallbackName, providerId: fallbackProviderId, codes: [] };
  return { activeId: only.id, items: [only] };
}

// 持久化（先归一化再写）；任何存储异常都吞掉并返回 false。
export function saveInventories(storage, store, validCodesByProvider) {
  try {
    storage.setItem(
      INVENTORIES_STORAGE_KEY,
      serializeInventoryStore(normalizeInventoryStore(store, validCodesByProvider)),
    );
    return true;
  } catch (_) {
    return false;
  }
}

// 新建仓库并追加、设为激活。name 空白时用兜底名；providerId 缺省时用默认色卡 provider。
export function createInventory(store, { name, providerId, idFactory } = {}) {
  const base = normalizeInventoryStore(store);
  const id = uniqueInventoryId(new Set(base.items.map((item) => item.id)), idFactory);
  const item = {
    id,
    name: normalizeName(name) ?? DEFAULT_INVENTORY_NAME,
    providerId: typeof providerId === 'string' && providerId ? providerId : DEFAULT_PALETTE_PROVIDER_ID,
    codes: [],
  };
  return { activeId: id, items: [...base.items, item] };
}

// 重命名：id 不存在或名字去空白后为空时原样返回（no-op）。
export function renameInventory(store, id, name) {
  const trimmed = normalizeName(name);
  if (!trimmed) return store;
  const base = normalizeInventoryStore(store);
  if (!base.items.some((item) => item.id === id)) return store;
  return {
    activeId: base.activeId,
    items: base.items.map((item) => (item.id === id ? { ...item, name: trimmed } : item)),
  };
}

// 删除仓库。规则：
//   - 未知 id：no-op，原样返回；
//   - 只剩一个仓库时拒绝删除，改为清空该仓库的 codes（名字与激活状态保留）——
//     UI 永远至少有一个仓库可显示；
//   - 删除激活仓库时，activeId 让给邻居（优先后者，否则前者）；删除非激活仓库时 activeId 不变。
export function removeInventory(store, id) {
  const base = normalizeInventoryStore(store);
  const index = base.items.findIndex((item) => item.id === id);
  if (index === -1) return store;
  if (base.items.length === 1) {
    const only = base.items[0];
    return { activeId: only.id, items: [{ ...only, codes: [] }] };
  }
  const items = base.items.filter((item) => item.id !== id);
  let activeId = base.activeId;
  if (activeId === id) {
    const neighbor = base.items[index + 1] ?? base.items[index - 1];
    activeId = neighbor.id;
  }
  return { activeId, items };
}

// 切换激活仓库：未知 id 为 no-op。
export function setActiveInventory(store, id) {
  const base = normalizeInventoryStore(store);
  if (!base.items.some((item) => item.id === id)) return store;
  if (base.activeId === id) return store;
  return { activeId: id, items: base.items };
}

// 当前激活的仓库条目；没有（空 store）时返回 null。
export function getActiveInventory(store) {
  const base = normalizeInventoryStore(store);
  return base.items.find((item) => item.id === base.activeId) ?? null;
}

// 替换激活仓库的色号集合（归一化并按其 provider 过滤非法色号）；无激活仓库时为 no-op。
export function updateActiveCodes(store, codeSet) {
  const base = normalizeInventoryStore(store);
  const active = getActiveInventory(base);
  if (!active) return store;
  const codes = normalizeItemCodes(codeSet, active.providerId);
  return {
    activeId: base.activeId,
    items: base.items.map((item) => (item.id === active.id ? { ...item, codes } : item)),
  };
}

// 重命名激活仓库；无激活仓库或名字空白时为 no-op。
export function renameActiveInventory(store, name) {
  const base = normalizeInventoryStore(store);
  if (!base.activeId) return store;
  return renameInventory(base, base.activeId, name);
}

// 激活仓库的色号集合副本：调用方改动返回的 Set 不影响 store。
export function activeInventoryCodes(store) {
  return new Set(getActiveInventory(store)?.codes ?? []);
}

// 所有仓库名字（按 items 顺序），供 UI 列表 / 测试断言使用。
export function inventoryNames(store) {
  return normalizeInventoryStore(store).items.map((item) => item.name);
}

/* ------------------------------------------------------------------ *
 * 备份文件格式（envelope, format v1）
 *
 * 导出的不再是裸 store，而是带元信息的信封：
 *   { type, formatVersion, exportedAt, app:{name,version}, owner, inventories }
 * type/formatVersion 是格式判别字段：导入方凭它们区分信封与历史裸 store，
 * 并靠 formatVersion 决定能否直接读取。owner 为未来的账户 id 预留，当前恒为 null。
 * 兼容规则见 docs/inventory-file-format.md。
 * ------------------------------------------------------------------ */

export const INVENTORY_FILE_TYPE = 'starpicdots-inventory';
export const INVENTORY_FILE_FORMAT_VERSION = 1;

// 序列化为信封 JSON；inventories 直接复用 serializeInventoryStore 的归一化结果。
export function serializeInventoryFile(store, { appVersion = '' } = {}) {
  return JSON.stringify({
    type: INVENTORY_FILE_TYPE,
    formatVersion: INVENTORY_FILE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    app: { name: 'StarPicDots', version: appVersion },
    owner: null,
    inventories: JSON.parse(serializeInventoryStore(store)),
  }, null, 2);
}

// 解析备份文件：同时接受 (a) 信封格式与 (b) 历史裸 store，返回归一化 store 或 null。
// 带判别字段但 type 不符、formatVersion 不是当前版本（含更高版本）、或缺 inventories 的，一律返回 null。
export function parseInventoryFile(json, validCodesByProvider) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.type !== undefined || parsed.formatVersion !== undefined) {
    if (parsed.type !== INVENTORY_FILE_TYPE) return null;
    if (Number(parsed.formatVersion) !== INVENTORY_FILE_FORMAT_VERSION) return null;
    if (!parsed.inventories || typeof parsed.inventories !== 'object' || Array.isArray(parsed.inventories)) return null;
    return parseInventoryStore(JSON.stringify(parsed.inventories), validCodesByProvider);
  }
  return parseInventoryStore(json, validCodesByProvider);
}

/* ------------------------------------------------------------------ *
 * 备份提醒（backup reminder）
 *
 * 元信息存于 INVENTORY_META_STORAGE_KEY：{ lastChangeAt, lastExportAt, reminderDismissedAt }
 * （均为 ISO 字符串或 null）。提醒条件：有改动、改动未被之后的导出覆盖、
 * 改动已超过一周、且没有针对这次改动的关闭记录。本模块只提供判定，存储在调用方。
 * ------------------------------------------------------------------ */

export const INVENTORY_META_STORAGE_KEY = 'bead-grid-studio:inventory-meta:v1';
export const BACKUP_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldShowBackupReminder(meta, now = Date.now()) {
  if (!meta || typeof meta !== 'object') return false;
  const changeAt = Date.parse(meta.lastChangeAt);
  if (!Number.isFinite(changeAt)) return false;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return false;
  const exportAt = Date.parse(meta.lastExportAt);
  if (Number.isFinite(exportAt) && changeAt <= exportAt) return false;
  if (nowMs - changeAt < BACKUP_REMINDER_INTERVAL_MS) return false;
  const dismissedAt = Date.parse(meta.reminderDismissedAt);
  if (Number.isFinite(dismissedAt) && dismissedAt >= changeAt) return false;
  return true;
}
