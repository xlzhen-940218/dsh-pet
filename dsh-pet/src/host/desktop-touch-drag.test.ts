/**
 * 桌面端触屏拖拽回归：远程桌面用手指划动时，宠物必须跟手。
 *
 * 背景（Android 平板远程桌面连电脑）：远程客户端把手指变成触摸事件，且**不驱动系统指针**——
 * 远程画面里的鼠标指针不动，窗口位置靠光标轮询翻转的兜底通道也判不出「手指在宠物身上」。
 * 触摸派生的 pointer 事件在浏览器里报的是页面坐标而不是屏幕坐标，早期按 e.screenX 算拖拽增量，
 * 于是增量退化成「指针相对窗口的位移」：窗口正跟着手指走，这个位移恒为零，宠物原地不动。
 *
 * 为什么加载真脚本：这条链路跨三个经典 script（sprite.js 的类、sprite/input.js 的指针状态机、
 * sprite/touch-press.js 的长按），任何一处名字或加载顺序变了都表现成「拖不动」，纯函数测不出来。
 * 这里用 node:vm 起一份干净全局，驱动真实脚本，断言的是行为。
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';

import { DRAG_THRESHOLD } from '../shared/constants.ts';
import { pick } from '../shared/pickers.ts';
import { trimTrail } from '../shared/physics/release.ts';

/** 宠物宽度（px）。 */
const PET_SIZE = 320;
/** 本体位置（工作区坐标系）。 */
const PET_POS = { x: 1000, y: 600 };
/** 本体在窗口内的偏移；窗口原点 = 本体位置 − 偏移。 */
const WIN_OFFSET = { x: 100, y: 100 };

const helper = '../../runtime/electron-helper/';
const spriteJs = readFileSync(new URL(helper + 'sprite.js', import.meta.url), 'utf8');
const inputJs = readFileSync(new URL(helper + 'sprite/input.js', import.meta.url), 'utf8');
const touchPressJs = readFileSync(new URL(helper + 'sprite/touch-press.js', import.meta.url), 'utf8');

/** 一次指针事件的形状：桌面端只读这几个字段。 */
interface PointerEventLike {
  button?: number;
  buttons?: number;
  clientX: number;
  clientY: number;
  screenX?: number;
  screenY?: number;
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
}

/** 被测实例：真实脚本的原型 + 记录用的桩状态。 */
interface SpriteUnderTest {
  onPointerDown(e: PointerEventLike): void;
  onPointerMove(e: PointerEventLike): void;
  onPointerUp(e: PointerEventLike): void;
  onMouseMove(e: PointerEventLike): void;
  dragState: {
    active: boolean;
    dragging: boolean;
    pointerType: string;
    sx: number;
    sy: number;
    petX: number;
    petY: number;
  };
  dragTarget: { x: number; y: number } | null;
  pos: { x: number; y: number };
  winOffset: { x: number; y: number };
  pressScoreFired: boolean;
  customPos: { rx: number; ry: number } | null;
  /** 收到的右键事件（长按派发）。 */
  contextMenus: Array<{ button: number; clientX: number; clientY: number }>;
  /** 提示显隐调用序列。 */
  tips: boolean[];
  /** 播放的动画名。 */
  played: string[];
  /** 推进定时器（ms）。 */
  advance(ms: number): void;
}

/**
 * 造一只装在 vm 里的宠物，驱动真实的指针状态机。
 *
 * @returns 宠物实例（原型来自真实脚本，状态与 DOM/IPC 侧为桩）。
 */
