// 截图覆盖窗：整屏截图打底，拖动框选，确认后把选区（物理像素坐标）回传主进程裁剪
'use strict';
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const sizeLabel = document.getElementById('size');
const shot = new Image();
let scale = 1; // 屏幕物理像素 / CSS 像素
let sel = null; // {x,y,w,h}
let dragging = false;
let startX = 0, startY = 0;

window.__init = (dataUrl) => {
  shot.onload = () => {
    cv.width = shot.naturalWidth;
    cv.height = shot.naturalHeight;
    cv.style.width = '100vw';
    cv.style.height = '100vh';
    scale = shot.naturalWidth / window.innerWidth;
    draw();
  };
  shot.src = dataUrl;
};

function draw() {
  ctx.drawImage(shot, 0, 0);
  // 全屏压暗
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (sel && sel.w > 0 && sel.h > 0) {
    // 选区内恢复原始亮度（重画原图）
    ctx.drawImage(shot, sel.x, sel.y, sel.w, sel.h, sel.x, sel.y, sel.w, sel.h);
    // 边框
    ctx.strokeStyle = '#4E7EE2';
    ctx.lineWidth = 2;
    ctx.strokeRect(sel.x + 1, sel.y + 1, sel.w - 2, sel.h - 2);
  }
}

function toPhys(e) {
  return { x: Math.round(e.clientX * scale), y: Math.round(e.clientY * scale) };
}

window.addEventListener('mousedown', (e) => {
  const p = toPhys(e);
  dragging = true;
  startX = p.x; startY = p.y;
  sel = { x: p.x, y: p.y, w: 0, h: 0 };
  draw();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const p = toPhys(e);
  sel = {
    x: Math.min(startX, p.x), y: Math.min(startY, p.y),
    w: Math.abs(p.x - startX), h: Math.abs(p.y - startY),
  };
  draw();
  sizeLabel.style.display = 'block';
  sizeLabel.style.left = (e.clientX + 14) + 'px';
  sizeLabel.style.top = (e.clientY + 14) + 'px';
  sizeLabel.textContent = sel.w + ' × ' + sel.h;
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  if (sel && (sel.w < 8 || sel.h < 8)) sel = null; // 误触
  draw();
});
window.addEventListener('dblclick', () => {
  // 双击：全屏
  window.capture.done({ x: 0, y: 0, w: cv.width, h: cv.height });
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && sel && sel.w > 4 && sel.h > 4) window.capture.done(sel);
  if (e.key === 'Escape') window.capture.cancel();
});
