import { createMemo, createSignal, onCleanup, onMount } from "solid-js";

const CANVAS_DEFAULT_PAN_X = 0;
const CANVAS_DEFAULT_PAN_Y = 0;
const CANVAS_DEFAULT_ZOOM = 0.94;
const CANVAS_GRID_UNIT = 24;
const CANVAS_MIN_ZOOM = 0.35;
const CANVAS_MAX_ZOOM = 2.6;
const CANVAS_RESET_DURATION_MS = 320;
const BOARD_ORIGIN_X = 66;
const BOARD_ORIGIN_Y = 100;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function useBoardCanvas() {
  const [canvasView, setCanvasView] = createSignal({
    panX: CANVAS_DEFAULT_PAN_X,
    panY: CANVAS_DEFAULT_PAN_Y,
    zoom: CANVAS_DEFAULT_ZOOM,
  });
  const [isCanvasPanning, setIsCanvasPanning] = createSignal(false);

  let canvasViewportRef: HTMLDivElement | undefined;
  let canvasGridRef: HTMLCanvasElement | undefined;
  let canvasResizeObserver: ResizeObserver | null = null;
  let activeCanvasPointerId: number | null = null;
  let resetAnimationFrameId: number | null = null;
  let lastPointerX = 0;
  let lastPointerY = 0;

  const setCanvasViewportRef = (element: HTMLDivElement) => {
    canvasViewportRef = element;
  };

  const setCanvasGridRef = (element: HTMLCanvasElement) => {
    canvasGridRef = element;
  };

  const stopCanvasResetAnimation = () => {
    if (resetAnimationFrameId !== null) {
      window.cancelAnimationFrame(resetAnimationFrameId);
      resetAnimationFrameId = null;
    }
  };

  const boardCameraStyle = createMemo(() => {
    const view = canvasView();
    return {
      transform: `translate3d(${BOARD_ORIGIN_X + view.panX}px, ${BOARD_ORIGIN_Y + view.panY}px, 0) scale(${view.zoom})`,
    };
  });

  const shouldPanCanvasFromTarget = (target: EventTarget | null, pointerButton: number) => {
    if (pointerButton === 1) {
      return true;
    }

    if (!(target instanceof Element)) {
      return true;
    }

    return !target.closest("a,button,input,textarea,select,label,[draggable='true'],.kanban-card");
  };

  const getCanvasTokenColor = (tokenName: string, fallbackTokenName: string) => {
    if (!canvasViewportRef) {
      return "";
    }

    const styles = window.getComputedStyle(canvasViewportRef);
    const value = styles.getPropertyValue(tokenName).trim();
    if (value.length > 0) {
      return value;
    }

    return styles.getPropertyValue(fallbackTokenName).trim();
  };

  const drawGridLines = (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    spacing: number,
    originX: number,
    originY: number,
  ) => {
    if (spacing <= 0) {
      return;
    }

    const normalizedX = ((originX % spacing) + spacing) % spacing;
    const normalizedY = ((originY % spacing) + spacing) % spacing;

    context.beginPath();

    for (let x = normalizedX; x <= width; x += spacing) {
      const alignedX = Math.round(x) + 0.5;
      context.moveTo(alignedX, 0);
      context.lineTo(alignedX, height);
    }

    for (let y = normalizedY; y <= height; y += spacing) {
      const alignedY = Math.round(y) + 0.5;
      context.moveTo(0, alignedY);
      context.lineTo(width, alignedY);
    }

    context.stroke();
  };

  const drawCanvas = () => {
    if (!canvasGridRef || !canvasViewportRef) {
      return;
    }

    const context = canvasGridRef.getContext("2d");
    if (!context) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvasGridRef.width / dpr;
    const height = canvasGridRef.height / dpr;

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvasGridRef.width, canvasGridRef.height);
    context.restore();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const view = canvasView();
    const spacing = CANVAS_GRID_UNIT * view.zoom;
    if (spacing < 8) {
      return;
    }

    context.strokeStyle = getCanvasTokenColor("--content-canvas-grid-line", "--app-grid-line");
    context.lineWidth = 1;
    drawGridLines(context, width, height, spacing, BOARD_ORIGIN_X + view.panX, BOARD_ORIGIN_Y + view.panY);
  };

  const resizeCanvas = () => {
    if (!canvasGridRef || !canvasViewportRef) {
      return;
    }

    const rect = canvasViewportRef.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvasGridRef.width = Math.max(1, Math.floor(rect.width * dpr));
    canvasGridRef.height = Math.max(1, Math.floor(rect.height * dpr));
    drawCanvas();
  };

  const resetCanvasView = () => {
    stopCanvasResetAnimation();

    const startView = canvasView();
    const startedAt = performance.now();

    const animateFrame = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / CANVAS_RESET_DURATION_MS);
      const easedProgress = 1 - (1 - progress) ** 3;

      setCanvasView({
        panX: startView.panX + (CANVAS_DEFAULT_PAN_X - startView.panX) * easedProgress,
        panY: startView.panY + (CANVAS_DEFAULT_PAN_Y - startView.panY) * easedProgress,
        zoom: startView.zoom + (CANVAS_DEFAULT_ZOOM - startView.zoom) * easedProgress,
      });

      if (progress < 1) {
        resetAnimationFrameId = window.requestAnimationFrame(animateFrame);
        return;
      }

      resetAnimationFrameId = null;
      setCanvasView({
        panX: CANVAS_DEFAULT_PAN_X,
        panY: CANVAS_DEFAULT_PAN_Y,
        zoom: CANVAS_DEFAULT_ZOOM,
      });
    };

    resetAnimationFrameId = window.requestAnimationFrame(animateFrame);
  };

  const beginCanvasPan = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) {
      return;
    }

    if (!canvasViewportRef) {
      return;
    }

    if (!shouldPanCanvasFromTarget(event.target, event.button)) {
      return;
    }

    stopCanvasResetAnimation();
    activeCanvasPointerId = event.pointerId;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    setIsCanvasPanning(true);
    canvasViewportRef.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveCanvasPan = (event: PointerEvent) => {
    if (activeCanvasPointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - lastPointerX;
    const deltaY = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;

    if (deltaX === 0 && deltaY === 0) {
      return;
    }

    setCanvasView((current) => ({
      ...current,
      panX: current.panX + deltaX,
      panY: current.panY + deltaY,
    }));
    event.preventDefault();
  };

  const endCanvasPan = (event: PointerEvent) => {
    if (activeCanvasPointerId !== event.pointerId) {
      return;
    }

    if (canvasViewportRef && canvasViewportRef.hasPointerCapture(event.pointerId)) {
      canvasViewportRef.releasePointerCapture(event.pointerId);
    }

    activeCanvasPointerId = null;
    setIsCanvasPanning(false);
  };

  const zoomCanvas = (event: WheelEvent) => {
    if (!canvasViewportRef) {
      return;
    }

    stopCanvasResetAnimation();

    const rect = canvasViewportRef.getBoundingClientRect();
    const pointX = event.clientX - rect.left;
    const pointY = event.clientY - rect.top;
    const current = canvasView();
    const zoomFactor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clamp(current.zoom * zoomFactor, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM);

    if (Math.abs(nextZoom - current.zoom) < 0.0001) {
      event.preventDefault();
      return;
    }

    const worldX = (pointX - BOARD_ORIGIN_X - current.panX) / current.zoom;
    const worldY = (pointY - BOARD_ORIGIN_Y - current.panY) / current.zoom;

    setCanvasView({
      panX: pointX - BOARD_ORIGIN_X - worldX * nextZoom,
      panY: pointY - BOARD_ORIGIN_Y - worldY * nextZoom,
      zoom: nextZoom,
    });

    event.preventDefault();
  };

  const handleCanvasDoubleClick = (event: MouseEvent) => {
    if (!shouldPanCanvasFromTarget(event.target, 0)) {
      return;
    }

    resetCanvasView();
  };

  onMount(() => {
    resizeCanvas();
    canvasResizeObserver = new ResizeObserver(() => {
      resizeCanvas();
    });
    if (canvasViewportRef) {
      canvasResizeObserver.observe(canvasViewportRef);
    }
  });

  onCleanup(() => {
    stopCanvasResetAnimation();
    if (canvasResizeObserver) {
      canvasResizeObserver.disconnect();
      canvasResizeObserver = null;
    }
  });

  return {
    boardCameraStyle,
    isCanvasPanning,
    setCanvasViewportRef,
    setCanvasGridRef,
    resetCanvasView,
    beginCanvasPan,
    moveCanvasPan,
    endCanvasPan,
    zoomCanvas,
    handleCanvasDoubleClick,
  };
}
