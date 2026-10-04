'use strict';

const assert = require('assert');
const geom = require('../src/geom');
const { optimize, optimizeRolls, buildMask, Grid } = require('../src/nest');
const { validateJobInput } = require('../src/validate');

let passed = 0;
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const t of queue) {
    try {
      await t.fn();
      passed++;
      console.log('  ✓ ' + t.name);
    } catch (e) {
      console.error('  ✗ ' + t.name);
      console.error('    ' + (e && e.message ? e.message : e));
      process.exitCode = 1;
    }
  }
}

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

/** 排样结果不变量校验：边界、两两不重叠、不压瑕疵、锁定件不动 */
function verifyLayout({ W, L, defects, locked, result, typesByKey }) {
  const absOf = (pl) => {
    const t = typesByKey.get(pl.key);
    return geom.toAbsolute(t.verts, pl.rotation, t.w, t.h, pl.x, pl.y);
  };
  const polys = result.placements.map((pl) => ({ pl, abs: absOf(pl) }));
  for (const { pl, abs } of polys) {
    for (const [x, y] of abs) {
      assert(x >= 0 && x <= W && y >= 0 && y <= L, `裁片 ${pl.key} 顶点 (${x},${y}) 超出布幅`);
    }
    for (const d of defects) {
      assert(
        !geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h)),
        `裁片 ${pl.key} 与瑕疵区 (${d.x},${d.y},${d.w},${d.h}) 重叠`
      );
    }
  }
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      assert(
        !geom.polygonsInteriorOverlap(polys[i].abs, polys[j].abs),
        `裁片 ${polys[i].pl.key} 与 ${polys[j].pl.key} 内部重叠`
      );
    }
  }
  for (const lp of locked) {
    const got = result.placements.find((p) => p.key === lp.key);
    assert(got, '锁定件丢失');
    assert(got.x === lp.x && got.y === lp.y && got.rotation === lp.rot, '锁定件位置被改变');
  }
}

// ---------------- 几何：轮廓校验 ----------------
console.log('几何：轮廓校验');
test('合法矩形通过', () => {
  assert.strictEqual(geom.validatePolygon(rect(0, 0, 10, 10)), null);
});
test('凹多边形（L 形）通过', () => {
  assert.strictEqual(
    geom.validatePolygon([[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]]),
    null
  );
});
test('自交（蝴蝶结）被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 10], [10, 0], [0, 10]]));
});
test('零面积被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [5, 5], [10, 10]]));
});
test('重复相邻顶点被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 0], [10, 0], [0, 10]]));
});
test('非整数坐标被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10.5, 0], [0, 10]]));
});
test('顶点数不足被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 0]]));
});

// ---------------- 几何：内部重叠（边界接触允许） ----------------
console.log('几何：内部重叠判定');
test('边接触的矩形不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10)));
});
test('部分共边（T 型接触）不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(3, 10, 4, 8)));
});
test('角点接触不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(10, 10, 5, 5)));
});
test('正面积重叠被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(9, 0, 10, 10)));
});
test('完全重合被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(0, 0, 10, 10)));
});
test('包含关系被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(2, 2, 3, 3)));
});
test('内接菱形（顶点全在对方边界上）被检出', () => {
  const diamond = [[5, 0], [10, 5], [5, 10], [0, 5]];
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), diamond));
});
test('旋转 180° 后与原向不重叠（相邻放置）', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, 40, 0);
  assert(!geom.polygonsInteriorOverlap(a, b));
});
test('旋转 180° 互补拼接（共斜边）不重叠', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, 0, 0); // 与 a 恰好拼满同一矩形，仅共斜边
  assert(!geom.polygonsInteriorOverlap(a, b));
});
test('旋转 180° 错位放置重叠被检出', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, -10, 0);
  assert(geom.polygonsInteriorOverlap(a, b));
});

// ---------------- 排样 ----------------
console.log('排样优化器');
test('矩形排样：全部排入且无重叠，占用长度正确', () => {
  const W = 1000, L = 2000;
  const defects = [{ x: 0, y: 0, w: 100, h: 100 }];
  const mk = (key) => ({
    key, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000,
  });
  const pieces = [mk('a'), mk('b'), mk('c'), mk('d')];
  const result = optimize({ W, L, defects, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '应全部排入');
  assert.strictEqual(result.placements.length, 4);
  assert(result.usedLength <= 1100, `占用长度 ${result.usedLength} 应 ≤ 1100`);
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects, locked: [], result, typesByKey });
});

test('超出布幅宽度的裁片列入未排入', () => {
  const result = optimize({
    W: 1000, L: 2000, defects: [], locked: [],
    pieces: [{ key: 'big', maskKey: 'b', verts: rect(0, 0, 1200, 100), allowRotate: true, w: 1200, h: 100, area: 120000 }],
  });
  assert.strictEqual(result.unplaced.length, 1);
  assert(/超出布幅/.test(result.unplaced[0].reason));
});

test('长度不足时列入未排入', () => {
  const pieces = [];
  for (let i = 0; i < 5; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000 });
  }
  const result = optimize({ W: 1000, L: 1000, defects: [], locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 1, '应恰有 1 件放不下');
  assert.strictEqual(result.placements.length, 4);
});

