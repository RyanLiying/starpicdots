import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeInventoryCodes,
  computeMissingColors,
  createInventory,
  emptyInventoryStore,
  filterPaletteByInventory,
  getActiveInventory,
  getEffectivePalette,
  INVENTORIES_STORAGE_KEY,
  INVENTORY_STORAGE_KEY,
  inventoryNames,
  inventoryWarnings,
  loadInventories,
  normalizeInventoryStore,
  parseInventories,
  parseInventoryStore,
  removeInventory,
  renameActiveInventory,
  renameInventory,
  saveInventories,
  serializeInventories,
  serializeInventoryStore,
  setActiveInventory,
  updateActiveCodes,
} from '../../src/core/inventory.js';
import { DEFAULT_PALETTE_PROVIDER_ID } from '../../src/palettes/catalog.js';
import { PALETTE } from '../../src/palettes/mard221.js';

const PROVIDER = DEFAULT_PALETTE_PROVIDER_ID;
const VALID_CODES = new Set(PALETTE.map((color) => color.code));

function createMockStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const throwingStorage = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
};

test('filterPaletteByInventory excludes transparent colors even when owned', () => {
  const filtered = filterPaletteByInventory(PALETTE, new Set(['H1', 'A1', 'H7']));
  assert.deepEqual(filtered.map((color) => color.code), ['A1', 'H7']);
  assert.ok(filtered.every((color) => !color.isTransparent));
});

test('filtering preserves original index values and never re-indexes', () => {
  const filtered = filterPaletteByInventory(PALETTE, new Set(['B5', 'H2', 'M15']));
  assert.ok(filtered.every((color) => PALETTE[color.index] === color));
  assert.deepEqual(filtered.map((color) => color.code), ['B5', 'H2', 'M15']);
});

test('null inventory means feature off; empty inventory means nothing owned', () => {
  const full = getEffectivePalette(PALETTE, null);
  assert.equal(full.length, 220);
  assert.ok(full.every((color) => !color.isTransparent));
  assert.deepEqual(getEffectivePalette(PALETTE, undefined), full);
  // 显式空库存与“未启用”不同：空集合过滤后一无所剩。
  assert.equal(getEffectivePalette(PALETTE, new Set()).length, 0);
  assert.equal(getEffectivePalette(PALETTE, []).length, 0);
});

test('inventoryWarnings flags missing white and black anchors without forcing them back', () => {
  const onlyBlack = inventoryWarnings(PALETTE, new Set(['H7']));
  assert.equal(onlyBlack.noWhite, true);
  assert.equal(onlyBlack.noBlack, false);
  assert.equal(onlyBlack.empty, false);
  assert.deepEqual(onlyBlack.missingCodes, []);

  const onlyWhite = inventoryWarnings(PALETTE, new Set(['H2']));
  assert.equal(onlyWhite.noWhite, false);
  assert.equal(onlyWhite.noBlack, true);

  const empty = inventoryWarnings(PALETTE, new Set());
  assert.deepEqual(empty, { noWhite: true, noBlack: true, empty: true, missingCodes: [] });

  // 库存功能关闭时没有警告。
  assert.deepEqual(inventoryWarnings(PALETTE, null), {
    noWhite: false,
    noBlack: false,
    empty: false,
    missingCodes: [],
  });
});

test('inventoryWarnings reports codes that no palette color claims', () => {
  const warnings = inventoryWarnings(PALETTE, new Set(['A1', 'ZZ9']));
  assert.deepEqual(warnings.missingCodes, ['ZZ9']);
});

test('serializeInventories and parseInventories round-trip per-provider codes', () => {
  const all = { [PROVIDER]: new Set(['A1', 'H2', 'H7']), 'future-provider': ['Q1'] };
  const parsed = parseInventories(serializeInventories(all), { [PROVIDER]: VALID_CODES });
  assert.deepEqual(parsed, { [PROVIDER]: ['A1', 'H2', 'H7'], 'future-provider': ['Q1'] });
});

