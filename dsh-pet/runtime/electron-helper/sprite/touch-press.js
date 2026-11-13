/**
 * 触屏长按：按住到一定时长把这次按压当右键，计时期间手指移动超过容差就取消。
 *
 * 触屏没有右键键，右键菜单就没有入口；到点后派发一次 contextmenu，与鼠标右键走同一条路。
 * 不负责菜单本身，也不碰拖拽与点击判定——到点只收尾按压，派发交给调用方。
 * 鼠标与笔不起表：它们自带右键与悬停。
 * 不变量：同一时刻只有一个计时器；到点时按压若已结束，回调自弃。
 * @module dsh-pet/runtime/electron-helper/sprite-touch-press
 */
'use strict';

/** 触屏长按多久算右键（ms）。 */
const TOUCH_LONG_PRESS_MS = 500;
/** 计时期间手指移动超过这个距离就取消（px）。 */
const TOUCH_LONG_PRESS_SLOP_PX = 8;

Object.assign(PetSprite.prototype, {
  /**
   * 起表：触屏按住到点按右键处理。鼠标与笔不起表。
   *
   * @param e - 按下事件；只用它的 pointerType 与坐标。
   */
  armTouchPress(e) {
    this.cancelTouchPress();
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') return;
    this.touchPressTimer = setTimeout(() => {
      this.touchPressTimer = null;
      this.openTouchMenu(e);
    }, TOUCH_LONG_PRESS_MS);
  },

  /** 撤销计时：松手、取消、或手指移动超过容差时调用。 */
  cancelTouchPress() {
    if (this.touchPressTimer === null) return;
    clearTimeout(this.touchPressTimer);
    this.touchPressTimer = null;
  },

  /**
   * 手指移动的累计距离（px）：超过容差即取消长按。
   *
   * @param distancePx - 手指自按下点起移动的距离。
   */
  touchPressMove(distancePx) {
    if (this.touchPressTimer === null) return;
    if (distancePx > TOUCH_LONG_PRESS_SLOP_PX) this.cancelTouchPress();
  },

  /**
   * 长按到点：结束这次按压，再派发右键事件走现成的自绘菜单。
   *
   * 菜单入口会拒掉「按压仍活跃」的请求，所以必须先把按压状态清掉；本次按压已被菜单消费，
   * 随后的 click 只收手停住，不再播普通点击动画。
   *
   * @param e - 按下事件；派发右键事件时取它的坐标。
   */
  openTouchMenu(e) {
    const d = this.dragState;
    if (!d.active) return;
    d.active = false;
    d.dragging = false;
    this.hit.classList.remove('dragging');
    this.stopDragFollow();
    this.syncInputBusy();
    this.pressScoreFired = true;
    try {
      this.hit.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略捕获失败 */
    }
    this.hit.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: e.clientX,
        clientY: e.clientY,
      }),
    );
  },
});