test('锁定件保持固定，其余绕开', () => {
  const locked = [{ key: 'L1', verts: rect(0, 0, 500, 500), rot: 0, x: 250, y: 100, w: 500, h: 500 }];
  const pieces = [];
  for (let i = 0; i < 3; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000 });
  }
  const result = optimize({ W: 1000, L: 2000, defects: [], locked, pieces });
  assert.strictEqual(result.unplaced.length, 0);
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  typesByKey.set('L1', { verts: rect(0, 0, 500, 500), w: 500, h: 500 });
  verifyLayout({ W: 1000, L: 2000, defects: [], locked, result, typesByKey });
});

test('禁旋转件保持 0°，可旋转件角度合法', () => {
  const lshape = [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]];
  const pieces = [
    { key: 'a', maskKey: 'L', verts: lshape, allowRotate: true, w: 300, h: 300, area: 50000 },
    { key: 'b', maskKey: 'L', verts: lshape, allowRotate: false, w: 300, h: 300, area: 50000 },
    { key: 'c', maskKey: 'L', verts: lshape, allowRotate: false, w: 300, h: 300, area: 50000 },
  ];
  const result = optimize({ W: 400, L: 2000, defects: [], locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0);
  for (const pl of result.placements) {
    if (pl.key === 'a') assert(pl.rotation === 0 || pl.rotation === 180);
    else assert.strictEqual(pl.rotation, 0, '禁旋转件不得旋转');
  }
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W: 400, L: 2000, defects: [], locked: [], result, typesByKey });
});

test('随机矩形压力测试（不变量）', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const W = 1600, L = 6000;
  const defects = [
    { x: 700, y: 800, w: 150, h: 200 },
    { x: 200, y: 3000, w: 300, h: 120 },
  ];
  const pieces = [];
  for (let i = 0; i < 30; i++) {
    const w = 100 + Math.floor(rnd() * 400);
    const h = 100 + Math.floor(rnd() * 500);
    pieces.push({
      key: 'r' + i, maskKey: 'r' + i, verts: rect(0, 0, w, h),
      allowRotate: rnd() < 0.5, w, h, area: w * h,
    });
  }
  const result = optimize({ W, L, defects, locked: [], pieces });
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects, locked: [], result, typesByKey });
  assert(result.usedLength <= L);
  console.log(`    （随机测试：排入 ${result.placements.length}/30，占用长度 ${result.usedLength}mm）`);
});

test('随机多边形（含凹形/三角）压力测试（不变量）', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const W = 1600, L = 8000;
  const shapes = [
    [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]], // L 形
    [[0, 0], [400, 0], [0, 300]],                                     // 三角形
    [[0, 0], [250, 0], [250, 150], [125, 220], [0, 150]],             // 五边形
  ];
  const pieces = [];
  for (let i = 0; i < 24; i++) {
    const verts = shapes[i % shapes.length];
    const w = Math.max(...verts.map((v) => v[0]));
    const h = Math.max(...verts.map((v) => v[1]));
    pieces.push({
      key: 's' + i, maskKey: 's' + (i % shapes.length), verts,
      allowRotate: rnd() < 0.5, w, h, area: Math.abs(geom.area2(verts)) / 2,
    });
  }
  const result = optimize({ W, L, defects: [], locked: [], pieces });
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects: [], locked: [], result, typesByKey });
  console.log(`    （随机测试：排入 ${result.placements.length}/24，占用长度 ${result.usedLength}mm）`);
});

// ---------------- 多卷排样：不变量校验 ----------------

console.log('栅格列区间（边接触可分别删除）');

test('边对边接触的两件掩码：区间不融合，删除一件后状态精确还原', () => {
  const W = 200, L = 1000;
  const grid = new Grid(W, L);
  const rectMask = (w, h) => buildMask(rect(0, 0, w, h), w, h);
  const mA = rectMask(100, 100);
  const mB = rectMask(100, 100);
  // A 放 (0,0)，B 放 (0,100)：在 x=0..99 列上两件边对边接触
  grid.markMask(mA, 0, 0, 1);
  grid.markMask(mB, 0, 100, 1);
  // 列 0 应有两段独立区间
  assert.deepStrictEqual(grid.colInts[0], [[0, 100], [100, 200]]);
  assert.strictEqual(grid.hmax[0], 200);
  // 删除 A：只应剩 B 的区间，且栅格数据一致
  grid.markMask(mA, 0, 0, 0);
  assert.deepStrictEqual(grid.colInts[0], [[100, 200]], '区间不应被错误融合导致残留');
  assert.strictEqual(grid.hmax[0], 200);
  // A 的原区域现已空，可重新放入同一位置（columnLift 应给出 y=0 可行）
  const y = grid.columnLift(mA, 0, 0);
  assert.strictEqual(y, 0, '删除后边接触件下方应可重新落位');
});