test('parseInventories returns null on garbage and drops unknown codes', () => {
  assert.equal(parseInventories('{not json', { [PROVIDER]: VALID_CODES }), null);
  assert.equal(parseInventories('[]'), null);
  assert.equal(parseInventories('42'), null);
  const parsed = parseInventories(
    JSON.stringify({ [PROVIDER]: ['A1', 'ZZ9', 3] }),
    { [PROVIDER]: VALID_CODES },
  );
  assert.deepEqual(parsed, { [PROVIDER]: ['A1'] });
});

const indexOf = (code) => PALETTE.findIndex((color) => color.code === code);

test('computeMissingColors lists ideal-run colors the inventory does not own, sorted by count desc', () => {
  const idealCounts = new Map([
    [indexOf('H2'), 3],
    [indexOf('A1'), 9],
    [indexOf('H7'), 5],
  ]);
  const rows = computeMissingColors(idealCounts, new Set(['H7']), PALETTE);
  assert.deepEqual(
    rows.map((row) => [row.code, row.count]),
    [['A1', 9], ['H2', 3]],
  );
  const a1 = PALETTE[indexOf('A1')];
  assert.deepEqual(rows[0], { code: 'A1', name: a1.name, hex: a1.hex, count: 9, series: a1.series });
});

test('computeMissingColors breaks count ties by ascending palette code', () => {
  const idealCounts = new Map([
    [indexOf('H7'), 4],
    [indexOf('B5'), 4],
    [indexOf('A2'), 4],
  ]);
  const rows = computeMissingColors(idealCounts, new Set(), PALETTE);
  assert.deepEqual(rows.map((row) => row.code), ['A2', 'B5', 'H7']);
});

test('computeMissingColors drops owned, transparent, zero-count, and unknown-index entries', () => {
  const idealCounts = new Map([
    [indexOf('A1'), 2], // 已拥有
    [indexOf('H1'), 7], // 透明豆不参与自动转换
    [indexOf('M15'), 0], // 理想转换未使用
    [9999, 4], // 非法索引
  ]);
  assert.deepEqual(computeMissingColors(idealCounts, new Set(['A1']), PALETTE), []);
});

test('computeMissingColors returns an empty list when inventory is off or counts are unusable', () => {
  const idealCounts = new Map([[indexOf('A1'), 5]]);
  assert.deepEqual(computeMissingColors(idealCounts, null, PALETTE), []);
  assert.deepEqual(computeMissingColors(idealCounts, undefined, PALETTE), []);
  assert.deepEqual(computeMissingColors(null, new Set(['A1']), PALETTE), []);
});

/* ------------------------- 多仓库（multi-inventory, v2） ------------------------- */

// 确定性 id 工厂：每个测试独立计数。
function seqIdFactory(prefix = 'inv') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function makeStore() {
  return {
    activeId: 'inv-1',
    items: [
      { id: 'inv-1', name: '主仓', providerId: PROVIDER, codes: ['H2', 'H7'] },
      { id: 'inv-2', name: '备用', providerId: PROVIDER, codes: ['A1'] },
      { id: 'inv-3', name: '散装', providerId: PROVIDER, codes: [] },
    ],
  };
}

const snapshot = (value) => JSON.stringify(value);

test('emptyInventoryStore returns an empty but valid store', () => {
  assert.deepEqual(emptyInventoryStore(), { activeId: null, items: [] });
  assert.equal(getActiveInventory(emptyInventoryStore()), null);
});

test('loadInventories without any stored data yields one empty active inventory', () => {
  const store = loadInventories(createMockStorage(), { legacyDefaultName: '我的仓库' });
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].name, '我的仓库');
  assert.equal(store.items[0].providerId, PROVIDER);
  assert.deepEqual(store.items[0].codes, []);
  assert.equal(store.activeId, store.items[0].id);
  assert.match(store.items[0].id, /^inv-/);
});