function loadSprite(): SpriteUnderTest {
  let timerSeq = 0;
  let now = 1000;
  const timers = new Map<number, () => void>();
  const contextMenus: Array<{ button: number; clientX: number; clientY: number }> = [];
  const tips: boolean[] = [];
  const played: string[] = [];

  const globals: Record<string, unknown> = {
    navigator: { platform: 'Win32', userAgent: 'test' },
    BASE: 'http://127.0.0.1:3080',
    ORIGIN: 'http://127.0.0.1:3080',
    VIEW: { x: 0, y: 0, w: 1920, h: 1080 },
    AREAS: [{ x: 0, y: 0, width: 1920, height: 1080 }],
    PRIMARY_AREA: { x: 0, y: 0, width: 1920, height: 1080 },
    CONFIG: { scale: 1, topInsetRatio: 0 },
    // 纯逻辑只取指针链真正用到的那几个；其余（菜单、播放）不在本文件职责内。
    S: {
      DRAG_THRESHOLD,
      SLINGSHOT_DOUBLE_MS: 200,
      SCORE_MIN_SPEED: 9999,
      pick,
      trimTrail,
      postAction: () => Promise.resolve(true),
      estimateReleaseVelocity: () => null,
      slingshotPower: () => 0,
      slingshotVelocity: () => ({ vx: 0, vy: 0 }),
      pullAngle: () => 0,
    },
    toScreen: (v: number): number => v,
    toLocal: (v: number): number => v,
    performance: { now: (): number => now },
    console: { log: (): void => undefined, warn: (): void => undefined },
    setTimeout: (fn: () => void): number => {
      timerSeq += 1;
      timers.set(timerSeq, fn);
      return timerSeq;
    },
    clearTimeout: (id: number): void => {
      timers.delete(id);
    },
    MouseEvent: class {
      button: number;
      clientX: number;
      clientY: number;
      constructor(_type: string, init: { button?: number; clientX?: number; clientY?: number }) {
        this.button = init.button ?? 0;
        this.clientX = init.clientX ?? 0;
        this.clientY = init.clientY ?? 0;
      }
    },
    window: {
      __dshPetDebug: {},
      petBridge: null,
      clearTimeout: (id: number): void => {
        timers.delete(id);
      },
    },
  };

  const vm = createContext(globals);
  runInContext(spriteJs, vm);
  runInContext(inputJs, vm);
  runInContext(touchPressJs, vm);
  const proto = runInContext('PetSprite.prototype', vm) as object;
  const sprite = Object.create(proto) as SpriteUnderTest;

  const hit = {
    classList: { add: (): void => undefined, remove: (): void => undefined },
    setPointerCapture: (): void => undefined,
    releasePointerCapture: (): void => undefined,
    dispatchEvent: (e: { button: number; clientX: number; clientY: number }): boolean => {
      contextMenus.push({ button: e.button, clientX: e.clientX, clientY: e.clientY });
      return true;
    },
  };

  Object.assign(sprite, {
    size: PET_SIZE,
    halfW: PET_SIZE / 2,
    halfH: (PET_SIZE * 9) / 16 / 2,
    pet: { id: 'main', name: '大肥鱼' },
    animations: { drag: ['drag1'], idle: ['idle1'], clicks: ['click1'] },
    physics: { throwPower: 1 },
    sleeping: false,
    frozen: false,
    lockTimer: null,
    throwState: null,
    pressScoreFired: false,
    lastPressAt: 0,
    dragState: { active: false, dragging: false, pointerType: 'mouse', sx: 0, sy: 0, petX: 0, petY: 0 },
    dragTrail: [],
    dragTarget: null,
    touchPressTimer: null,
    pos: { ...PET_POS },
    winOffset: { ...WIN_OFFSET },
    customPos: null,
    hit,
    hitRect: { x: 0, y: 0, w: 200, h: 200 },
    // 下面这些是 DOM / IPC 侧的桩：只记录，不做布局与窗口操作。
    stopThrow: (): void => undefined,
    stopDragFollow: (): void => undefined,
    stopMove: (): void => undefined,
    startDragFollow: (): void => undefined,
    syncInputBusy: (): void => undefined,
    resumeWorkStatusAnim: (): boolean => true,
    playOnce: (name: string): void => {
      played.push(name);
    },
    setTip: (on: boolean): void => {
      tips.push(on);
    },
    tipOn: (): boolean => false,
    placeTip: (): void => undefined,
    position: (): void => undefined,
    applyFreeze: (): void => undefined,
    contextMenus,
    tips,
    played,
    advance: (ms: number): void => {
      now += ms;
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
  });
  return sprite;
}

/** 造一次指针事件：触摸事件的 screenX/Y 是页面坐标（浏览器对触摸 pointer 事件就是这么报的）。 */
function pointer(
  type: 'mouse' | 'touch',
  clientX: number,
  clientY: number,
  extra: Partial<PointerEventLike> = {},
): PointerEventLike {
  return {
    button: 0,
    buttons: type === 'mouse' ? 1 : 0,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    pointerId: 1,
    pointerType: type,
    isPrimary: true,
    ...extra,
  };
}

/** 窗口原点（工作区坐标系）= 本体位置 − 本体在窗口内的偏移。 */
const windowOrigin = (sprite: SpriteUnderTest): { x: number; y: number } => ({
  x: sprite.pos.x - sprite.winOffset.x,
  y: sprite.pos.y - sprite.winOffset.y,
});

/**
 * 断言拖拽目标落在哪。
 *
 * 逐字段比而不是整体深比：目标对象来自 vm 的 realm，原型与本 realm 不同，深比会因原型不同而误报。
 */
function assertTarget(sprite: SpriteUnderTest, x: number, y: number, message: string): void {
  assert.ok(sprite.dragTarget, '拖拽目标应存在');
  assert.equal(sprite.dragTarget!.x, x, `${message}（x）`);
  assert.equal(sprite.dragTarget!.y, y, `${message}（y）`);
}

test('触摸拖拽：手指划过窗口时宠物跟手（远程桌面不驱动系统指针的场景）', () => {
  const sprite = loadSprite();

  // 按下：手指落在宠物身上。触摸事件的 screenX/Y 是页面坐标，与窗口原点的真实屏幕位置无关。
  sprite.onPointerDown(pointer('touch', 150, 80));
  assert.equal(sprite.dragState.active, true, '触摸按下应进入按下态');
  assert.equal(sprite.dragState.pointerType, 'touch');

  // 手指往右划 60px：窗口还没动，client 坐标同步右移。
  sprite.onPointerMove(pointer('touch', 210, 80));
  assert.equal(sprite.dragState.dragging, true, `越过 ${DRAG_THRESHOLD}px 阈值应进入拖拽态`);
  assertTarget(sprite, PET_POS.x + 60, PET_POS.y, '拖拽目标应跟着手指右移 60px');

  // 弹簧跟上来：宠物挪到目标位，窗口随本体一起挪（client 坐标回到按下的位置）。
  sprite.pos = { x: PET_POS.x + 60, y: PET_POS.y };
  sprite.onPointerMove(pointer('touch', 150, 80));
  assertTarget(sprite, PET_POS.x + 60, PET_POS.y, '窗口跟着本体移动后，目标仍要停在手指处，不能退回按下时的位置');

  // 手指继续右划：窗口已挪走，client 坐标相对新窗口左移。
  sprite.onPointerMove(pointer('touch', 210, 80));
  assertTarget(sprite, PET_POS.x + 120, PET_POS.y, '窗口移动后继续划，位移要按真实手指位移累加');
});

test('鼠标拖拽：结果与按屏幕坐标算的旧算法一致（回归）', () => {
  const sprite = loadSprite();

  // 鼠标事件的 screenX/Y 是真实屏幕位置：按下点在窗口内 (150,80)，屏幕坐标 = 窗口原点 + client。
  const origin = windowOrigin(sprite);
  sprite.onPointerDown(pointer('mouse', 150, 80, { screenX: origin.x + 150, screenY: origin.y + 80 }));
  sprite.onPointerMove(pointer('mouse', 160, 80, { screenX: origin.x + 160, screenY: origin.y + 80 }));
  assertTarget(sprite, PET_POS.x + 10, PET_POS.y, '鼠标位移 10px → 目标右移 10px');
});

test('触摸拖拽途中收到兼容 mousemove（buttons 恒为 0）：拖拽不被当成松手杀掉', () => {
  const sprite = loadSprite();

  sprite.onPointerDown(pointer('touch', 150, 80));
  sprite.onPointerMove(pointer('touch', 210, 80));
  assert.equal(sprite.dragState.dragging, true);

  // 浏览器给触摸补发的兼容 mousemove：buttons 恒为 0。
  sprite.onMouseMove({ clientX: 210, clientY: 80, buttons: 0 });
  assert.equal(sprite.dragState.active, true, '触摸拖拽不能被兼容 mousemove 收尾');
  assert.equal(sprite.dragState.dragging, true, '拖拽态应保持');
});

test('鼠标拖拽途中收到 buttons 为 0 的 mousemove：仍按松手收尾（松手丢失的兜底不能失效）', () => {
  const sprite = loadSprite();

  sprite.onPointerDown(pointer('mouse', 150, 80));
  sprite.onPointerMove(pointer('mouse', 160, 80));
  assert.equal(sprite.dragState.dragging, true);

  sprite.onMouseMove({ clientX: 160, clientY: 80, buttons: 0 });
  assert.equal(sprite.dragState.active, false, '鼠标松手丢失仍要就地收尾');
});

test('触屏长按：到点派发右键事件走菜单，本次按压不再结算拖拽', () => {
  const sprite = loadSprite();

  sprite.onPointerDown(pointer('touch', 150, 80));
  sprite.advance(500);

  assert.equal(sprite.contextMenus.length, 1, '长按到点应派发一次右键事件');
  assert.equal(sprite.contextMenus[0]!.button, 2, '右键事件的按键应为右键');
  assert.equal(sprite.dragState.active, false, '菜单接管后本次按压结束');
  assert.equal(sprite.pressScoreFired, true, '本次按压已被菜单消费，随后的 click 不该再播点击动画');
});

test('触屏长按：手指移动超过容差即取消，不再弹菜单', () => {
  const sprite = loadSprite();

  sprite.onPointerDown(pointer('touch', 150, 80));
  sprite.onPointerMove(pointer('touch', 170, 80));
  sprite.advance(500);

  assert.equal(sprite.contextMenus.length, 0, '移动过容差后不该再弹菜单');
  assert.equal(sprite.dragState.active, true, '按压仍在进行（走的是拖拽，不是菜单）');
});

test('触屏松手：不恢复悬浮提示（没有悬停，系统指针又不动）', () => {
  const sprite = loadSprite();

  sprite.onPointerDown(pointer('touch', 150, 80));
  sprite.onPointerUp(pointer('touch', 150, 80));

  assert.deepEqual(sprite.tips, [false], '触摸松手后只应收起提示，不应再点亮');
});

test('鼠标松手：指针仍在身上时恢复悬浮提示', () => {
  const sprite = loadSprite();

  // 按下点落在命中区内（client (150,150) 换算到本体坐标是 (50,50)）。
  sprite.onPointerDown(pointer('mouse', 150, 150));
  sprite.onPointerUp(pointer('mouse', 150, 150));

  assert.deepEqual(sprite.tips, [false, true], '鼠标松手后提示应复位');
});