console.log('多卷排样优化器');
function verifyMultiLayout({ rolls, locked, result, typesByKey }) {
  const placed = result.placements;
  for (const pl of placed) {
    const rl = rolls[pl.rollIndex];
    assert(rl, `裁片 ${pl.key} 卷下标越界`);
    const t = typesByKey.get(pl.key);
    const abs = geom.toAbsolute(t.verts, pl.rotation, t.w, t.h, pl.x, pl.y);
    for (const [x, y] of abs) {
      assert(x >= 0 && x <= rl.W && y >= 0 && y <= rl.L, `裁片 ${pl.key} 顶点 (${x},${y}) 超出卷 ${pl.rollIndex}`);
    }
    for (const d of rl.defects || []) {
      assert(
        !geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h)),
        `裁片 ${pl.key} 与卷${pl.rollIndex}瑕疵重叠`
      );
    }
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (placed[i].rollIndex !== placed[j].rollIndex) continue; // 不同卷互不干涉
      const ta = typesByKey.get(placed[i].key);
      const tb = typesByKey.get(placed[j].key);
      const a = geom.toAbsolute(ta.verts, placed[i].rotation, ta.w, ta.h, placed[i].x, placed[i].y);
      const b = geom.toAbsolute(tb.verts, placed[j].rotation, tb.w, tb.h, placed[j].x, placed[j].y);
      assert(!geom.polygonsInteriorOverlap(a, b), `同卷裁片 ${placed[i].key} 与 ${placed[j].key} 内部重叠`);
    }
  }
  for (const lp of locked) {
    const got = placed.find((p) => p.key === lp.key);
    assert(got, '锁定件丢失');
    assert(
      got.rollIndex === lp.rollIndex && got.x === lp.x && got.y === lp.y && got.rotation === lp.rot,
      `锁定件 ${lp.key} 的卷号或位置被改变`
    );
  }
  // rollUsedLengths 与 usedLength 一致
  assert.strictEqual(
    result.usedLength,
    result.rollUsedLengths.reduce((a, b) => a + b, 0),
    'usedLength 应为各卷之和'
  );
}

console.log('多卷排样优化器');

