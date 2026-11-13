// --- whiteboard.js ---
/**
 * SMART WEBRTC CLASSROOM - Interactive Whiteboard & Screen Annotation Engine
 * Supports freehand drawing, highlighter, eraser, laser pointer mode with smooth fading,
 * text notes, and real-time DataChannel vector synchronization.
 */

class WhiteboardManager {
  constructor(canvasElement, router) {
    this.canvas = canvasElement;
    this.ctx = canvasElement ? canvasElement.getContext('2d') : null;
    this.router = router;

    this.isDrawing = false;
    this.tool = 'pen'; // 'pen' | 'highlighter' | 'eraser' | 'laser'
    this.color = '#00f0ff';
    this.lineWidth = 3;
    this.prevX = 0;
    this.prevY = 0;

    // Laser pointer particles
    this.laserPoints = []; // [{ x, y, alpha, color, radius }]
    this.isLaserActive = false;
    this.laserAnimationId = null;

    this.init();
  }

  init() {
    if (!this.canvas) return;

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    // Mouse & Touch events
    this.canvas.addEventListener('mousedown', (e) => this.handlePointerDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.handlePointerMove(e));
    window.addEventListener('mouseup', () => this.handlePointerUp());

    // Touch support for tablets & mobile
    this.canvas.addEventListener('touchstart', (e) => this.handleTouch(e, 'down'), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => this.handleTouch(e, 'move'), { passive: false });
    this.canvas.addEventListener('touchend', () => this.handlePointerUp());

    // Hook DataChannel incoming strokes
    if (this.router) {
      this.router.onWhiteboardStroke = (peerId, stroke) => {
        this.renderRemoteStroke(stroke);
      };

      this.router.onWhiteboardClear = () => {
        this.clearCanvas(false);
      };

      this.router.onPointerMove = (peerId, pointerData) => {
        this.renderRemoteLaser(pointerData);
      };
    }

    this.startLaserAnimationLoop();
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const newWidth = Math.round(rect.width);
    const newHeight = Math.round(rect.height);
    if (newWidth > 0 && newHeight > 0) {
      if (this.canvas.width > 0 && this.canvas.height > 0 && (this.canvas.width !== newWidth || this.canvas.height !== newHeight)) {
        // Smoothly scale existing drawings to new monitor / container dimensions
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvas.width;
        tempCanvas.height = this.canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        if (tempCtx) {
          tempCtx.drawImage(this.canvas, 0, 0);
        }
        this.canvas.width = newWidth;
        this.canvas.height = newHeight;
        if (this.ctx && tempCanvas.width > 0 && tempCanvas.height > 0) {
          this.ctx.drawImage(tempCanvas, 0, 0, newWidth, newHeight);
        }
      } else if (this.canvas.width === 0 || this.canvas.height === 0) {
        this.canvas.width = newWidth;
        this.canvas.height = newHeight;
      }
    }
  }

  setTool(tool) {
    this.tool = tool;
    if (tool === 'highlighter') {
      this.lineWidth = 14;
    } else if (tool === 'pen') {
      this.lineWidth = 3;
    } else if (tool === 'eraser') {
      this.lineWidth = 20;
    }
  }

  setColor(color) {
    this.color = color;
  }

  setLineWidth(width) {
    this.lineWidth = width;
  }

  getCanvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      xPercent: (e.clientX - rect.left) / rect.width,
      yPercent: (e.clientY - rect.top) / rect.height
    };
  }

  handlePointerDown(e) {
    const pos = this.getCanvasCoords(e);
    this.isDrawing = true;
    this.prevX = pos.x;
    this.prevY = pos.y;

    if (this.tool === 'laser') {
      this.addLaserPoint(pos.x, pos.y, this.color);
      if (this.router) {
        this.router.broadcastPointer(pos.xPercent, pos.yPercent, true, this.color);
      }
    }
  }

  handlePointerMove(e) {
    const pos = this.getCanvasCoords(e);

    if (this.tool === 'laser') {
      if (this.isDrawing) {
        this.addLaserPoint(pos.x, pos.y, this.color);
      }
      if (this.router) {
        this.router.broadcastPointer(pos.xPercent, pos.yPercent, this.isDrawing, this.color);
      }
      return;
    }

    if (!this.isDrawing) return;

    this.drawStroke(this.prevX, this.prevY, pos.x, pos.y, this.tool, this.color, this.lineWidth);

    // Broadcast stroke vector as normalized percentages for resolution independence
    if (this.router) {
      const rect = this.canvas.getBoundingClientRect();
      this.router.broadcastWhiteboardStroke({
        x0: this.prevX / rect.width,
        y0: this.prevY / rect.height,
        x1: pos.xPercent,
        y1: pos.yPercent,
        tool: this.tool,
        color: this.color,
        lineWidth: this.lineWidth
      });
    }

    this.prevX = pos.x;
    this.prevY = pos.y;
  }

  handlePointerUp() {
    this.isDrawing = false;
  }

  handleTouch(e, type) {
    if (e.touches.length > 0) {
      e.preventDefault();
      const touch = e.touches[0];
      const mouseEvent = new MouseEvent(type === 'down' ? 'mousedown' : 'mousemove', {
        clientX: touch.clientX,
        clientY: touch.clientY
      });
      if (type === 'down') this.handlePointerDown(mouseEvent);
      else if (type === 'move') this.handlePointerMove(mouseEvent);
    }
  }

  drawStroke(x0, y0, x1, y1, tool, color, width) {
    if (!this.ctx) return;

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.moveTo(x0, y0);
    this.ctx.lineTo(x1, y1);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    if (tool === 'eraser') {
      this.ctx.globalCompositeOperation = 'destination-out';
      this.ctx.lineWidth = width;
      this.ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else if (tool === 'highlighter') {
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.globalAlpha = 0.35;
      this.ctx.lineWidth = width;
      this.ctx.strokeStyle = color;
    } else {
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.globalAlpha = 1.0;
      this.ctx.lineWidth = width;
      this.ctx.strokeStyle = color;
    }

    this.ctx.stroke();
    this.ctx.restore();
  }

  renderRemoteStroke(stroke) {
    if (!this.canvas || !this.ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.drawStroke(
      stroke.x0 * w,
      stroke.y0 * h,
      stroke.x1 * w,
      stroke.y1 * h,
      stroke.tool,
      stroke.color,
      stroke.lineWidth
    );
  }

  renderRemoteLaser(pointerData) {
    if (!this.canvas) return;
    const x = pointerData.x * this.canvas.width;
    const y = pointerData.y * this.canvas.height;
    this.addLaserPoint(x, y, pointerData.color || '#00ff9d');
  }

  addLaserPoint(x, y, color) {
    this.laserPoints.push({
      x: x,
      y: y,
      alpha: 1.0,
      color: color,
      radius: 6
    });
  }

  startLaserAnimationLoop() {
    const loop = () => {
      if (this.laserPoints.length > 0 && this.ctx) {
        // Redraw laser points on overlay
        for (let i = 0; i < this.laserPoints.length; i++) {
          const pt = this.laserPoints[i];
          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.arc(pt.x, pt.y, pt.radius, 0, Math.PI * 2);
          this.ctx.fillStyle = pt.color;
          this.ctx.shadowColor = pt.color;
          this.ctx.shadowBlur = 12;
          this.ctx.globalAlpha = pt.alpha;
          this.ctx.fill();
          this.ctx.restore();

          pt.alpha -= 0.05;
          pt.radius += 0.2;
        }

        // Filter faded points
        this.laserPoints = this.laserPoints.filter((pt) => pt.alpha > 0.05);
      }
      this.laserAnimationId = requestAnimationFrame(loop);
    };
    this.laserAnimationId = requestAnimationFrame(loop);
  }

  clearCanvas(broadcast = true) {
    if (!this.canvas || !this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.laserPoints = [];
    if (broadcast && this.router) {
      this.router.broadcastWhiteboardClear();
    }
  }

  destroy() {
    if (this.laserAnimationId) {
      cancelAnimationFrame(this.laserAnimationId);
    }
  }
}

// Global exposure
window.WhiteboardManager = WhiteboardManager;