test('loadInventories migrates the legacy v1 key: codes preserved, named, activated', () => {
  const storage = createMockStorage({
    [INVENTORY_STORAGE_KEY]: JSON.stringify({ [PROVIDER]: ['A1', 'H2', 'ZZ9', 'H2'] }),
  });
  const store = loadInventories(storage, { legacyDefaultName: '旧库存' });
  assert.equal(store.items.length, 1);
  const [item] = store.items;
  assert.equal(item.name, '旧库存');
  assert.equal(item.providerId, PROVIDER);
  // 去重 + 剔除 provider 非法色号（ZZ9），只保留色号字符串。
  assert.deepEqual(item.codes, ['A1', 'H2']);
  assert.equal(store.activeId, item.id);
});

test('loadInventories migrates every legacy provider entry into its own inventory', () => {
  const storage = createMockStorage({
    [INVENTORY_STORAGE_KEY]: JSON.stringify({ [PROVIDER]: ['A1'], 'future-brand': ['Q1', 'Q2'] }),
  });
  const store = loadInventories(storage, { legacyDefaultName: '旧库存' });
  assert.equal(store.items.length, 2);
  assert.deepEqual(store.items.map((item) => item.providerId), [PROVIDER, 'future-brand']);
  // 未知 provider 没有合法色号表，码值原样保留。
  assert.deepEqual(store.items[1].codes, ['Q1', 'Q2']);
  assert.equal(store.activeId, store.items[0].id);
});

test('loadInventories prefers the v2 key and ignores legacy data when v2 is present', () => {
  const store = makeStore();
  const storage = createMockStorage({
    [INVENTORIES_STORAGE_KEY]: serializeInventoryStore(store),
    [INVENTORY_STORAGE_KEY]: JSON.stringify({ [PROVIDER]: ['A1'] }),
  });
  assert.deepEqual(loadInventories(storage), store);
});

test('loadInventories falls back to legacy migration when the v2 key is corrupt', () => {
  const storage = createMockStorage({
    [INVENTORIES_STORAGE_KEY]: '{oops',
    [INVENTORY_STORAGE_KEY]: JSON.stringify({ [PROVIDER]: ['B5'] }),
  });
  const store = loadInventories(storage, { legacyDefaultName: '旧库存' });
  assert.equal(store.items.length, 1);
  assert.deepEqual(store.items[0].codes, ['B5']);
});

test('loadInventories never throws on hostile storage and still yields one inventory', () => {
  const store = loadInventories(throwingStorage);
  assert.equal(store.items.length, 1);
  assert.deepEqual(store.items[0].codes, []);
  assert.equal(store.activeId, store.items[0].id);
});

test('saveInventories and loadInventories round-trip the normalized store', () => {
  const storage = createMockStorage();
  const store = makeStore();
  assert.equal(saveInventories(storage, store), true);
  assert.deepEqual(JSON.parse(storage.getItem(INVENTORIES_STORAGE_KEY)), store);
  assert.deepEqual(loadInventories(storage), store);
  // 不触碰 v1 旧键。
  assert.equal(storage.getItem(INVENTORY_STORAGE_KEY), null);
  assert.equal(saveInventories(throwingStorage, store), false);
});

test('createInventory appends a new active inventory without mutating the input store', () => {
  const before = makeStore();
  const frozen = snapshot(before);
  const after = createInventory(before, { name: '  新仓  ', idFactory: seqIdFactory() });
  assert.equal(snapshot(before), frozen);
  assert.equal(after.items.length, 4);
  assert.deepEqual(before.items.length, 3);
  const created = getActiveInventory(after);
  assert.equal(created.name, '新仓');
  assert.equal(created.providerId, PROVIDER);
  assert.deepEqual(created.codes, []);
  assert.equal(after.activeId, created.id);
});