test('两卷都容得下全部件时只启用一卷（省卷）', () => {
  const pieces = [];
  for (let i = 0; i < 4; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000 });
  }
  const result = optimizeRolls({
    rolls: [
      { label: 'R1', W: 1000, L: 5000, defects: [] },
      { label: 'R2', W: 1000, L: 5000, defects: [] },
    ],
    locked: [],
    pieces,
  });
  assert.strictEqual(result.unplaced.length, 0);
  const opened = result.rollUsedLengths.filter((l) => l > 0).length;
  assert.strictEqual(opened, 1, '应只启用 1 卷');
  verifyMultiLayout({ rolls: [{ W: 1000, L: 5000 }, { W: 1000, L: 5000 }], locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('一卷装不下时自动启用第二卷，全部排入', () => {
  const pieces = [];
  for (let i = 0; i < 6; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 450, 450), allowRotate: false, w: 450, h: 450, area: 202500 });
  }
  const rolls = [
    { label: 'R1', W: 1000, L: 1000, defects: [] }, // 每卷最多 4 件
    { label: 'R2', W: 1000, L: 1000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '6 件应全部排入两卷');
  assert.strictEqual(result.rollUsedLengths.filter((l) => l > 0).length, 2, '两卷都应启用');
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('必用卷约束：必用件只在指定卷；省卷优先时其余件向已开卷集中', () => {
  // 1 件必用卷2；3 件普通件。1000 宽卷每行 2 件 400，卷2 长度 5000 足够全部放入
  // → 最少启用卷数为 1 时不可行（必用件强制开卷2，普通件全部去卷2仍只需1卷）→
  // 实际：必用件开卷2，普通件若全去卷2则总只开 1 卷（卷2），这是省卷最优，允许。
  const pieces = [
    { key: 'a', maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000, requiredIndex: 1 },
    { key: 'b', maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000 },
  ];
  const rolls = [
    { label: 'R1', W: 1000, L: 5000, defects: [] },
    { label: 'R2', W: 1000, L: 5000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  const pa = result.placements.find((p) => p.key === 'a');
  assert.strictEqual(pa.rollIndex, 1, '必用卷件必须在卷2');
  assert.strictEqual(result.rollUsedLengths.filter((l) => l > 0).length, 1, '最少卷数=1（卷2）');
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('必用卷约束 + 容量：必用卷装不下全部时才开第二卷，且必用件绝不去别的卷', () => {
  // 卷2很短（只能放 1 行 2 件 400），必用件 a 在卷2；再放 3 件普通件
  const pieces = [
    { key: 'a', maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000, requiredIndex: 1 },
    ...[0, 1, 2].map((i) => ({ key: 'b' + i, maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000 })),
  ];
  const rolls = [
    { label: 'R1', W: 1000, L: 5000, defects: [] },
    { label: 'R2', W: 1000, L: 500, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, result.unplaced.map((u) => u.reason).join('；'));
  assert.strictEqual(result.placements.find((p) => p.key === 'a').rollIndex, 1);
  assert.strictEqual(result.rollUsedLengths.filter((l) => l > 0).length, 2, '容量迫使开第二卷');
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('必用卷长度不足：该件未排，其余件照常排入（部分方案，不牺牲可排件）', () => {
  const pieces = [
    { key: 'big', maskKey: 'r', verts: rect(0, 0, 400, 800), allowRotate: false, w: 400, h: 800, area: 320000, requiredIndex: 0 },
    { key: 'ok', maskKey: 'r2', verts: rect(0, 0, 200, 200), allowRotate: false, w: 200, h: 200, area: 40000 },
  ];
  const rolls = [
    { label: '短卷', W: 1000, L: 500, defects: [] },
    { label: '长卷', W: 1000, L: 5000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.placements.length, 1, '只排入 1 件');
  assert.strictEqual(result.unplaced.length, 1);
  assert.strictEqual(result.unplaced[0].key, 'big');
  assert(/必用卷/.test(result.unplaced[0].reason), '原因应指明必用卷');
});

test('各卷瑕疵独立：卷1瑕疵不影响卷2排样', () => {
  const pieces = [{ key: 'a', maskKey: 'r', verts: rect(0, 0, 200, 200), allowRotate: false, w: 200, h: 200, area: 40000, requiredIndex: 1 }];
  const rolls = [
    { label: 'R1', W: 1000, L: 1000, defects: [{ x: 0, y: 0, w: 1000, h: 1000 }] }, // 卷1全瑕疵
    { label: 'R2', W: 1000, L: 1000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '卷2干净，应排入');
  assert.strictEqual(result.placements[0].rollIndex, 1);
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('跨卷压实可腾空整卷', () => {
  // 锁定：卷1放一件占着卷1；解锁件都很小。再给一件必用卷1以外的件→
  // 这里直接构造：锁定件在卷1，4 个 450x450 件可被重排。1000 宽卷每排2件。
  const pieces = [];
  for (let i = 0; i < 4; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 450, 450), allowRotate: false, w: 450, h: 450, area: 202500 });
  }
  const locked = [{ key: 'L1', rollIndex: 0, verts: rect(0, 0, 100, 100), rot: 0, x: 0, y: 0, w: 100, h: 100 }];
  const rolls = [
    { label: 'R1', W: 1000, L: 2000, defects: [] },
    { label: 'R2', W: 1000, L: 2000, defects: [] },
  ];
  // L1 在卷1 → 卷1必然启用；4 件 450x450 与 100x100 锁定件同卷可容纳（首行仍可放2件450）
  const result = optimizeRolls({ rolls, locked, pieces });
  assert.strictEqual(result.unplaced.length, 0);
  // 卷1已被锁定件启用，最优是 4 件全放卷1，卷2不启用
  assert.strictEqual(result.rollUsedLengths[1], 0, '卷2应可被腾空');
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  typesByKey.set('L1', { verts: rect(0, 0, 100, 100), w: 100, h: 100 });
  verifyMultiLayout({ rolls, locked, result, typesByKey });
});

test('空卷宽度不同：宽件能排入更宽的空卷（不因按代表卷漏排）', () => {
  // 卷1窄（放不下 1200 宽件），卷2宽且空无瑕疵；空卷代表不能只取卷1
  const pieces = [
    { key: 'wide', maskKey: 'r', verts: rect(0, 0, 1200, 300), allowRotate: false, w: 1200, h: 300, area: 360000 },
    { key: 'small', maskKey: 'r2', verts: rect(0, 0, 100, 100), allowRotate: false, w: 100, h: 100, area: 10000 },
  ];
  const rolls = [
    { label: '窄', W: 900, L: 3000, defects: [] },
    { label: '宽', W: 1600, L: 3000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '两件都应排入（宽件去宽卷）');
  const w = result.placements.find((p) => p.key === 'wide');
  assert.strictEqual(w.rollIndex, 1, '宽件应在宽卷');
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('多卷锁定件：跨卷位置与卷号都保持固定', () => {
  const locked = [
    { key: 'L1', rollIndex: 0, verts: rect(0, 0, 300, 300), rot: 0, x: 0, y: 0, w: 300, h: 300 },
    { key: 'L2', rollIndex: 1, verts: rect(0, 0, 300, 300), rot: 0, x: 700, y: 700, w: 300, h: 300 },
  ];
  const pieces = [{ key: 'p', maskKey: 'r', verts: rect(0, 0, 200, 200), allowRotate: false, w: 200, h: 200, area: 40000 }];
  const rolls = [
    { label: 'R1', W: 1000, L: 2000, defects: [] },
    { label: 'R2', W: 1000, L: 2000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked, pieces });
  verifyMultiLayout({ rolls, locked, result, typesByKey: new Map([...pieces.map((p) => [p.key, p]), ...locked.map((l) => [l.key, { verts: l.verts, w: l.w, h: l.h }])]) });
  const l1 = result.placements.find((p) => p.key === 'L1');
  const l2 = result.placements.find((p) => p.key === 'L2');
  assert(l1.rollIndex === 0 && l1.x === 0 && l1.y === 0);
  assert(l2.rollIndex === 1 && l2.x === 700 && l2.y === 700);
});

// ---------------- 创建输入校验：多卷与必用卷 ----------------

console.log('多卷输入校验');

test('多卷形式通过：rolls + 按序号/卷号指定必用卷', () => {
  const r1 = validateJobInput({
    rolls: [
      { label: 'A', width: 1000, length: 2000, defects: [] },
      { label: 'B', width: 1200, length: 3000 },
    ],
    pieces: [
      { name: 'p1', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1, requiredRoll: 2 },
      { name: 'p2', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1, requiredRoll: 'B' },
    ],
  });
  assert.strictEqual(r1.errors.length, 0, r1.errors.join('；'));
  assert.strictEqual(r1.value.pieces[0].requiredRollIndex, 1);
  assert.strictEqual(r1.value.pieces[1].requiredRollIndex, 1);
});

test('旧单卷形式继续通过并归一为一卷', () => {
  const r = validateJobInput({
    fabricWidth: 1500, fabricLength: 5000,
    defects: [{ x: 0, y: 0, w: 10, h: 10 }],
    pieces: [{ name: 'q', vertices: [[0, 0], [100, 0], [100, 100], [0, 100]], quantity: 2 }],
  });
  assert.strictEqual(r.errors.length, 0, r.errors.join('；'));
  assert.strictEqual(r.value.rolls.length, 1);
  assert.strictEqual(r.value.rolls[0].width, 1500);
  assert.strictEqual(r.value.rolls[0].defects.length, 1);
});

test('必用卷序号越界被拒绝', () => {
  const r = validateJobInput({
    rolls: [{ width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1, requiredRoll: 3 }],
  });
  assert(r.errors.some((e) => /必用卷序号 3 无效/.test(e)));
});

test('不存在的卷号文本被拒绝并列出已登记卷号', () => {
  const r = validateJobInput({
    rolls: [{ label: '甲', width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1, requiredRoll: '乙' }],
  });
  assert(r.errors.some((e) => /卷号「乙」不存在/.test(e) && /甲/.test(e)));
});

test('宽度超过必用卷被拒绝（即便其他卷容得下）', () => {
  const r = validateJobInput({
    rolls: [{ label: '窄', width: 100, length: 1000 }, { label: '宽', width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [500, 0], [500, 500], [0, 500]], quantity: 1, requiredRoll: 1 }],
  });
  assert(r.errors.some((e) => /超过必用卷「窄」布幅/.test(e)), r.errors.join('；'));
});

test('重复卷号被拒绝', () => {
  const r = validateJobInput({
    rolls: [{ label: 'R', width: 1000, length: 1000 }, { label: 'R', width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1 }],
  });
  assert(r.errors.some((e) => /卷号「R」重复/.test(e)));
});

test('瑕疵超出所属卷范围被拒绝', () => {
  const r = validateJobInput({
    rolls: [{ label: 'R', width: 500, length: 500, defects: [{ x: 400, y: 0, w: 200, h: 10 }] }],
    pieces: [{ name: 'p', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1 }],
  });
  assert(r.errors.some((e) => /超出该卷范围/.test(e)));
});

test('多卷中某卷容得下即可（不因首卷窄而误拒）', () => {
  const r = validateJobInput({
    rolls: [{ label: '窄', width: 100, length: 1000 }, { label: '宽', width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [500, 0], [500, 500], [0, 500]], quantity: 1 }],
  });
  assert.strictEqual(r.errors.length, 0, r.errors.join('；'));
});

// ---------------- HTTP API（多卷端到端） ----------------

console.log('HTTP API（多卷）');

async function withServer(fn) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const http = require('http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nesting-test-'));
  process.env.DATA_DIR = dir;
  process.env.PORT = '0';
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  const port = server.address().port;
  const call = (method, urlPath, body) =>
    new Promise((resolve) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        { port, host: '127.0.0.1', method, path: urlPath, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }));
        }
      );
      if (payload) req.write(payload);
      req.end();
    });
  try {
    await fn(call);
  } finally {
    await new Promise((res) => server.close(res));
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('../src/server')];
    delete require.cache[require.resolve('../src/db')];
  }
}

test('API：多卷创建→优化→锁定重优化→旧字段兼容', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      name: 'api多卷',
      rolls: [
        { label: 'A卷', width: 1000, length: 2000, defects: [{ x: 0, y: 0, w: 300, h: 300 }] },
        { label: 'B卷', width: 1200, length: 3000 },
      ],
      pieces: [
        { name: '大片', vertices: [[0, 0], [500, 0], [500, 800], [0, 800]], quantity: 2, allowRotate: true },
        { name: '袖片', vertices: [[0, 0], [300, 0], [300, 400], [0, 400]], quantity: 1, requiredRoll: 2 },
      ],
    });
    assert.strictEqual(cr.status, 201, JSON.stringify(cr.data));
    const jobId = cr.data.job.id;
    assert.strictEqual(cr.data.job.rollCount, 2);
    assert(Array.isArray(cr.data.rolls) && cr.data.rolls.length === 2);
    const A = cr.data.rolls[0].id;
    const B = cr.data.rolls[1].id;

    // 列表接口带 rollCount
    const list = await call('GET', '/api/jobs');
    const row = list.data.find((j) => j.id === jobId);
    assert.strictEqual(row.rollCount, 2);
    assert.strictEqual(row.fabricWidth, 1000); // 旧字段=首卷宽度

    // 优化
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.status, 200);
    assert.strictEqual(op.data.unplaced.length, 0);
    assert(op.data.placements.every((p) => typeof p.rollId === 'number'), '每件都带 rollId');
    const xiu = op.data.placements.find((p) => p.name === '袖片');
    assert.strictEqual(xiu.rollId, B, '袖片必用B卷');

    // 锁定大片#1 在其当前位置，重优化后位置/卷不变
    const dp = op.data.placements.find((p) => p.name === '大片' && p.seq === 1);
    const lk = await call('POST', `/api/jobs/${jobId}/placements/${dp.id}/lock`, { locked: true });
    assert.strictEqual(lk.status, 200);
    const op2 = await call('POST', `/api/jobs/${jobId}/optimize`);
    const dp2 = op2.data.placements.find((p) => p.id === dp.id);
    assert(dp2.locked && dp2.rollId === dp.rollId && dp2.x === dp.x && dp2.y === dp.y, '锁定件不动');

    // 锁定件移动 409
    const lm = await call('POST', `/api/jobs/${jobId}/placements/${dp.id}/move`, { rollId: dp.rollId, x: 5, y: 5, rotation: 0 });
    assert.strictEqual(lm.status, 409);

    // 必用卷跨卷移动 409 且指出对象
    const mv = await call('POST', `/api/jobs/${jobId}/placements/${xiu.id}/move`, { rollId: A, x: 0, y: 0, rotation: 0 });
    assert.strictEqual(mv.status, 409);
    assert(/必用卷/.test(mv.data.error) && mv.data.conflicts.length >= 1);

    // 无效目标卷 400
    const bad = await call('POST', `/api/jobs/${jobId}/placements/${xiu.id}/move`, { rollId: 99999, x: 0, y: 0, rotation: 0 });
    assert.strictEqual(bad.status, 400);

    // require-roll：改必用卷为 A（500<=1000 合法）
    const rr = await call('POST', `/api/jobs/${jobId}/placements/${xiu.id}/require-roll`, { rollId: A });
    assert.strictEqual(rr.status, 200);
    assert.strictEqual(rr.data.placements.find((p) => p.id === xiu.id).requiredRollId, A);
    // 必用卷太窄 400（用一个新宽件场景：袖片 300 宽，这里构造窄卷 via 新方案）
  })
);

