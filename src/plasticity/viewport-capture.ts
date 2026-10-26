/** Renderer-only capture. A hidden document flag is not proof of a fresh frame. */
export const NATIVE_VIEWPORT_CAPTURE = `function () {
  if (this.executor?.isBusy) throw new Error('Plasticity is busy');
  const viewports = Array.from(this.viewports ?? []);
  if (viewports.length !== 1) throw new Error('Viewport capture requires exactly one native viewport');
  const viewport = viewports[0];
  const renderer = viewport.renderer;
  const canvas = renderer?.domElement;
  if (renderer?.isWebGLRenderer !== true || typeof viewport.setNeedsRender !== 'function' ||
      typeof viewport.handleRender !== 'function' || typeof canvas?.toDataURL !== 'function') {
    throw new Error('Verified native viewport capture is unavailable');
  }
  const context = renderer.getContext();
  if (!context || context.isContextLost()) throw new Error('Native viewport WebGL context is lost');
  const before = renderer.info?.render?.frame;
  const previousTime = viewport.lastFrameNumber;
  if (!Number.isInteger(before) || before < 0 || !Number.isFinite(previousTime)) {
    throw new Error('Native viewport frame counters are unavailable');
  }
  if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) ||
      canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > 32000000) {
    throw new Error('Native viewport dimensions are invalid');
  }
  viewport.setNeedsRender();
  viewport.handleRender(performance.now());
  const after = renderer.info.render.frame;
  if (!Number.isInteger(after) || after <= before ||
      !(viewport.lastFrameNumber > previousTime) || viewport.needsRender !== false || renderer.getContext() !== context || context.isContextLost()) {
    throw new Error('Native viewport did not complete a fresh frame');
  }
  // Native rendering can advance camera controls while RAF is suspended.
  for (const tag of this.__plasticityMcpDistanceOverlays?.values() ?? []) tag.refreshLabels?.();
  // Serialize synchronously after drawing, before a non-preserved buffer is discarded.
  const dataUrl = canvas.toDataURL('image/png');
  if (context.isContextLost()) throw new Error('Native viewport WebGL context was lost during capture');
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Native viewport returned no PNG frame');
  return { data: dataUrl.slice('data:image/png;base64,'.length), width: canvas.width,
    height: canvas.height, rendererHidden: document.hidden, freshFrame: true };
}`;