test('createInventory falls back to a default name and dedupes colliding ids', () => {
  const store = makeStore();
  const after = createInventory(store, { name: '   ', idFactory: () => 'inv-1' });
  const created = getActiveInventory(after);
  assert.equal(created.name, '未命名库存');
  assert.notEqual(created.id, 'inv-1');
  assert.equal(new Set(after.items.map((item) => item.id)).size, after.items.length);
});

test('the default id factory produces unique ids across many creations', () => {
  let store = emptyInventoryStore();
  for (let i = 0; i < 60; i += 1) store = createInventory(store, { name: `仓${i}` });
  const ids = store.items.map((item) => item.id);
  assert.equal(new Set(ids).size, 60);
});

test('renameInventory renames in place, is a no-op for blank names or unknown ids', () => {
  const before = makeStore();
  const frozen = snapshot(before);
  const renamed = renameInventory(before, 'inv-2', '  备用二  ');
  assert.equal(snapshot(before), frozen);
  assert.equal(renamed.items[1].name, '备用二');
  assert.equal(renamed.activeId, 'inv-1');
  assert.equal(renameInventory(before, 'inv-2', '   '), before);
  assert.equal(renameInventory(before, 'nope', 'x'), before);
});

test('renameActiveInventory renames the active item only', () => {
  const store = setActiveInventory(makeStore(), 'inv-3');
  const renamed = renameActiveInventory(store, '散装大豆');
  assert.equal(renamed.items[2].name, '散装大豆');
  assert.equal(renamed.items[0].name, '主仓');
  assert.equal(renameActiveInventory(emptyInventoryStore(), 'x').items.length, 0);
});

test('removeInventory keeps activeId when removing an inactive item and stays pure', () => {
  const before = makeStore();
  const frozen = snapshot(before);
  const after = removeInventory(before, 'inv-2');
  assert.equal(snapshot(before), frozen);
  assert.deepEqual(inventoryNames(after), ['主仓', '散装']);
  assert.equal(after.activeId, 'inv-1');
});

test('removeInventory hands activeId to the next neighbor, else the previous one', () => {
  const store = setActiveInventory(makeStore(), 'inv-2');
  const afterMiddle = removeInventory(store, 'inv-2');
  assert.equal(afterMiddle.activeId, 'inv-3');
  assert.deepEqual(inventoryNames(afterMiddle), ['主仓', '散装']);
  const activeLast = setActiveInventory(makeStore(), 'inv-3');
  const afterLast = removeInventory(activeLast, 'inv-3');
  assert.equal(afterLast.activeId, 'inv-2');
  const base = makeStore();
  assert.equal(removeInventory(base, 'ghost'), base);
});

test('removeInventory refuses to delete the last inventory: clears codes, keeps name and active', () => {
  const only = { activeId: 'inv-1', items: [{ id: 'inv-1', name: '主仓', providerId: PROVIDER, codes: ['H2'] }] };
  const frozen = snapshot(only);
  const after = removeInventory(only, 'inv-1');
  assert.equal(snapshot(only), frozen);
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].name, '主仓');
  assert.deepEqual(after.items[0].codes, []);
  assert.equal(after.activeId, 'inv-1');
});

test('setActiveInventory switches the active id and ignores unknown ids', () => {
  const before = makeStore();
  const after = setActiveInventory(before, 'inv-3');
  assert.equal(after.activeId, 'inv-3');
  assert.equal(getActiveInventory(after).name, '散装');
  assert.equal(setActiveInventory(before, 'ghost'), before);
  assert.equal(setActiveInventory(before, 'inv-1'), before);
});