test('API：必用卷放不下时优化为部分方案，未排件带原因且响应保留卷字段', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: '短卷', width: 500, length: 500 }],
      pieces: [{ name: '块', vertices: [[0, 0], [500, 0], [500, 400], [0, 400]], quantity: 2 }],
    });
    const jobId = cr.data.job.id;
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.data.job.status, 'partial');
    assert.strictEqual(op.data.unplaced.length, 1);
    assert(op.data.unplaced[0].reason && op.data.unplaced[0].reason.length > 0);
    assert(Array.isArray(op.data.rolls));
  })
);

test('API：旧单卷数据与旧调用方式兼容（无 rolls、move 不带 rollId）', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      name: '旧', fabricWidth: 1500, fabricLength: 5000,
      defects: [{ x: 1, y: 2, w: 10, h: 10 }],
      pieces: [{ name: 'q', vertices: [[0, 0], [100, 0], [100, 100], [0, 100]], quantity: 2 }],
    });
    assert.strictEqual(cr.status, 201, JSON.stringify(cr.data));
    assert.strictEqual(cr.data.rolls[0].label, '默认卷');
    assert.strictEqual(cr.data.defects.length, 1, '旧 defects 字段仍返回首卷瑕疵');
    const jobId = cr.data.job.id;
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.data.unplaced.length, 0);
    const pid = op.data.placements[0].id;
    const mv = await call('POST', `/api/jobs/${jobId}/placements/${pid}/move`, { x: 200, y: 200, rotation: 0 });
    assert.strictEqual(mv.status, 200, JSON.stringify(mv.data));
    assert.strictEqual(mv.data.placements.find((p) => p.id === pid).x, 200);
  })
);

// ---------------- HTTP API（按卷裁剪进度） ----------------

console.log('HTTP API（按卷裁剪进度）');

/** 创建多卷方案并优化，返回 { jobId, rolls(id->row), placements, call } */
async function setupCutJob(call) {
  const cr = await call('POST', '/api/jobs', {
    name: '裁剪测试',
    rolls: [
      { label: 'A卷', width: 1000, length: 5000, defects: [] },
      { label: 'B卷', width: 1000, length: 300, defects: [] }, // 短卷：只放得下必用 B 的 200 高件，普通块只能去 A 卷
      { label: 'C卷', width: 1000, length: 5000, defects: [] }, // 用于验证已裁件改必用卷被拦截
    ],
    pieces: [
      { name: '块', vertices: [[0, 0], [500, 0], [500, 400], [0, 400]], quantity: 4, allowRotate: true },
      { name: '必B', vertices: [[0, 0], [200, 0], [200, 200], [0, 200]], quantity: 1, requiredRoll: 2 },
    ],
  });
  assert.strictEqual(cr.status, 201, JSON.stringify(cr.data));
  const jobId = cr.data.job.id;
  const op = await call('POST', `/api/jobs/${jobId}/optimize`);
  assert.strictEqual(op.status, 200);
  return { jobId, state: op.data, call };
}

test('裁剪：确认切线后返回本卷切线与各件已裁状态，进度查询一致', () =>
  withServer(async (call) => {
    const { jobId, state } = await setupCutJob(call);
    // 初始：所有卷切线 0，无已裁件
    const g0 = await call('GET', `/api/jobs/${jobId}/cutting`);
    assert.strictEqual(g0.status, 200);
    assert.strictEqual(g0.data.cutCount, 0);
    assert(g0.data.rolls.every((r) => r.cutLine === 0 && r.cutCount === 0));

    // A卷前两件 500x400 应排在 (0,0) 与 (500,0)：切线 400 裁下 2 件
    const A = state.rolls.find((r) => r.label === 'A卷').id;
    const cut = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: A, cutLine: 400 });
    assert.strictEqual(cut.status, 201, JSON.stringify(cut.data));
    assert.strictEqual(cut.data.cutLine, 400);
    assert.strictEqual(cut.data.previousCutLine, 0);
    assert.strictEqual(cut.data.newlyCut.length, 2);
    const aRoll = cut.data.rolls.find((r) => r.id === A);
    assert.strictEqual(aRoll.cutLength, 400);
    const cutPieces = cut.data.placements.filter((p) => p.cut);
    assert.strictEqual(cutPieces.length, 2);
    assert(cutPieces.every((p) => p.rollId === A && p.y + p.bh <= 400));
    assert(cut.data.placements.filter((p) => p.rollId === A && !p.cut).every((p) => p.y >= 400 || !p.placed));

    // 进度查询接口
    const g1 = await call('GET', `/api/jobs/${jobId}/cutting`);
    const a = g1.data.rolls.find((r) => r.rollId === A);
    assert.strictEqual(a.cutLine, 400);
    assert.strictEqual(a.cutCount, 2);
    assert.strictEqual(g1.data.cutCount, 2);
    const b = g1.data.rolls.find((r) => r.label === 'B卷');
    assert.strictEqual(b.cutLine, 0);
  })
);