test('updateActiveCodes replaces active codes, drops provider-illegal codes, stays pure', () => {
  const before = makeStore();
  const frozen = snapshot(before);
  const after = updateActiveCodes(before, new Set(['A1', 'ZZ9', 'A1', 7]));
  assert.equal(snapshot(before), frozen);
  assert.deepEqual(getActiveInventory(after).codes, ['A1']);
  assert.deepEqual(before.items[0].codes, ['H2', 'H7']);
  // 非激活仓库不受影响。
  assert.deepEqual(after.items[1].codes, ['A1']);
  assert.equal(updateActiveCodes(emptyInventoryStore(), new Set(['A1'])).items.length, 0);
});

test('activeInventoryCodes returns a defensive Set copy', () => {
  const store = makeStore();
  const codes = activeInventoryCodes(store);
  assert.ok(codes instanceof Set);
  assert.deepEqual([...codes].sort(), ['H2', 'H7']);
  codes.add('ZZ9');
  codes.delete('H2');
  assert.deepEqual(getActiveInventory(store).codes, ['H2', 'H7']);
  assert.equal(activeInventoryCodes(emptyInventoryStore()).size, 0);
});

test('normalizeInventoryStore drops malformed items, dedupes ids, repairs activeId', () => {
  const messy = {
    activeId: 'ghost',
    items: [
      { id: 'a', name: ' 甲 ', providerId: PROVIDER, codes: ['A1', 'ZZ9'] },
      { id: 'a', name: '重复', providerId: PROVIDER, codes: ['H2'] },
      { id: '', name: '没id', providerId: PROVIDER, codes: [] },
      { id: 'b', name: '   ', providerId: PROVIDER, codes: [] },
      'not-an-object',
      { id: 'c', name: '丙', providerId: 'unknown-provider', codes: ['Q1'] },
    ],
  };
  const store = normalizeInventoryStore(messy);
  assert.deepEqual(store.items.map((item) => item.id), ['a', 'c']);
  assert.equal(store.items[0].name, '甲');
  // 已知 provider 过滤非法色号；未知 provider 原样保留。
  assert.deepEqual(store.items[0].codes, ['A1']);
  assert.deepEqual(store.items[1].codes, ['Q1']);
  assert.equal(store.activeId, 'a');
  assert.deepEqual(normalizeInventoryStore(null), { activeId: null, items: [] });
  assert.deepEqual(normalizeInventoryStore(42), { activeId: null, items: [] });
});

test('validCodesByProvider filters codes for providers the registry does not know', () => {
  const json = JSON.stringify({
    activeId: 'x',
    items: [{ id: 'x', name: '外部', providerId: 'future-brand', codes: ['Q1', 'ZZ9'] }],
  });
  const store = parseInventoryStore(json, { 'future-brand': ['Q1'] });
  assert.deepEqual(store.items[0].codes, ['Q1']);
});

test('serializeInventoryStore and parseInventoryStore round-trip with a stable shape', () => {
  const store = setActiveInventory(makeStore(), 'inv-2');
  const json = serializeInventoryStore(store);
  assert.deepEqual(JSON.parse(json), {
    activeId: 'inv-2',
    items: store.items.map(({ id, name, providerId, codes }) => ({ id, name, providerId, codes })),
  });
  assert.deepEqual(parseInventoryStore(json), store);
});

test('parseInventoryStore returns null on invalid JSON or wrong top-level shape', () => {
  assert.equal(parseInventoryStore('{oops'), null);
  assert.equal(parseInventoryStore('[]'), null);
  assert.equal(parseInventoryStore('42'), null);
  assert.equal(parseInventoryStore('null'), null);
  assert.equal(parseInventoryStore('{"items":{}}'), null);
  // items 为合法数组时形状成立，畸形条目由归一化兜底。
  assert.deepEqual(parseInventoryStore('{"activeId":null,"items":[]}'), { activeId: null, items: [] });
});

test('inventoryNames lists names in item order', () => {
  assert.deepEqual(inventoryNames(makeStore()), ['主仓', '备用', '散装']);
  assert.deepEqual(inventoryNames(emptyInventoryStore()), []);
});