test('裁剪：切线可接触裁片边（y+bh=切线）但不能穿过未裁件', () =>
  withServer(async (call) => {
    const { jobId, state } = await setupCutJob(call);
    const A = state.rolls.find((r) => r.label === 'A卷').id;
    // 找一件 y 在第二排的件（y=400 起）
    const row2 = state.placements.find((p) => p.placed && p.rollId === A && p.y === 400);
    assert(row2, '第二排应有裁片 y=400');
    // 切线 600 穿过第二排件（400~800）→ 409 且列出穿过件
    const bad = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: A, cutLine: 600 });
    assert.strictEqual(bad.status, 409, JSON.stringify(bad.data));
    assert(/穿过/.test(bad.data.error));
    assert(bad.data.conflicts.some((c) => c.includes(row2.name)));
    // 原方案保持：切线仍为 0
    const g = await call('GET', `/api/jobs/${jobId}/cutting`);
    assert.strictEqual(g.data.rolls.find((r) => r.rollId === A).cutLine, 0);
    // 切线 400 恰好贴第一排件边 → 成功
    const ok = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: A, cutLine: 400 });
    assert.strictEqual(ok.status, 201);
  })
);

test('裁剪：无效切线（0、回退、超卷长、非整数、缺卷）被拒且原方案不变', () =>
  withServer(async (call) => {
    const { jobId, state } = await setupCutJob(call);
    const A = state.rolls.find((r) => r.label === 'A卷').id;
    const first = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: A, cutLine: 400 });
    assert.strictEqual(first.status, 201);

    for (const body of [
      { rollId: A, cutLine: 400 }, // 等于上一切线（无推进）
      { rollId: A, cutLine: 100 }, // 回退
      { rollId: A, cutLine: 0 }, // 卷首
      { rollId: A, cutLine: 5001 }, // 超卷长
      { rollId: A, cutLine: 450.5 }, // 非整数
      { rollId: 9999, cutLine: 500 }, // 未知卷
      { rollId: A }, // 缺 cutLine
    ]) {
      const r = await call('POST', `/api/jobs/${jobId}/cut`, body);
      assert(r.status === 400, `${JSON.stringify(body)} 应 400，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    }
    // 多卷方案省略 rollId 也为 400
    const noRoll = await call('POST', `/api/jobs/${jobId}/cut`, { cutLine: 800 });
    assert.strictEqual(noRoll.status, 400);
    // 切线保持 400
    const g = await call('GET', `/api/jobs/${jobId}/cutting`);
    assert.strictEqual(g.data.rolls.find((r) => r.rollId === A).cutLine, 400);
  })
);

test('裁剪：切线推进但无新增已裁件（空区间）被拒', () =>
  withServer(async (call) => {
    const { jobId, state } = await setupCutJob(call);
    const A = state.rolls.find((r) => r.label === 'A卷').id;
    // 首排件到 400；切线先到 400，再尝试 500（400~500 间无整件）→ 但 500 不穿过第二排件
    // 第二排 400~800，切线 500 会穿过 → 先移动第二排件腾出空间再测空区间
    const c1 = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: A, cutLine: 400 });
    assert.strictEqual(c1.status, 201);
    // 把第二排两件移到更后面（y=1000），使 400~700 成为空区间
    const row2 = c1.data.placements.filter((p) => p.placed && p.rollId === A && p.y === 400);
    for (let i = 0; i < row2.length; i++) {
      const mv = await call('POST', `/api/jobs/${jobId}/placements/${row2[i].id}/move`, {
        rollId: A, x: row2[i].x, y: 1000, rotation: row2[i].rotation,
      });
      assert.strictEqual(mv.status, 200, JSON.stringify(mv.data));
    }
    const empty = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: A, cutLine: 700 });
    assert.strictEqual(empty.status, 409, JSON.stringify(empty.data));
    assert(/没有新的已排裁片/.test(empty.data.error));
  })
);

test('裁剪：已裁件不能移动/移回未排区/改必用卷', () =>
  withServer(async (call) => {
    const { jobId, state } = await setupCutJob(call);
    const A = state.rolls.find((r) => r.label === 'A卷').id;
    const C = state.rolls.find((r) => r.label === 'C卷').id;
    const cut = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: A, cutLine: 400 });
    const pc = cut.data.placements.find((p) => p.cut);

    const mv = await call('POST', `/api/jobs/${jobId}/placements/${pc.id}/move`, {
      rollId: A, x: pc.x + 10, y: pc.y, rotation: 0,
    });
    assert.strictEqual(mv.status, 409);
    assert(/已.*裁/.test(mv.data.error));

    const up = await call('POST', `/api/jobs/${jobId}/placements/${pc.id}/unplace`, {});
    assert.strictEqual(up.status, 409);

    const rr = await call('POST', `/api/jobs/${jobId}/placements/${pc.id}/require-roll`, { rollId: C });
    assert.strictEqual(rr.status, 409);
    // 幂等：保持原必用卷（本来为 null → 仍设 null）不报错
    const rrSame = await call('POST', `/api/jobs/${jobId}/placements/${pc.id}/require-roll`, { rollId: null });
    assert.strictEqual(rrSame.status, 200);

    // 位置未被改动
    const chk = (await call('GET', `/api/jobs/${jobId}`)).data.placements.find((p) => p.id === pc.id);
    assert.strictEqual(chk.x, pc.x);
    assert.strictEqual(chk.y, pc.y);
    assert.strictEqual(chk.rollId, A);
  })
);

test('裁剪：手动移动/跨卷调整不能把未裁件放入已裁卷段', () =>
  withServer(async (call) => {
    const { jobId, state } = await setupCutJob(call);
    const A = state.rolls.find((r) => r.label === 'A卷').id;
    const c1 = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: A, cutLine: 400 });
    assert.strictEqual(c1.status, 201);
    // 未裁件（第二排）尝试移到切线之前 y=0 → 409
    const p = c1.data.placements.find((p2) => p2.placed && p2.rollId === A && p2.y >= 400);
    assert(p, '应有未裁件');
    const intoCut = await call('POST', `/api/jobs/${jobId}/placements/${p.id}/move`, {
      rollId: A, x: 0, y: 0, rotation: 0,
    });
    assert.strictEqual(intoCut.status, 409, JSON.stringify(intoCut.data));
    assert(/已裁段/.test(intoCut.data.error));
    // 压切线（y=300, h=400 → 300~700 穿过 400）→ 409
    const straddle = await call('POST', `/api/jobs/${jobId}/placements/${p.id}/move`, {
      rollId: A, x: 0, y: 300, rotation: 0,
    });
    assert.strictEqual(straddle.status, 409);
    // 下沿贴切线 y=400 → 合法（边接触）；目标 x 取其原 x 列以避开其他件
    const touch = await call('POST', `/api/jobs/${jobId}/placements/${p.id}/move`, {
      rollId: A, x: p.x, y: 400, rotation: 0,
    });
    assert.strictEqual(touch.status, 200, JSON.stringify(touch.data));
  })
);

test('裁剪：优化只重排未裁件且本卷未裁件必须在切线之后，已裁件不动', () =>
  withServer(async (call) => {
    const { jobId, state } = await setupCutJob(call);
    const A = state.rolls.find((r) => r.label === 'A卷').id;
    const c1 = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: A, cutLine: 400 });
    const cutBefore = c1.data.placements.filter((p) => p.cut);
    assert(cutBefore.length >= 2);
    const snapshot = new Map(cutBefore.map((p) => [p.id, p]));

    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.status, 200, JSON.stringify(op.data));
    // 已裁件卷号/坐标/方向完全不变，仍标 cut
    for (const p of op.data.placements.filter((p2) => snapshot.has(p2.id))) {
      const s = snapshot.get(p.id);
      assert(p.cut, '已裁件仍应标记 cut');
      assert.strictEqual(p.rollId, s.rollId);
      assert.strictEqual(p.x, s.x);
      assert.strictEqual(p.y, s.y);
      assert.strictEqual(p.rotation, s.rotation);
    }
    // A卷上所有未裁已排件 y >= 400
    for (const p of op.data.placements) {
      if (p.placed && p.rollId === A && !p.cut) {
        assert(p.y >= 400, `未裁件 ${p.name}#${p.seq} y=${p.y} 位于切线 400 之前`);
      }
    }
  })
);

test('裁剪：B卷必用卷件切线独立推进；单卷方案可省略 rollId；切线至卷尾可全裁', () =>
  withServer(async (call) => {
    const { jobId, state } = await setupCutJob(call);
    const B = state.rolls.find((r) => r.label === 'B卷').id;
    const after = state.placements.find((p) => p.name === '必B');
    assert.strictEqual(after.rollId, B);
    const cb = await call('POST', `/api/jobs/${jobId}/cut`, { rollId: B, cutLine: after.y + after.bh });
    assert.strictEqual(cb.status, 201);
    assert(cb.data.placements.find((p) => p.id === after.id).cut);

    // 旧单卷方案：省略 rollId 即可裁剪
    const legacy = await call('POST', '/api/jobs', {
      name: '旧单卷', fabricWidth: 1000, fabricLength: 3000,
      pieces: [{ name: 'q', vertices: [[0, 0], [400, 0], [400, 400], [0, 400]], quantity: 1 }],
    });
    const jid = legacy.data.job.id;
    await call('POST', `/api/jobs/${jid}/optimize`);
    const c = await call('POST', `/api/jobs/${jid}/cut`, { cutLine: 3000 }); // 切线到卷尾
    assert.strictEqual(c.status, 201, JSON.stringify(c.data));
    assert.strictEqual(c.data.rolls[0].cutLength, 3000);
    assert.strictEqual(c.data.placements.filter((p) => p.cut).length, 1);
    // 切线到卷尾后再推进：无新增件且超出长度，分别被拒
    const over = await call('POST', `/api/jobs/${jid}/cut`, { cutLine: 3000 });
    assert.strictEqual(over.status, 400);
  })
);

test('裁剪：旧库迁移后 rolls 带 cut_length=0，GET 状态含 cutting 与 placements[].cut 字段', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      name: '字段', fabricWidth: 1000, fabricLength: 1000,
      pieces: [{ name: 'q', vertices: [[0, 0], [100, 0], [100, 100], [0, 100]], quantity: 1 }],
    });
    const s = cr.data;
    assert(Array.isArray(s.cutting.rolls));
    assert.strictEqual(s.cutting.rolls[0].cutLine, 0);
    assert.strictEqual(typeof s.placements[0].cut, 'boolean');
    assert.strictEqual(s.rolls[0].cutLength, 0);
  })
);

runAll().then(() => {
  console.log(`\n${passed} 项测试${process.exitCode ? '，存在失败' : '全部通过'}。`);
});